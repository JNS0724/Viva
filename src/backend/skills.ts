import { t } from '../shared/i18n/translate.ts'
import fs from 'node:fs'
import path from 'node:path'
import { checkSkill, type SkillIssue } from './skill-spec.ts'

/**
 * Skills dsh discovers on disk (dsh-skill-filesystem): `<root>/<name>/SKILL.md` or `<root>/<name>.md`,
 * with `name` and `description` in YAML frontmatter. dsh watches these folders, so a skill copied in
 * reaches the agent without a restart. The app only lists them, imports into the user root and removes
 * what it imported there.
 */
const SKILL_FILE = 'SKILL.md'
const MAX_DESCRIPTION_CHARS = 300
const SKIPPED_DIRS = new Set(['.system'])

/**
 * The project root dsh takes for a working folder (dsh-skill-filesystem findProjectRoot): the nearest folder, the
 * working folder or one above it, holding `.git`; with none, the working folder itself.
 */
export function projectRoot(cwd: string, exists: (file: string) => boolean = fs.existsSync): string {
  const start = path.resolve(cwd)
  for (let dir = start; ; dir = path.dirname(dir)) {
    if (exists(path.join(dir, '.git'))) return dir
    if (path.dirname(dir) === dir) return start
  }
}

/**
 * The folders dsh scans that hold skills, the app's own first. The home ones are the app's own dsh home
 * (dsh-runtime.js), not the user's ~/.dsh or ~/.agents; the project ones are under the working folder's project
 * root (projectRoot). `rank` is dsh's: of two skills with one name, the lower rank's is the one loaded.
 */
export function skillRoots({ dshHome, cwd }: { dshHome: string, cwd: string }) {
  const project = projectRoot(cwd)
  return [
    { id: 'user', dir: path.join(dshHome, 'skills'), label: t("main.skills.local.viva.skills.folder"), managed: true, rank: 400 },
    { id: 'workspace', dir: path.join(project, '.dsh', 'skills'), label: t("main.skills.workspace.dsh.skills"), managed: false, rank: 100 },
    { id: 'workspace-agents', dir: path.join(project, '.agents', 'skills'), label: t("main.skills.workspace.agents.skills"), managed: false, rank: 200 },
  ]
}

type SkillRoot = ReturnType<typeof skillRoots>[number]

/** Why dsh would skip it, as the user reads it; the first reason only. */
const ISSUE_TEXT: Record<SkillIssue, () => string> = {
  frontmatter: () => t("main.skills.missing.frontmatter"),
  fields: () => t("main.skills.missing.name.or.description"),
  'name-format': () => t("main.skills.name.not.kebab"),
  invocation: () => t("main.skills.invocation.not.boolean"),
}

function readSkill(root: SkillRoot, entry: fs.Dirent) {
  const entryPath = path.join(root.dir, entry.name)
  const isFlat = entry.isFile() && entry.name.toLowerCase().endsWith('.md')
  if (!isFlat && !(entry.isDirectory() || entry.isSymbolicLink())) return null
  let text
  try {
    text = fs.readFileSync(isFlat ? entryPath : path.join(entryPath, SKILL_FILE), 'utf8')
  } catch {
    return null
  }
  const checked = checkSkill(text)
  return {
    id: `${root.id}:${entry.name}`,
    name: checked.name || entry.name.replace(/\.md$/i, ''),
    description: checked.description.slice(0, MAX_DESCRIPTION_CHARS),
    root: root.id,
    rootLabel: root.label,
    managed: root.managed,
    path: entryPath,
    issues: checked.issues,
    problem: checked.issues.length ? ISSUE_TEXT[checked.issues[0]]() : '',
    /** The root whose skill of the same name dsh loads instead; null when this one is loaded (or none is). */
    shadowedBy: null as string | null,
  }
}

type Skill = NonNullable<ReturnType<typeof readSkill>>

/** Of skills dsh loads with one name, the lower rank's wins; the others say whose is loaded instead. */
function withShadows(skills: readonly Skill[], roots: readonly SkillRoot[]): Skill[] {
  const rankOf = new Map(roots.map((root) => [root.id, root.rank]))
  const labelOf = new Map(roots.map((root) => [root.id, root.label]))
  const winners = new Map<string, Skill>()
  for (const skill of skills.filter((one) => !one.issues.length)) {
    const held = winners.get(skill.name)
    if (!held || (rankOf.get(skill.root) ?? 0) < (rankOf.get(held.root) ?? 0)) winners.set(skill.name, skill)
  }
  return skills.map((skill) => {
    const winner = winners.get(skill.name)
    return !skill.issues.length && winner && winner !== skill ? { ...skill, shadowedBy: labelOf.get(winner.root) ?? winner.root } : skill
  })
}

/** Every skill in the roots; a skill dsh would reject is listed with the reason, one another hides with whose. */
export function listSkills(roots: readonly SkillRoot[]) {
  return withShadows(readRoots(roots), roots)
}

function readRoots(roots: readonly SkillRoot[]): Skill[] {
  return roots.flatMap((root) => {
    let entries
    try {
      entries = fs.readdirSync(root.dir, { withFileTypes: true })
    } catch {
      return []
    }
    return entries
      .filter((entry) => !entry.name.startsWith('.') && !SKIPPED_DIRS.has(entry.name))
      .map((entry) => readSkill(root, entry))
      .filter((skill) => skill !== null)
      .sort((a, b) => a.name.localeCompare(b.name))
  })
}

/**
 * Copies a skill folder (with SKILL.md) or a single .md skill into `targetDir`.
 * @returns the skill's name
 */
export function importSkill(source: string, targetDir: string): string {
  const isFolder = fs.statSync(source).isDirectory()
  if (!isFolder && !source.toLowerCase().endsWith('.md')) throw new Error(t("main.skills.choose.a.folder.containing.skill.md.or"))
  const skillFile = isFolder ? path.join(source, SKILL_FILE) : source
  if (!fs.existsSync(skillFile)) throw new Error(t("main.skills.this.folder.has.no.skill.md"))
  const checked = checkSkill(fs.readFileSync(skillFile, 'utf8'))
  if (checked.issues.length) throw new Error(checked.issues[0] === 'frontmatter' || checked.issues[0] === 'fields'
    ? t("main.skills.skill.md.must.start.with.name.and") : ISSUE_TEXT[checked.issues[0]]())
  const target = path.join(targetDir, path.basename(source))
  if (path.resolve(target) === path.resolve(source)) throw new Error(t("main.skills.this.skill.is.already.in.the.skills"))
  if (fs.existsSync(target)) throw new Error(t("main.skills.the.skills.folder.already.contains", { value1: path.basename(source) }))
  fs.mkdirSync(targetDir, { recursive: true })
  fs.cpSync(source, target, { recursive: true, errorOnExist: true, force: false })
  return checked.name
}

/** One line without double quotes, safe inside a quoted frontmatter value. */
const frontmatterValue = (text: unknown) => String(text).replace(/\s+/g, ' ').replace(/"/g, '”').trim()

/**
 * Writes a new skill, made in the conversation, into `targetDir`: a folder named after it holding SKILL.md.
 * `name` follows dsh's rule (lower case, digits, hyphens), checked by the caller.
 * @returns the skill's name
 */
export function createSkill({ name, description, instructions }: { name: string, description: string, instructions: string }, targetDir: string): string {
  const target = path.join(targetDir, name)
  if (fs.existsSync(target)) throw new Error(t("main.skills.a.skill.named.already.exists", { name: name }))
  fs.mkdirSync(target, { recursive: true })
  const text = `---\nname: "${frontmatterValue(name)}"\ndescription: "${frontmatterValue(description)}"\n---\n\n${String(instructions).trim()}\n`
  fs.writeFileSync(path.join(target, SKILL_FILE), text)
  return name
}

/**
 * Moves one of the user-root skills to the trash (via `trash`, Electron's shell.trashItem), so a
 * mistaken removal can be undone from the system trash.
 */
export async function removeSkill(id: string, roots: readonly SkillRoot[], trash: (file: string) => Promise<void>) {
  const skill = listSkills(roots).find((item) => item.id === id)
  if (!skill) throw new Error(t("main.skills.skill.not.found.it.may.have.been"))
  if (!skill.managed) throw new Error(t("main.skills.this.skill.is.outside.the.app.managed"))
  await trash(skill.path)
  return skill.name
}

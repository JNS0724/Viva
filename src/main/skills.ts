import { t } from '../shared/i18n/translate.ts'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Skills dsh discovers on disk (dsh-skill-filesystem): `<root>/<name>/SKILL.md` or `<root>/<name>.md`,
 * with `name` and `description` in YAML frontmatter. dsh watches these folders, so a skill copied in
 * reaches the agent without a restart. The app only lists them, imports into the user root and removes
 * what it imported there.
 */
const SKILL_FILE = 'SKILL.md'
const MAX_FRONTMATTER_CHARS = 8000
const MAX_DESCRIPTION_CHARS = 300
const SKIPPED_DIRS = new Set(['.system'])

/**
 * The folders dsh scans that hold skills, in its priority order. The home ones are the app's own dsh home
 * (dsh-runtime.js), not the user's ~/.dsh or ~/.agents; the project root is the workspace (dsh uses the
 * nearest folder with `.git`; the default workspace has none).
 */
export function skillRoots({ dshHome, cwd }: { dshHome: string, cwd: string }) {
  return [
    { id: 'user', dir: path.join(dshHome, 'skills'), label: t("main.skills.local.viva.skills.folder"), managed: true },
    { id: 'workspace', dir: path.join(cwd, '.dsh', 'skills'), label: t("main.skills.workspace.dsh.skills"), managed: false },
    { id: 'workspace-agents', dir: path.join(cwd, '.agents', 'skills'), label: t("main.skills.workspace.agents.skills"), managed: false },
  ]
}

type SkillRoot = ReturnType<typeof skillRoots>[number]

const unquote = (value: string) => value.replace(/^(['"])(.*)\1$/, '$2')

/** A `>` or `|` block: the indented lines after `index`. */
function blockValue(rows: readonly string[], index: number, style: string) {
  const block: string[] = []
  for (const next of rows.slice(index + 1)) {
    if (next.trim() && !/^\s/.test(next)) break
    block.push(next.trim())
  }
  return block.join(style.startsWith('|') ? '\n' : ' ').trim()
}

/**
 * Reads `name` and `description` from the frontmatter. Handles plain, quoted and folded (`>`/`|`)
 * values, which is all skills use; anything fancier is left to dsh's own YAML parser.
 * @returns null when there is no frontmatter
 */
export function parseFrontmatter(text: string): { name: string, description: string } | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text.slice(0, MAX_FRONTMATTER_CHARS))
  if (!match) return null
  const rows = match[1].split(/\r?\n/)
  const fields = Object.fromEntries(rows.flatMap((row, index) => {
    const field = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(row)
    if (!field) return []
    const value = field[2].trim()
    return [[field[1], /^[>|][+-]?$/.test(value) ? blockValue(rows, index, value) : unquote(value)]]
  }))
  return { name: String(fields.name ?? ''), description: String(fields.description ?? '') }
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
  const meta = parseFrontmatter(text)
  const problem = !meta ? t("main.skills.missing.frontmatter") : !meta.name || !meta.description ? t("main.skills.missing.name.or.description") : ''
  return {
    id: `${root.id}:${entry.name}`,
    name: meta?.name || entry.name.replace(/\.md$/i, ''),
    description: (meta?.description ?? '').slice(0, MAX_DESCRIPTION_CHARS),
    root: root.id,
    rootLabel: root.label,
    managed: root.managed,
    path: entryPath,
    problem,
  }
}

/** Every skill in the roots; a skill dsh would reject is listed with the reason. */
export function listSkills(roots: readonly SkillRoot[]) {
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
  const meta = parseFrontmatter(fs.readFileSync(skillFile, 'utf8'))
  if (!meta?.name || !meta.description) throw new Error(t("main.skills.skill.md.must.start.with.name.and"))
  const target = path.join(targetDir, path.basename(source))
  if (path.resolve(target) === path.resolve(source)) throw new Error(t("main.skills.this.skill.is.already.in.the.skills"))
  if (fs.existsSync(target)) throw new Error(t("main.skills.the.skills.folder.already.contains", { value1: path.basename(source) }))
  fs.mkdirSync(targetDir, { recursive: true })
  fs.cpSync(source, target, { recursive: true, errorOnExist: true, force: false })
  return meta.name
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

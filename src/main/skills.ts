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
    { id: 'user', dir: path.join(dshHome, 'skills'), label: '本机 · Viva 的 skill 文件夹', managed: true },
    { id: 'workspace', dir: path.join(cwd, '.dsh', 'skills'), label: '工作区 · .dsh/skills', managed: false },
    { id: 'workspace-agents', dir: path.join(cwd, '.agents', 'skills'), label: '工作区 · .agents/skills', managed: false },
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
  const problem = !meta ? '缺少 frontmatter' : !meta.name || !meta.description ? '缺少 name 或 description' : ''
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
  if (!isFolder && !source.toLowerCase().endsWith('.md')) throw new Error('请选择包含 SKILL.md 的文件夹，或一个 .md 文件')
  const skillFile = isFolder ? path.join(source, SKILL_FILE) : source
  if (!fs.existsSync(skillFile)) throw new Error('这个文件夹里没有 SKILL.md')
  const meta = parseFrontmatter(fs.readFileSync(skillFile, 'utf8'))
  if (!meta?.name || !meta.description) throw new Error('SKILL.md 开头需要有 name 和 description（YAML frontmatter）')
  const target = path.join(targetDir, path.basename(source))
  if (path.resolve(target) === path.resolve(source)) throw new Error('这个 skill 已经在 skill 目录里了')
  if (fs.existsSync(target)) throw new Error(`skill 目录里已经有「${path.basename(source)}」了`)
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
  if (fs.existsSync(target)) throw new Error(`已经有名为「${name}」的 skill 了`)
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
  if (!skill) throw new Error('找不到这个 skill，可能已被删除')
  if (!skill.managed) throw new Error('这个 skill 不在本应用管理的目录里，请到它所在的文件夹删除')
  await trash(skill.path)
  return skill.name
}

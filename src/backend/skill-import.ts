import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import { t } from '../shared/i18n/translate.ts'
import { checkSkill, SKILL_NAME, splitFrontmatter, type SkillIssue } from './skill-spec.ts'

/**
 * Skills brought in from folders the user already has (another agent's, their own dsh's, one they pick): each found
 * is checked by dsh's rules (skill-spec.ts) before anything is written. One whose name is not in kebab case, or is
 * taken, is offered under a name that works, changed in the copy only; one dsh could not load whatever its name is
 * left where it is, with why. The originals are only read.
 */
const SKILL_FILE = 'SKILL.md'
const SKIPPED = new Set(['.system'])
/** Where other agents keep their skills, by home; the user's own dsh is added by its home. */
const AGENT_FOLDERS = [
  { id: 'claude-code', label: 'Claude Code', dir: ['.claude', 'skills'] },
  { id: 'codex', label: 'Codex', dir: ['.codex', 'skills'] },
  { id: 'agents', label: '~/.agents', dir: ['.agents', 'skills'] },
] as const

/** A folder the user may have skills in, and how many it holds. */
export interface SkillSource { id: string, label: string, dir: string, count: number }

/** ready: copied as it is; fixable: copied under `name` (`fix` says why); blocked: dsh could not load it (`issues`). */
export type CandidateStatus = 'ready' | 'fixable' | 'blocked'

export interface Candidate {
  /** Its file or folder name in the folder scanned; names it among the candidates. */
  entry: string
  /** Where it is; never sent to the window. */
  source: string
  /** The name it is copied under. */
  name: string
  description: string
  status: CandidateStatus
  issues: readonly SkillIssue[]
  /** Why `name` differs from the one written: not in kebab case, or taken. */
  fix: 'name-format' | 'taken' | null
  /** Ticked to begin with: those that go in as they are or with their name put right; not one renamed for a clash. */
  picked: boolean
}

/** Lower case, letters and digits, the rest one hyphen; empty when nothing of the name is a letter or digit. */
export const kebabName = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

/** The skill entries of a folder: folders holding SKILL.md, and single .md files. */
function entriesOf(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith('.') && !SKIPPED.has(entry.name))
      .filter((entry) => (entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
        || ((entry.isDirectory() || entry.isSymbolicLink()) && fs.existsSync(path.join(dir, entry.name, SKILL_FILE))))
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

/** The folders other agents and the user's own dsh keep skills in, those holding any. */
export function skillSources({ home, dshHome }: { home: string, dshHome: string }): SkillSource[] {
  const folders = [
    ...AGENT_FOLDERS.map((folder) => ({ id: folder.id, label: folder.label, dir: path.join(home, ...folder.dir) })),
    { id: 'dsh', label: t('main.skill-import.own.dsh'), dir: path.join(dshHome, 'skills') },
  ]
  return folders.map((folder) => ({ ...folder, count: entriesOf(folder.dir).length })).filter((folder) => folder.count > 0)
}

const skillFileOf = (source: string) => (fs.statSync(source).isDirectory() ? path.join(source, SKILL_FILE) : source)

/** What a skill in the folder is, by dsh's rules, before its name is settled. */
function readCandidate(source: string, entry: string) {
  const checked = checkSkill(fs.readFileSync(skillFileOf(source), 'utf8'))
  const blocked = checked.issues.some((issue) => issue !== 'name-format')
  const fixedName = checked.issues.includes('name-format') ? kebabName(checked.name) : checked.name
  return { entry, source, written: checked.name, description: checked.description, issues: checked.issues, fixedName, blocked: blocked || !SKILL_NAME.test(fixedName) }
}

/** `name`, or the first of name-2, name-3… not in `taken`. */
function freeName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name
  for (let n = 2; ; n += 1) if (!taken.has(`${name}-${n}`)) return `${name}-${n}`
}

/**
 * The skills in `dir` (a folder of them, or one skill's own folder), each checked and named: `taken` is the names
 * already in Viva's skills folder. Those whose folder bears their name settle first, so a copy elsewhere is the
 * one renamed.
 */
export function scanSkills(dir: string, taken: ReadonlySet<string>): Candidate[] {
  const single = fs.existsSync(path.join(dir, SKILL_FILE))
  const read = single ? [readCandidate(dir, path.basename(dir))] : entriesOf(dir).map((entry) => readCandidate(path.join(dir, entry), entry))
  const own = (item: (typeof read)[number]) => item.entry.replace(/\.md$/i, '') === item.fixedName
  const order = [...read.filter(own), ...read.filter((item) => !own(item))]
  let claimed = new Set([...taken].map((name) => name.toLowerCase()))
  const named = order.map((item): Candidate => {
    const base = { entry: item.entry, source: item.source, description: item.description, issues: item.issues }
    if (item.blocked) return { ...base, name: item.written, status: 'blocked', fix: null, picked: false }
    const name = freeName(item.fixedName, claimed)
    claimed = new Set([...claimed, name])
    const fix = name !== item.fixedName ? 'taken' : item.fixedName !== item.written ? 'name-format' : null
    return { ...base, name, status: fix ? 'fixable' : 'ready', fix, picked: fix !== 'taken' }
  })
  return read.map((item) => named.find((candidate) => candidate.entry === item.entry)!)
}

/** The copied skill's frontmatter with `name` set, the rest of it and the body as they were. */
function renamed(source: string, name: string): string {
  const split = splitFrontmatter(source)
  if (!split) return source
  const doc = YAML.parseDocument(split.yaml)
  doc.set('name', name)
  return `---\n${String(doc).trimEnd()}\n---\n${split.body}`
}

/**
 * `source` copied to `target` as files and folders of its own, every link followed (cpSync's dereference follows
 * only the top one). A folder met again through a link is left out, so a loop of links cannot go on; so is the folder
 * the copy is written in (`output`), so a link to it cannot have the copy copy itself.
 */
function copyFollowingLinks(source: string, target: string, output: string, seen: ReadonlySet<string> = new Set()): void {
  const real = fs.realpathSync(source)
  if (real === output || real.startsWith(output + path.sep)) return
  if (!fs.statSync(real).isDirectory()) {
    fs.copyFileSync(real, target, fs.constants.COPYFILE_EXCL)
    return
  }
  if (seen.has(real)) return
  fs.mkdirSync(target)
  const inside = new Set([...seen, real])
  for (const entry of fs.readdirSync(real)) copyFollowingLinks(path.join(real, entry), path.join(target, entry), output, inside)
}

/** Whether a link is left anywhere in the copy; copyFollowingLinks leaves none, and this makes sure. */
function holdsLink(target: string): boolean {
  if (fs.lstatSync(target).isSymbolicLink()) return true
  if (!fs.statSync(target).isDirectory()) return false
  return fs.readdirSync(target).some((entry) => holdsLink(path.join(target, entry)))
}

/** A staged copy put right and checked: null when it may go in, else why not. */
function readied(staged: string, isFolder: boolean, candidate: Candidate): string | null {
  if (holdsLink(staged)) return t('main.skill-import.link.left', { name: candidate.name })
  const file = isFolder ? path.join(staged, SKILL_FILE) : staged
  const text = fs.readFileSync(file, 'utf8')
  if (checkSkill(text).name !== candidate.name) fs.writeFileSync(file, renamed(text, candidate.name))
  return checkSkill(fs.readFileSync(file, 'utf8')).issues.length ? t('main.skill-import.not.loadable', { name: candidate.name }) : null
}

/**
 * One candidate into `targetDir` under its name, as files of its own: a skill reached through a link (the folder, or
 * its SKILL.md) is copied as what the link points at, so renaming the copy never writes through to the original. The
 * copy is made beside `targetDir`, where dsh does not look, put right and checked there, and only then moved in whole;
 * whatever comes of it, nothing of it is left beside.
 */
function copyOne(candidate: Candidate, targetDir: string): string | null {
  const isFolder = fs.statSync(candidate.source).isDirectory()
  const target = path.join(targetDir, isFolder ? candidate.name : `${candidate.name}.md`)
  if (fs.existsSync(target)) return t('main.skill-import.exists', { name: candidate.name })
  fs.mkdirSync(targetDir, { recursive: true })
  const staging = fs.mkdtempSync(path.join(path.dirname(targetDir), '.viva-skill-import-'))
  try {
    const staged = path.join(staging, path.basename(target))
    copyFollowingLinks(candidate.source, staged, fs.realpathSync(staging))
    const problem = readied(staged, isFolder, candidate)
    if (problem) return problem
    if (fs.existsSync(target)) return t('main.skill-import.exists', { name: candidate.name })
    fs.renameSync(staged, target)
    return null
  } finally {
    fs.rmSync(staging, { recursive: true, force: true })
  }
}

/** The candidates picked (by entry) copied into `targetDir`; one dsh could not load is never copied. */
export function importCandidates(candidates: readonly Candidate[], picks: readonly string[], targetDir: string) {
  const chosen = candidates.filter((candidate) => picks.includes(candidate.entry) && candidate.status !== 'blocked')
  const results = chosen.map((candidate) => {
    try {
      return { candidate, problem: copyOne(candidate, targetDir) }
    } catch (err) {
      return { candidate, problem: err instanceof Error ? err.message : String(err) }
    }
  })
  return {
    imported: results.filter((result) => !result.problem).map((result) => result.candidate.name),
    failed: results.filter((result) => result.problem).map((result) => ({ entry: result.candidate.entry, reason: result.problem! })),
  }
}

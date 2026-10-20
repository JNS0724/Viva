import fs from 'node:fs'
import path from 'node:path'
import hljs from 'highlight.js/lib/common'

/**
 * The 文件 tab: the workspace's folders and a preview of one file, read-only. Every path is relative to
 * the workspace and must stay inside it, links included (they are followed, then checked). Nothing here
 * writes, and programs are never opened, only shown in their folder.
 */
/** One page of a text preview; the page asks for the next when it is scrolled to the end. */
export const PREVIEW_LIMIT = 200 * 1024
const IMAGE_LIMIT = 5 * 1024 * 1024
const MAX_ENTRIES = 500
/** Shown, but not opened by themselves: they hold thousands of files nobody reads. */
const HEAVY = new Set(['node_modules', '.git', 'dist', 'build', '.venv', '__pycache__'])
const MARKDOWN = new Set(['.md', '.markdown'])
const TABLES = new Set(['.csv', '.tsv'])
/** Extension → highlight.js language (its "common" set). */
const LANGUAGES = {
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascript', '.ts': 'typescript', '.tsx': 'typescript',
  '.json': 'json', '.py': 'python', '.java': 'java', '.go': 'go', '.rs': 'rust', '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.cc': 'cpp',
  '.hpp': 'cpp', '.cs': 'csharp', '.rb': 'ruby', '.php': 'php', '.sh': 'bash', '.bash': 'bash', '.zsh': 'bash', '.ps1': 'powershell',
  '.yml': 'yaml', '.yaml': 'yaml', '.toml': 'ini', '.ini': 'ini', '.cfg': 'ini', '.conf': 'ini', '.xml': 'xml', '.html': 'xml',
  '.htm': 'xml', '.css': 'css', '.scss': 'scss', '.less': 'less', '.sql': 'sql', '.swift': 'swift', '.kt': 'kotlin', '.lua': 'lua',
  '.r': 'r', '.diff': 'diff', '.patch': 'diff', '.pl': 'perl', '.vb': 'vbnet', '.m': 'objectivec', '.graphql': 'graphql',
}
const IMAGES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' }
/** Opening these would run them. */
const PROGRAMS = new Set(['.exe', '.bat', '.cmd', '.com', '.ps1', '.sh', '.command', '.app', '.js', '.vbs', '.wsf', '.lnk', '.msi', '.jar', '.scr', '.pkg', '.dmg'])
const BINARY_SAMPLE = 8000

const outside = () => new Error('这个位置不在工作区里')

/**
 * @param {string} root the workspace folder
 * @param {string} rel a path inside it, '' for the workspace itself
 * @returns {string} the real absolute path
 */
export function resolveInside(root, rel) {
  if (typeof rel !== 'string' || path.isAbsolute(rel)) throw outside()
  const base = fs.realpathSync(root)
  const target = path.resolve(base, rel)
  const real = fs.existsSync(target) ? fs.realpathSync(target) : target
  const within = path.relative(base, real)
  if (within.startsWith('..') || path.isAbsolute(within)) throw outside()
  return real
}

const toRel = (root, abs) => path.relative(fs.realpathSync(root), abs).split(path.sep).join('/')
const byName = (a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { sensitivity: 'base', numeric: true })

/** @returns {{ path: string, entries: { name: string, path: string, kind: 'folder' | 'file', size: number, heavy: boolean }[], truncated: boolean }} */
export function listFolder(root, rel) {
  const dir = resolveInside(root, rel)
  const dirents = fs.readdirSync(dir, { withFileTypes: true })
  const entries = dirents.slice(0, MAX_ENTRIES).flatMap((dirent) => {
    const abs = path.join(dir, dirent.name)
    let stat
    try {
      stat = fs.statSync(abs)
    } catch {
      return []
    }
    const kind = stat.isDirectory() ? 'folder' : 'file'
    return [{ name: dirent.name, path: toRel(root, abs), kind, size: kind === 'file' ? stat.size : 0, heavy: kind === 'folder' && HEAVY.has(dirent.name) }]
  })
  const folders = entries.filter((entry) => entry.kind === 'folder').sort(byName)
  const files = entries.filter((entry) => entry.kind === 'file').sort(byName)
  return { path: toRel(root, dir), entries: [...folders, ...files], truncated: dirents.length > MAX_ENTRIES }
}

/** @param {string} name @returns {boolean} whether the default app may open it */
export const canOpen = (name) => !PROGRAMS.has(path.extname(name).toLowerCase())

const looksBinary = (buffer) => buffer.subarray(0, BINARY_SAMPLE).includes(0)

/** Where a page may end without splitting a character: after its last line break, else at a character edge. */
function pageEnd(buffer) {
  const lineEnd = buffer.lastIndexOf(0x0a)
  if (lineEnd >= 0) return lineEnd + 1
  let lead = buffer.length - 1
  while (lead > 0 && (buffer[lead] & 0xc0) === 0x80) lead -= 1
  const width = buffer[lead] >= 0xf0 ? 4 : buffer[lead] >= 0xe0 ? 3 : buffer[lead] >= 0xc0 ? 2 : 1
  return lead + width > buffer.length ? lead : buffer.length
}

/** @returns {{ buffer: Buffer, nextOffset: number | null }} one page from `offset`; nextOffset is null at the end */
function readPage(file, size, offset) {
  const length = Math.max(0, Math.min(size - offset, PREVIEW_LIMIT))
  const buffer = Buffer.alloc(length)
  const fd = fs.openSync(file, 'r')
  try {
    fs.readSync(fd, buffer, 0, length, offset)
  } finally {
    fs.closeSync(fd)
  }
  if (offset + length >= size) return { buffer, nextOffset: null }
  const end = pageEnd(buffer)
  return { buffer: buffer.subarray(0, end), nextOffset: offset + end }
}

/** Code as highlight.js marks it up: its own text escaped, wrapped only in hljs spans. */
const highlighted = (text, language) => hljs.highlight(text, { language, ignoreIllegals: true }).value

/**
 * @param {{ offset?: number }} [page] where to read from, for the pages after the first
 * @returns {{ path: string, name: string, size: number, kind: 'markdown' | 'code' | 'csv' | 'text' | 'image' | 'binary',
 *   text?: string, html?: string, language?: string, dataUrl?: string, offset?: number, nextOffset?: number | null, openable: boolean }}
 */
export function previewFile(root, rel, { offset = 0 } = {}) {
  const file = resolveInside(root, rel)
  const stat = fs.statSync(file)
  if (!stat.isFile()) throw new Error('这不是文件')
  if (!Number.isInteger(offset) || offset < 0 || offset > stat.size) throw new Error('读取位置不对')
  const name = path.basename(file)
  const ext = path.extname(name).toLowerCase()
  const base = { path: toRel(root, file), name, size: stat.size, openable: canOpen(name) }
  if (IMAGES[ext]) {
    if (stat.size > IMAGE_LIMIT) return { ...base, kind: 'binary' }
    return { ...base, kind: 'image', dataUrl: `data:${IMAGES[ext]};base64,${fs.readFileSync(file).toString('base64')}` }
  }
  const { buffer, nextOffset } = readPage(file, stat.size, offset)
  if (offset === 0 && looksBinary(buffer)) return { ...base, kind: 'binary' }
  const text = buffer.toString('utf8')
  const page = { offset, nextOffset }
  if (MARKDOWN.has(ext)) return { ...base, kind: 'markdown', text, ...page }
  if (TABLES.has(ext)) return { ...base, kind: 'csv', text, ...page }
  const language = LANGUAGES[ext] ?? (name.toLowerCase() === 'dockerfile' ? 'dockerfile' : null)
  if (language && hljs.getLanguage(language)) return { ...base, kind: 'code', language, text, html: highlighted(text, language), ...page }
  return { ...base, kind: 'text', text, ...page }
}

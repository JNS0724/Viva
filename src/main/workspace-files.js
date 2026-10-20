import fs from 'node:fs'
import path from 'node:path'

/**
 * The 文件 tab: the workspace's folders and a preview of one file, read-only. Every path is relative to
 * the workspace and must stay inside it, links included (they are followed, then checked). Nothing here
 * writes, and programs are never opened, only shown in their folder.
 */
export const PREVIEW_LIMIT = 200 * 1024
const IMAGE_LIMIT = 5 * 1024 * 1024
const MAX_ENTRIES = 500
/** Shown, but not opened by themselves: they hold thousands of files nobody reads. */
const HEAVY = new Set(['node_modules', '.git', 'dist', 'build', '.venv', '__pycache__'])
const MARKDOWN = new Set(['.md', '.markdown'])
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

function readStart(file, size, limit) {
  const length = Math.min(size, limit)
  const buffer = Buffer.alloc(length)
  const fd = fs.openSync(file, 'r')
  try {
    fs.readSync(fd, buffer, 0, length, 0)
  } finally {
    fs.closeSync(fd)
  }
  return buffer
}

/**
 * @returns {{ path: string, name: string, size: number, kind: 'markdown' | 'text' | 'image' | 'binary',
 *   text?: string, dataUrl?: string, truncated: boolean, openable: boolean }}
 */
export function previewFile(root, rel) {
  const file = resolveInside(root, rel)
  const stat = fs.statSync(file)
  if (!stat.isFile()) throw new Error('这不是文件')
  const name = path.basename(file)
  const ext = path.extname(name).toLowerCase()
  const base = { path: toRel(root, file), name, size: stat.size, truncated: false, openable: canOpen(name) }
  if (IMAGES[ext]) {
    if (stat.size > IMAGE_LIMIT) return { ...base, kind: 'binary' }
    return { ...base, kind: 'image', dataUrl: `data:${IMAGES[ext]};base64,${fs.readFileSync(file).toString('base64')}` }
  }
  const start = readStart(file, stat.size, PREVIEW_LIMIT)
  if (looksBinary(start)) return { ...base, kind: 'binary' }
  return { ...base, kind: MARKDOWN.has(ext) ? 'markdown' : 'text', text: start.toString('utf8'), truncated: stat.size > PREVIEW_LIMIT }
}

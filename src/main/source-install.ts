import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { SourceManifest } from './source-contract.ts'
import { readManifest, type SourceFolder } from './source-folders.ts'

/**
 * Installing a message source from a folder the user picks: the folder is checked (a valid viva-source.json, not
 * too big) and shown for a yes, then copied into the sources folder as <id>. A source already installed under
 * that id is replaced as a whole, its settings kept. The copy is made beside the target and swapped in by
 * renaming, so a failed install leaves the old one as it was. Removing moves the folder to the trash, or deletes it
 * where there is no trash to move it to (a Windows drive without a recycle bin): it is the copy in the sources
 * folder, and a source installed from elsewhere is still where it came from.
 */
export const MAX_FILES = 5000
export const MAX_BYTES = 200 * 1024 * 1024
/** Folders nested deeper than this are not looked into (a link back to a parent would never end). */
const MAX_DEPTH = 32
/** Never copied: version control, which a source does not need to run. */
const SKIPPED = new Set(['.git'])
const STAGING_PREFIX = '.installing-'
const OLD_PREFIX = '.old-'

/** What the user is asked to say yes to. */
export interface Inspected { dir: string, manifest: SourceManifest, files: number, bytes: number }

/** Files and bytes under `dir`, stopping once past the limits; links are followed as copying follows them. */
function measure(dir: string): { files: number, bytes: number, tooDeep: boolean } {
  let files = 0
  let bytes = 0
  let tooDeep = false
  const walk = (at: string, depth: number) => {
    if (depth > MAX_DEPTH) {
      tooDeep = true
      return
    }
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      if (SKIPPED.has(entry.name) || files > MAX_FILES || bytes > MAX_BYTES || tooDeep) continue
      const full = path.join(at, entry.name)
      const stat = fs.statSync(full)
      if (stat.isDirectory()) walk(full, depth + 1)
      else {
        files += 1
        bytes += stat.size
      }
    }
  }
  walk(dir, 0)
  return { files, bytes, tooDeep }
}

const inside = (child: string, parent: string) => {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/** Whether `dir` can be installed, and what it is. */
export function inspectFolder(dir: string, root: string): Inspected | { problem: string } {
  const resolved = path.resolve(dir)
  if (inside(resolved, path.resolve(root))) return { problem: '这个文件夹已经在消息源文件夹里了，点「刷新」就能看到' }
  const read = readManifest(resolved)
  if ('problem' in read) return read
  let size: ReturnType<typeof measure>
  try {
    size = measure(resolved)
  } catch (err) {
    return { problem: `读不了这个文件夹：${(err as Error).message}` }
  }
  if (size.tooDeep) return { problem: `文件夹嵌套太深（超过 ${MAX_DEPTH} 层），可能有指回上层的链接` }
  if (size.files > MAX_FILES) return { problem: `文件太多了（超过 ${MAX_FILES} 个）` }
  if (size.bytes > MAX_BYTES) return { problem: `文件夹太大了（超过 ${Math.round(MAX_BYTES / 1024 / 1024)} MB）` }
  return { dir: resolved, manifest: read.manifest, files: size.files, bytes: size.bytes }
}

/** Copies an inspected folder into `root` as its id, replacing what was there; returns where it went. */
export function installFolder(inspected: Inspected, root: string): string {
  fs.mkdirSync(root, { recursive: true })
  const target = path.join(root, inspected.manifest.id)
  const staging = path.join(root, `${STAGING_PREFIX}${randomUUID()}`)
  try {
    fs.cpSync(inspected.dir, staging, { recursive: true, dereference: true, filter: (from) => !SKIPPED.has(path.basename(from)) })
    // The copy must still be the source that was shown: the folder may have changed since.
    const copied = readManifest(staging)
    if ('problem' in copied || copied.manifest.id !== inspected.manifest.id) throw new Error('文件夹在确认之后变了，请重新选择')
    if (!fs.existsSync(target)) {
      fs.renameSync(staging, target)
      return target
    }
    const old = path.join(root, `${OLD_PREFIX}${randomUUID()}`)
    fs.renameSync(target, old)
    try {
      fs.renameSync(staging, target)
    } catch (err) {
      fs.renameSync(old, target)
      throw err
    }
    fs.rmSync(old, { recursive: true, force: true })
    return target
  } finally {
    fs.rmSync(staging, { recursive: true, force: true })
  }
}

/** Leftovers of an install that stopped halfway (the app quit during the copy). */
export function clearLeftovers(root: string): void {
  let names: string[]
  try {
    names = fs.readdirSync(root)
  } catch {
    return
  }
  for (const name of names) {
    if (name.startsWith(STAGING_PREFIX) || name.startsWith(OLD_PREFIX)) fs.rmSync(path.join(root, name), { recursive: true, force: true })
  }
}

/** Moves the source's folder to the trash, or deletes it; only folders inside `root` are ever touched. */
export async function removeFolder(folder: SourceFolder, root: string, trash: (dir: string) => Promise<void>): Promise<'trashed' | 'deleted'> {
  const dir = path.resolve(folder.dir)
  if (!inside(dir, path.resolve(root)) || dir === path.resolve(root)) throw new Error('这个消息源不在消息源文件夹里')
  try {
    await trash(dir)
    return 'trashed'
  } catch {
    fs.rmSync(dir, { recursive: true, force: true })
    return 'deleted'
  }
}

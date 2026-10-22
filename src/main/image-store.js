import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { IMAGE_LIMITS, IMAGE_TYPES, isImageId, sniffImageType } from '../shared/images.ts'
import { removeTree } from './remove-tree.ts'

/**
 * The pictures folder: what the user pasted or dropped into a question (pasted/, named by contents, so a picture
 * pasted twice is there once), and dsh's own copies of what it sent the model (attachments/ and cache/, dsh's
 * attachment store pointed here by dsh-profile.js). Settings show its size, and the user can move or empty it.
 * Only these folders are ever read, counted, moved or removed: the folder may be one the user picked.
 */
export const IMAGE_FOLDERS = Object.freeze(['pasted', 'attachments', 'cache'])
/** The folder made inside the one the user picks to move the pictures to. */
export const MOVED_FOLDER_NAME = 'Viva 图片'
const TOO_BIG = `图片太大了（上限 ${IMAGE_LIMITS.bytes / 1024 / 1024} MB）`
const NOT_IMAGE = '只能发 PNG、JPG、GIF、WebP 图片'

function sizeOf(dir) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (err) {
    if (err.code === 'ENOENT') return { bytes: 0, files: 0 }
    throw err
  }
  return entries.reduce((total, entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const inner = sizeOf(full)
      return { bytes: total.bytes + inner.bytes, files: total.files + inner.files }
    }
    return entry.isFile() ? { bytes: total.bytes + fs.statSync(full).size, files: total.files + 1 } : total
  }, { bytes: 0, files: 0 })
}

/** @param {{ dir: () => string }} options where the pictures are now (preferences, or the default in userData) */
export function createImageStore({ dir }) {
  const pastedDir = () => path.join(dir(), 'pasted')
  const fileOf = (id) => path.join(pastedDir(), id)

  /**
   * Keeps a pasted picture; the same bytes again are the same picture.
   * @param {Uint8Array} bytes @returns {{ id: string, mimeType: string, size: number }}
   */
  function keep(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length === 0) throw new Error(NOT_IMAGE)
    if (bytes.length > IMAGE_LIMITS.bytes) throw new Error(TOO_BIG)
    const mimeType = sniffImageType(bytes)
    if (!mimeType) throw new Error(NOT_IMAGE)
    const id = `${createHash('sha256').update(bytes).digest('hex')}.${IMAGE_TYPES[mimeType]}`
    const file = fileOf(id)
    if (!fs.existsSync(file)) {
      fs.mkdirSync(pastedDir(), { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      fs.writeFileSync(tmp, bytes)
      fs.renameSync(tmp, file)
    }
    return { id, mimeType, size: bytes.length }
  }

  /** @returns {string | null} where the picture is, or null when it is not (any more) */
  function pathOf(id) {
    if (!isImageId(id)) return null
    const file = fileOf(id)
    return fs.existsSync(file) ? file : null
  }

  /** @returns {{ dir: string, bytes: number, count: number }} how much the pictures take, and how many were pasted */
  function usage() {
    const parts = IMAGE_FOLDERS.map((name) => sizeOf(path.join(dir(), name)))
    return { dir: dir(), bytes: parts.reduce((sum, part) => sum + part.bytes, 0), count: parts[0].files }
  }

  /** Removes every picture; the folder itself and anything else in it stay. */
  function clear() {
    for (const name of IMAGE_FOLDERS) removeTree(path.join(dir(), name))
  }

  /**
   * Copies the pictures into `MOVED_FOLDER_NAME` inside `parent`, then removes them where they were.
   * @returns {string} the new folder, for the preferences
   */
  function moveTo(parent) {
    const from = path.resolve(dir())
    const to = path.resolve(parent, MOVED_FOLDER_NAME)
    if (to === from) return to
    if (to.startsWith(`${from}${path.sep}`)) throw new Error('不能放进现在的图片文件夹里面')
    if (IMAGE_FOLDERS.some((name) => fs.existsSync(path.join(to, name)))) throw new Error(`「${to}」里已经有 Viva 的图片了，换一个位置`)
    fs.mkdirSync(to, { recursive: true })
    for (const name of IMAGE_FOLDERS) {
      const source = path.join(from, name)
      if (fs.existsSync(source)) fs.cpSync(source, path.join(to, name), { recursive: true, verbatimSymlinks: true })
    }
    clear()
    return to
  }

  return { keep, pathOf, usage, clear, moveTo }
}

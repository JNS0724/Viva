import fs from 'node:fs'
import path from 'node:path'
import { checkManifest, MANIFEST_FILE, type SourceManifest } from './source-contract.ts'

/**
 * The message sources set up on this computer: one folder each under the sources folder (userData/sources),
 * each with its viva-source.json. A folder that cannot be used is listed with why, so settings can say so,
 * and never stops the others.
 */
const MAX_MANIFEST_BYTES = 64 * 1024
const MAX_SOURCES = 50

export interface SourceFolder { dir: string, manifest: SourceManifest }
export interface BrokenFolder { dir: string, name: string, problem: string }

/** One folder's viva-source.json, checked; or why the folder cannot be a source. */
export function readManifest(dir: string): { manifest: SourceManifest } | { problem: string } {
  const file = path.join(dir, MANIFEST_FILE)
  let text: string
  try {
    if (fs.statSync(file).size > MAX_MANIFEST_BYTES) return { problem: `${MANIFEST_FILE} 太大了` }
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    return { problem: (err as NodeJS.ErrnoException).code === 'ENOENT' ? `没有 ${MANIFEST_FILE}` : `读不了 ${MANIFEST_FILE}` }
  }
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return { problem: `${MANIFEST_FILE} 不是有效的 JSON` }
  }
  const checked = checkManifest(data)
  return checked.problem === undefined ? { manifest: checked.manifest } : { problem: checked.problem }
}

/** Every source folder under `root`, sorted by name; two folders claiming one id keep the first. */
export function listSourceFolders(root: string): { sources: SourceFolder[], broken: BrokenFolder[] } {
  let names: string[]
  try {
    names = fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort()
  } catch {
    return { sources: [], broken: [] }
  }
  const sources: SourceFolder[] = []
  const broken: BrokenFolder[] = []
  for (const name of names.slice(0, MAX_SOURCES)) {
    const dir = path.join(root, name)
    const read = readManifest(dir)
    if ('problem' in read) {
      broken.push({ dir, name, problem: read.problem })
      continue
    }
    if (sources.some((source) => source.manifest.id === read.manifest.id)) {
      broken.push({ dir, name, problem: `id「${read.manifest.id}」和另一个消息源重复` })
      continue
    }
    sources.push({ dir, manifest: read.manifest })
  }
  return { sources, broken }
}

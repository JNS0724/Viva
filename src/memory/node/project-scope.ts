import { createHash } from 'node:crypto'
import { accessSync, constants, lstatSync, readFileSync, realpathSync, statSync, type BigIntStats } from 'node:fs'
import path from 'node:path'

function projectRoot(cwd: string) {
  for (let directory = cwd; ; directory = path.dirname(directory)) {
    if (lstatSync(path.join(directory, '.git'), { throwIfNoEntry: false })) return directory
    if (path.dirname(directory) === directory) return undefined
  }
}

const POINTER_LIMIT = 8192

function readPointer(file: string): string {
  const stat = statSync(file)
  return stat.isFile() && stat.size <= POINTER_LIMIT ? readFileSync(file, 'utf8').trim() : ''
}

function gitDirectory(root: string): BigIntStats | null {
  const marker = path.join(root, '.git')
  const stat = statSync(marker)
  let gitDir = marker
  if (stat.isFile()) {
    const pointer = /^gitdir: (.+)$/.exec(readPointer(marker))?.[1]
    if (!pointer) return null
    gitDir = path.resolve(root, pointer)
  } else if (!stat.isDirectory()) return null

  const identity = statSync(gitDir, { bigint: true })
  if (!identity.isDirectory() || !statSync(path.join(gitDir, 'HEAD')).isFile()) return null
  const commonDirFile = path.join(gitDir, 'commondir')
  const commonDir = statSync(commonDirFile, { throwIfNoEntry: false }) ? readPointer(commonDirFile) : '.'
  if (!commonDir || /[\r\n\u0000]/u.test(commonDir) || !statSync(path.resolve(gitDir, commonDir, 'objects')).isDirectory()) return null
  return identity
}

type Project = { kind: 'project', id: string }
export type MemoryProjectResolution = { status: 'user' } | { status: 'unknown' } | { status: 'project', project: Project }

/** A canonical worktree and its Git directory fix the scope. Moving or recreating the repository starts a new scope. */
export function resolveMemoryProject(cwd: string | null | undefined): MemoryProjectResolution {
  if (cwd === null) return { status: 'user' }
  if (!cwd || !path.isAbsolute(cwd)) return { status: 'unknown' }
  try {
    const start = realpathSync.native(cwd)
    if (!statSync(start).isDirectory()) return { status: 'unknown' }
    accessSync(start, constants.R_OK)
    const root = projectRoot(start)
    if (!root) return { status: 'user' }
    const identity = gitDirectory(root)
    if (!identity) return { status: 'unknown' }
    const canonical = process.platform === 'win32' ? root.replace(/^[a-z]:/u, drive => drive.toUpperCase()) : root
    const id = createHash('sha256').update(JSON.stringify([canonical, String(identity.dev), String(identity.ino), String(identity.birthtimeNs)])).digest('hex')
    return { status: 'project', project: { kind: 'project', id } }
  } catch { return { status: 'unknown' } }
}

export function memoryProjectScope(cwd: string | null | undefined): Project | undefined {
  const resolved = resolveMemoryProject(cwd)
  return resolved.status === 'project' ? resolved.project : undefined
}

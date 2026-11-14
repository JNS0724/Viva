import { createHash } from 'node:crypto'
import { readFileSync, realpathSync, statSync, type BigIntStats } from 'node:fs'
import path from 'node:path'
import type { MemoryProfileScope } from './memory-profile.ts'
import { projectRoot } from './skills.ts'

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

/** A canonical worktree and its Git directory fix the scope. Moving or recreating the repository starts a new scope. */
export function memoryProjectScope(cwd: string | null | undefined): Extract<MemoryProfileScope, { kind: 'project' }> | undefined {
  if (!cwd || !path.isAbsolute(cwd)) return undefined
  try {
    const start = realpathSync.native(cwd)
    if (!statSync(start).isDirectory()) return undefined
    const root = projectRoot(start)
    const identity = gitDirectory(root)
    if (!identity) return undefined
    const canonical = process.platform === 'win32' ? root.replace(/^[a-z]:/u, drive => drive.toUpperCase()) : root
    const id = createHash('sha256').update(JSON.stringify([canonical, String(identity.dev), String(identity.ino), String(identity.birthtimeNs)])).digest('hex')
    return { kind: 'project', id }
  } catch { return undefined }
}

/** A topic can be visible in several workspaces; its model-visible memory scope stays in the original project. */
export function memoryConversationScope(topic: string, project?: ReturnType<typeof memoryProjectScope>) {
  return { kind: 'conversation' as const, id: project ? `${topic}@${project.id}` : topic }
}

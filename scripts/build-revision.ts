import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** A dirty tree or source archive remains explicitly unknown; never label changed sources with a clean commit. */
export function buildRevision(root: string): string {
  try {
    const revision = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).trim()
    const changes = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 })
    if (changes.trim()) return 'unknown'
    return /^[a-f0-9]{40}$/.test(revision) ? revision : 'unknown'
  } catch { return 'unknown' }
}

/** Generated JS is required in the compiled graph; source execution retains the explicit unknown fallback. */
export function writeBuildRevision(output: string, revision: string): void {
  if (revision !== 'unknown' && !/^[a-f0-9]{40}$/.test(revision)) throw new Error('Invalid build revision')
  const target = path.join(output, 'src/diagnostics/build-info.js')
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, `// Generated from the source checkout.\nexport const BUILD_COMMIT = ${JSON.stringify(revision)};\n`)
}

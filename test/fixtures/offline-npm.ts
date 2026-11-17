import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

function logFiles(cache: string): string[] {
  try { return readdirSync(path.join(cache, '_logs')).filter(file => file.endsWith('-debug-0.log')) }
  catch { return [] }
}

function phaseLog(cache: string, stderr: unknown, previous: ReadonlySet<string>): string {
  let debug = ''
  try {
    const root = path.join(cache, '_logs')
    const latest = logFiles(cache).filter(file => !previous.has(file)).sort().at(-1)
    if (latest) debug = readFileSync(path.join(root, latest), 'utf8')
  } catch { /* Diagnostics must not replace the original command failure. */ }
  const events: string[] = []
  for (const line of `${debug}\n${typeof stderr === 'string' ? stderr : ''}`.split(/\r?\n/u)) {
    const phase = line.match(/^(?:\d+ |npm )(timing|silly) ((?:idealTree|reify|reifyNode|build|command)(?::[\w@./-]+)?)(?:\s|$)/u)
    if (phase) {
      // Only known phase names and numeric durations are public. Never print npm config,
      // arguments, package paths/URLs, move maps or arbitrary error messages.
      const [base, detail] = phase[2]!.split(':')
      const suffix = detail && /^(?:init|buildDeps|fixDepFlags|loadTrees|diffTrees|retireShallow|createSparse|loadBundles|unpack|unretire|build|trash|save|link|deps|queue|run|install|pack)$/u.test(detail) ? `:${detail}` : ''
      const duration = line.match(/Completed in (\d+)ms/u)?.[1]
      events.push(`${phase[1]} ${base}${suffix}${duration ? ` ${duration}ms` : ''}`)
    }
    const code = line.match(/^(?:\d+ |npm )error code (E[A-Z0-9_]{1,30})$/u)?.[1]
    if (code) events.push(`npm error ${code}`)
  }
  return events.slice(-24).join('\n') || 'No npm install/pack phase was recorded.'
}

/** Keep the existing finite command budget and retain safe phase evidence before cleanup. */
export function runOfflineNpm({ node, cli, command, args, cwd, cache, timeoutMs = 60_000 }: {
  node: string, cli: string, command: 'pack' | 'install', args: string[], cwd: string, cache: string, timeoutMs?: number,
}): string {
  const started = performance.now()
  const previous = new Set(logFiles(cache))
  try {
    return execFileSync(node, [cli, command, ...args, '--cache', cache, '--timing', '--loglevel=silly'], {
      cwd, encoding: 'utf8', timeout: timeoutMs, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    const failure = error && typeof error === 'object' ? error as { code?: unknown, status?: unknown, signal?: unknown, stderr?: unknown } : {}
    const code = typeof failure.code === 'string' && /^E[A-Z0-9_]{1,30}$/u.test(failure.code) ? failure.code : 'command-failed'
    const status = typeof failure.status === 'number' ? failure.status : 'unknown'
    const signal = typeof failure.signal === 'string' && /^SIG[A-Z]+$/u.test(failure.signal) ? failure.signal : 'none'
    throw new Error(`npm ${command} failed after ${Math.round(performance.now() - started)}ms (code=${code}, status=${status}, signal=${signal})\n${phaseLog(cache, failure.stderr, previous)}`)
  }
}

// Short local feedback for one responsibility. Full npm test, typecheck and platform smoke remain the merge gates.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = path.resolve(import.meta.dirname, '..')
const CONTRACTS = /^(?:ipc-contract|window-api|module-boundaries)\.test\.(?:js|ts)$/
const FEATURES = {
  conversation: /^(?:conversation-|new-topic-|topic-|history(?:[.-])|resume-|rewind-|work-?dir(?:[.-])|workdir-|waits-|handoff-|text-submit-|assistant-stream|report-records)/,
  runtime: /^(?:acp-|dsh-|fresh-sessions|stream-runtime|stop-in-time|prewarm-runtime|mcp-bridge|images-bridge|steer-channel|config-channel|questions(?:[.-])|(?:permission|questions|fork|stream|steer)-plugin|tasks-bridge|backend-wire)/,
  tasks: /^(?:tasks?(?:[.-])|schedule(?:s|[.-])|unattended-|report-records|steer-reports|waits-|handoff-|feed-|event-core|effects|side-effects|agent-events)/,
  architecture: /^(?:module-boundaries|backend-boundary|backend-wire|main-modules|ipc-contract|window-api|smoke-isolation|test-feature)\.test\.(?:js|ts)$/,
} as const
export type Feature = keyof typeof FEATURES
export const featureNames = Object.keys(FEATURES) as Feature[]

/** The same JS/TS suffixes as npm test; never recurse through a symlink or into installed dependencies. */
export function discoverTests(root: string): string[] {
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : walk(file)
    return entry.isFile() && /\.test\.(?:js|ts)$/.test(entry.name) ? [path.relative(root, file)] : []
  })
  return walk(path.join(root, 'test')).sort()
}

/** Validate every requested group before selecting; a typo/empty group must never produce a green no-op. */
export function selectTests(files: readonly string[], names: readonly string[]): string[] {
  if (!names.length) throw new Error('Choose at least one feature.')
  const chosen = names.map(name => {
    if (!Object.hasOwn(FEATURES, name)) throw new Error(`Unknown feature: ${name}`)
    const pattern = FEATURES[name as Feature]
    const matches = files.filter(file => pattern.test(path.basename(file)))
    if (!matches.length) throw new Error(`No tests found for feature: ${name}`)
    return matches
  })
  return [...new Set([...chosen.flat(), ...files.filter(file => CONTRACTS.test(path.basename(file)))])].sort()
}

export function runFeatures(args: readonly string[]): number {
  const list = args.includes('--list')
  const names = args.filter(arg => arg !== '--list')
  let files: string[]
  try {
    files = selectTests(discoverTests(ROOT), names)
  } catch (error) {
    console.error(`[test:feature] ${error instanceof Error ? error.message : String(error)}`)
    console.error(`Usage: npm run test:feature -- ${featureNames.join('|')} [more features] [--list]`)
    return 2
  }
  if (list) {
    console.log(files.join('\n'))
    return 0
  }
  console.log(`[test:feature] ${[...new Set(names)].join(', ')}: ${files.length} files; full verification is still required.`)
  const electron: string = createRequire(import.meta.url)('electron')
  const started = performance.now()
  // An argument array, not a shell/glob command: spaces and Windows paths remain literal arguments.
  const result = spawnSync(electron, ['--test', ...files], {
    cwd: ROOT, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit',
  })
  console.log(`[test:feature] ${(performance.now() - started).toFixed(0)} ms`)
  if (result.error) console.error(`[test:feature] ${result.error.message}`)
  return result.status ?? 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = runFeatures(process.argv.slice(2))
}

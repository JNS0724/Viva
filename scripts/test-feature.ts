// Short local feedback for one responsibility. Full npm test, typecheck and platform smoke remain the merge gates.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { testLevels, type TestLevel } from './test-levels.ts'

const ROOT = path.resolve(import.meta.dirname, '..')
const CONTRACTS = /^(?:ipc-contract|window-api|module-boundaries)\.test\.(?:js|ts)$/
const FEATURES = {
  conversation: /^(?:conversation-|composer-draft\.|new-topic-|topic-|history(?:[.-])|resume-|rewind-|work-?dir(?:[.-])|workdir-|waits-|handoff-|text-submit-|assistant-stream|report-records|state\.|secret-state\.|agent-events\.|topics\.)/,
  runtime: /^(?:acp-|dsh-|fresh-sessions|stream-runtime|stop-in-time|prewarm-runtime|mcp-bridge|images-bridge|steer-channel|config-channel|questions(?:[.-])|(?:permission|questions|fork|stream|steer)-plugin|tasks-bridge|backend-wire|backend-keeper|question-desk|mcp-import|codex-mcp|fake-dsh|(?:config|policy|trace)-plugin)/,
  tasks: /^(?:tasks?(?:[.-])|schedule(?:s|[.-])|unattended-|report-records|steer-reports|waits-|handoff-|feed-|event-core|effects|side-effects|agent-events|proposal-state|proposal-draft|source-report-registration)/,
  architecture: /^(?:module-boundaries|backend-boundary|backend-wire(?:-timing)?|main-modules|ipc-contract|window-api|smoke-isolation|smoke-fixtures|smoke-layout|ci-check|test-feature)\.test\.(?:js|ts)$/,
  models: /^(?:models?[.-])/,
  skills: /^(?:skills?[.-])/,
  capabilities: /^(?:capabilit|extensions[.-]|plugins?[.-]|app-plugins[.-]|import-flow[.-]|config-actions[.-]|commands[.-])/,
  files: /^(?:file(?:s[.-]|-access)|workspace-files[.-]|attachments[.-]|image-(?:ipc|store)[.-]|paste[.-]|csv[.-]|remove-tree[.-])/,
  memory: /^memory[.-]/,
  rendering: /^(?:column-resize|earlier-(?:row|state)|frame|full-screen|hub-state|island-(?:desk-card|dom|view)|long-answer|markdown|prompt-card|reader-control|reconcile|renderer-(?:css|hotpaths)|review-(?:actions|state)|scroll-follow|selectors|stars|timeline-search|turn-rail|user-error)\.test\.(?:js|ts)$/,
  storage: /^(?:app-db|envelope|journal|preferences|settings|history-db|feed-store|task-store)\.test\.(?:js|ts)$/,
  i18n: /^i18n[.-]/,
  shell: /^(?:desk-(?:island|place)|island-main|tray|window-options)\.test\.(?:js|ts)$/,
  tooling: /^(?:asar-integrity|pnpm-launcher|live(?:-approval)?|maid|smoke-(?:kit|timeline-time|layout|fixtures)|ci-check|test-feature)\.test\.(?:js|ts)$/,
} as const
export type Feature = keyof typeof FEATURES
export const featureNames = Object.keys(FEATURES) as Feature[]
export const levelNames = Object.keys(testLevels) as TestLevel[]

const stem = (file: string) => path.basename(file).replace(/\.test\.(?:js|ts)$/, '')

/** Explicit cost ownership: a new file must be classified before any focused run. */
export function auditTests(files: readonly string[]): void {
  const problems = files.flatMap(file => {
    const features = featureNames.filter(name => FEATURES[name].test(path.basename(file)))
    const levels = levelNames.filter(name => testLevels[name].some(name => name === stem(file)))
    return [
      ...(!features.length ? [`${file}: missing feature`] : []),
      ...(levels.length !== 1 ? [`${file}: expected one level, found ${levels.length}`] : []),
    ]
  })
  if (problems.length) throw new Error(`Test ownership audit failed:\n${problems.join('\n')}`)
}

function filterLevels(files: readonly string[], levels?: readonly string[]): readonly string[] {
  if (levels === undefined) return files
  if (!levels.length) throw new Error('Choose at least one level.')
  for (const level of levels) if (!Object.hasOwn(testLevels, level)) throw new Error(`Unknown level: ${level}`)
  return files.filter(file => levels.some(level => testLevels[level as TestLevel].some(name => name === stem(file))))
}

function withContracts(files: readonly string[], selected: readonly string[]): string[] {
  return [...new Set([...selected, ...files.filter(file => CONTRACTS.test(path.basename(file)))])].sort()
}

export function selectAllTests(files: readonly string[], levels?: readonly string[]): string[] {
  const selected = filterLevels(files, levels)
  if (!selected.length) throw new Error('No tests found for the requested levels.')
  return withContracts(files, selected)
}

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
export function selectTests(files: readonly string[], names: readonly string[], levels?: readonly string[]): string[] {
  if (!names.length) throw new Error('Choose at least one feature.')
  const candidates = filterLevels(files, levels)
  const chosen = names.map(name => {
    if (!Object.hasOwn(FEATURES, name)) throw new Error(`Unknown feature: ${name}`)
    const pattern = FEATURES[name as Feature]
    const matches = candidates.filter(file => pattern.test(path.basename(file)))
    if (!matches.length) throw new Error(`No tests found for feature: ${name}`)
    return matches
  })
  return withContracts(files, chosen.flat())
}

export function runFeatures(args: readonly string[]): number {
  let files: string[]
  let label: string
  let list: boolean
  try {
    const { values, positionals: names } = parseArgs({
      args: [...args], allowPositionals: true,
      options: { list: { type: 'boolean' }, all: { type: 'boolean' }, level: { type: 'string', multiple: true } },
    })
    if (values.all && names.length) throw new Error('Choose features or --all, not both.')
    const discovered = discoverTests(ROOT)
    auditTests(discovered)
    files = values.all ? selectAllTests(discovered, values.level) : selectTests(discovered, names, values.level)
    label = `${values.all ? 'all' : [...new Set(names)].join(', ')} (${values.level?.join(', ') ?? 'all levels'})`
    list = values.list ?? false
  } catch (error) {
    console.error(`[test:feature] ${error instanceof Error ? error.message : String(error)}`)
    console.error(`Usage: npm run test:feature -- ${featureNames.join('|')} [more features] [--level fast|integration|timing] [--list]`)
    console.error('       npm run test:fast -- [--list]')
    return 2
  }
  if (list) {
    console.log(files.join('\n'))
    return 0
  }
  console.log(`[test:feature] ${label}: ${files.length} files; full verification is still required.`)
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

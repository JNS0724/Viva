import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** dsh's own entry point; running it directly avoids the `.bin/dsh(.cmd)` shim, which Windows won't spawn without a shell. */
const DEFAULT_DSH_ENTRY = path.join(APP_ROOT, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const SCRIPT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs'])
/**
 * Automated runs: `walkthrough` uses a fresh profile, `relaunch` reopens it, `setup` starts without a key,
 * `memory` runs the real dsh with the memory plugin against a fake model.
 */
const SMOKE_PHASES = new Set(['walkthrough', 'relaunch', 'setup', 'memory'])

/** The app's own dsh profile: the ACP template plus the memory plugin; see dsh-profile.js. */
export const DSH_PROFILE = 'my-agent'

/**
 * How to start dsh in ACP mode. A JavaScript entry runs under `nodeBin` (dsh refuses to run inside
 * Electron's own Node unless the Electron version is on its list); anything else is executed directly.
 * @returns {{ command: string, args: string[] }}
 */
export function dshLaunch(dshBin, nodeBin, profile = DSH_PROFILE) {
  const extension = path.extname(dshBin.replaceAll('\\', '/')).toLowerCase()
  return SCRIPT_EXTENSIONS.has(extension)
    ? { command: nodeBin, args: [dshBin, '--profile', profile] }
    : { command: dshBin, args: ['--profile', profile] }
}

const resolveIfPath = (value) => (/[\\/]/.test(value) ? path.resolve(value) : value)

function problemFor(apiKey, dshBin, exists) {
  if (!apiKey) return 'no-key'
  if (!exists(dshBin)) return 'no-dsh'
  return null
}

/**
 * Reads launch settings. A key saved in the settings panel wins over `DEEPSEEK_API_KEY` from the environment.
 * `problem` says what is missing before the agent can start (null when ready).
 */
export function resolveConfig(env = process.env, exists = fs.existsSync, savedKey = '') {
  // A relative path is taken from where the app was launched, not from the agent's workspace.
  const dshBin = env.DSH_BIN ? resolveIfPath(env.DSH_BIN) : DEFAULT_DSH_ENTRY
  const apiKey = savedKey || env.DEEPSEEK_API_KEY || ''
  const smokePhase = SMOKE_PHASES.has(env.SMOKE_PHASE) ? env.SMOKE_PHASE : null
  return {
    dshBin,
    nodeBin: env.DSH_NODE || 'node',
    cwd: path.resolve(env.AGENT_CWD || path.join(APP_ROOT, 'workspace')),
    apiKey,
    keySource: savedKey ? 'saved' : env.DEEPSEEK_API_KEY ? 'env' : null,
    problem: problemFor(apiKey, dshBin, exists),
    dshHome: path.resolve(env.DSH_HOME || path.join(os.homedir(), '.dsh')),
    smoke: smokePhase !== null,
    smokePhase,
    smokeOut: path.resolve(env.SMOKE_OUT || path.join(APP_ROOT, 'smoke')),
  }
}

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { dshHomeFor, dshRuntime } from './dsh-runtime.js'

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
export const DSH_PROFILE = 'viva'

/**
 * How to start dsh in ACP mode. A JavaScript entry runs under `nodeBin` (the app's own executable as Node,
 * see dsh-runtime.js); anything else is executed directly.
 * @returns {{ command: string, args: string[] }}
 */
export function dshLaunch(dshBin, nodeBin, profile = DSH_PROFILE) {
  const extension = path.extname(dshBin.replaceAll('\\', '/')).toLowerCase()
  return SCRIPT_EXTENSIONS.has(extension)
    ? { command: nodeBin, args: [dshBin, '--profile', profile] }
    : { command: dshBin, args: ['--profile', profile] }
}

const resolveIfPath = (value) => (/[\\/]/.test(value) ? path.resolve(value) : value)

/** 'no-key': no model to talk to, neither a DeepSeek key nor a provider the user added. */
function problemFor(hasModel, dshBin, exists) {
  if (!hasModel) return 'no-key'
  if (!exists(dshBin)) return 'no-dsh'
  return null
}

/**
 * Reads launch settings. A key saved in the settings panel wins over `DEEPSEEK_API_KEY` from the environment.
 * `problem` says what is missing before the agent can start (null when ready); other model providers
 * (model-providers.js) make the DeepSeek key optional. dsh's home lives in the app's data folder, and dsh
 * runs on the app's own executable (DSH_NODE names another Node, for development).
 * @param {{ userData?: string, execPath?: string, packaged?: boolean }} [app] where the app keeps its data, its
 *   executable, and whether it is the installed app (whose own folder is read-only: the workspace goes to userData)
 */
export function resolveConfig(env = process.env, exists = fs.existsSync, savedKey = '', hasProviders = false, app = {}) {
  // A relative path is taken from where the app was launched, not from the agent's workspace.
  const dshBin = env.DSH_BIN ? resolveIfPath(env.DSH_BIN) : DEFAULT_DSH_ENTRY
  const apiKey = savedKey || env.DEEPSEEK_API_KEY || ''
  const smokePhase = SMOKE_PHASES.has(env.SMOKE_PHASE) ? env.SMOKE_PHASE : null
  const runtime = dshRuntime({ env, execPath: app.execPath ?? process.execPath })
  return {
    dshBin,
    nodeBin: runtime.nodeBin,
    runtime,
    cwd: path.resolve(env.AGENT_CWD || (app.packaged && app.userData ? path.join(app.userData, 'workspace') : path.join(APP_ROOT, 'workspace'))),
    apiKey,
    keySource: savedKey ? 'saved' : env.DEEPSEEK_API_KEY ? 'env' : null,
    problem: problemFor(Boolean(apiKey) || hasProviders, dshBin, exists),
    dshHome: app.userData ? dshHomeFor(app.userData) : null,
    smoke: smokePhase !== null,
    smokePhase,
    smokeOut: path.resolve(env.SMOKE_OUT || path.join(APP_ROOT, 'smoke')),
  }
}

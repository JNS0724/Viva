import fs from 'node:fs'
import path from 'node:path'
import { APP_ROOT } from '../shared/node/app-roots.ts'
import { type DshRuntime, dshHomeFor, dshRuntime } from './dsh-runtime.ts'


/** dsh's own entry point; running it directly avoids the `.bin/dsh(.cmd)` shim, which Windows won't spawn without a shell. */
const DEFAULT_DSH_ENTRY = path.join(APP_ROOT, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const SCRIPT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs'])

/** The app's own dsh profile: the ACP template plus the memory plugin; see dsh-profile.js. */
export const DSH_PROFILE = 'viva'

/**
 * How to start dsh in ACP mode. A JavaScript entry runs under `nodeBin` (the app's own executable as Node,
 * see dsh-runtime.ts); anything else is executed directly.
 */
export function dshLaunch(dshBin: string, nodeBin: string, profile = DSH_PROFILE, overlay: string | null = null): { command: string, args: string[] } {
  const extension = path.extname(dshBin.replaceAll('\\', '/')).toLowerCase()
  // The app's layer (dsh-profile.ts vivaLayerFile) goes over the profile's own for this launch only.
  const options = ['--profile', profile, ...(overlay ? ['--patch', overlay] : [])]
  return SCRIPT_EXTENSIONS.has(extension) ? { command: nodeBin, args: [dshBin, ...options] } : { command: dshBin, args: options }
}

const resolveIfPath = (value: string) => (/[\\/]/.test(value) ? path.resolve(value) : value)

/** 'no-key': no model to talk to, neither a DeepSeek key nor a provider the user added. */
function problemFor(hasModel: boolean, dshBin: string, exists: (file: string) => boolean): 'no-key' | 'no-dsh' | null {
  if (!hasModel) return 'no-key'
  if (!exists(dshBin)) return 'no-dsh'
  return null
}

export interface LaunchConfig {
  dshBin: string
  nodeBin: string
  runtime: DshRuntime
  cwd: string
  apiKey: string
  keySource: 'saved' | 'env' | null
  problem: 'no-key' | 'no-dsh' | null
  dshHome: string | null
}

/**
 * Reads launch settings. A key saved in the settings panel wins over `DEEPSEEK_API_KEY` from the environment.
 * `problem` says what is missing before the agent can start (null when ready); other model providers
 * (model-providers.ts) make the DeepSeek key optional. dsh's home lives in the app's data folder, and dsh
 * runs on the app's own executable (DSH_NODE names another Node, for development).
 * @param app where the app keeps its data, its executable, and whether it is the installed app (whose own
 *   folder is read-only: the workspace goes to userData)
 */
export function resolveConfig(
  env: NodeJS.ProcessEnv = process.env,
  exists: (file: string) => boolean = fs.existsSync,
  savedKey = '',
  hasProviders = false,
  app: { userData?: string, execPath?: string, packaged?: boolean } = {},
): LaunchConfig {
  // A relative path is taken from where the app was launched, not from the agent's workspace.
  const dshBin = env.DSH_BIN ? resolveIfPath(env.DSH_BIN) : DEFAULT_DSH_ENTRY
  const apiKey = savedKey || env.DEEPSEEK_API_KEY || ''
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
  }
}

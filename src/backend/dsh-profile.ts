import { t } from '../shared/i18n/translate.ts'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { npmrcWith, type PluginSourceView } from './plugin-source.ts'

/**
 * The app's own dsh profile, in layers dsh applies one over the other:
 * - the bundles: the stock ACP composition, then the plugins the user installed (dsh's plugin manager adds them);
 * - the profile's cordis.patch.yml: the user's layer, where the plugin manager keeps its switches. The app never
 *   writes it, except to start it empty (or to empty what an earlier version of the app wrote there);
 * - the app's layer (viva.patch.yml beside the profiles, given to dsh with --patch at launch, so it wins): the
 *   persona, the models, the app's plugins by file URL, HMR and the plugin manager switched on, and the stock rows
 *   the app relies on for safety restated whole, so neither the user's layer nor a bundle can change them.
 * It is written before every launch, so a moved app or data file is picked up, and only files that changed are
 * touched. The user's other profiles (including `acp`) are never read or written.
 */
/** The app's plugins are all named like this, so ones dropped from the list can be told apart and removed. */
export const APP_PLUGIN_PREFIX = 'viva-'
/** Same bundles as dsh's own `acp` template (`dsh --from-default-profile acp`). */
const BUNDLES = Object.freeze(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app'])
/** The app's layer, written on every launch (vivaLayerFile). */
export const VIVA_LAYER_MARK = '# Written by Viva on every launch; edits here are replaced.'
/** The user's layer when there is nothing in it yet: dsh refuses an empty or comment-only patch file. */
const EMPTY_LAYER = '[]\n'
const ROOT_CONFIG = `# dsh profile root — an empty entry list; the bundles and cordis.patch.yml compose the app.
[]
`
const WORKSPACE = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
`

/** A plugin of the app, as the profile lists it (app-plugins.ts): its config written into the patch. */
type ProfilePlugin = { name: string, dir: string, config?: Readonly<Record<string, unknown>>, stock?: ReadonlyArray<{ id: string, name: string }> }

/**
 * dsh-base's rows the app relies on for safety, restated whole (as dsh-base writes them, test/dsh-profile.test.js
 * keeps them in step) so a bundle or the user's layer cannot loosen them: the sandbox mode, when to ask, and the
 * permission presets. Patches by id keep the lower layer's `disabled`, so it is stated too.
 */
export const SAFETY_ROWS = `- id: sandbox-policy
  name: '@deepseek-ai/dsh-sandbox-policy'
  disabled: false
  config:
    mode: !!js process.env.DSH_PERMISSION_MODE ?? 'workspace-write'
    workspaceRoot: !!js process.cwd()
- id: approval
  name: '@deepseek-ai/dsh-user-approval'
  disabled: false
  config:
    policy: !!js "(process.env.DSH_PERMISSION_MODE ?? 'workspace-write') === 'danger-full-access' ? 'never' : 'ask'"
- id: permission
  name: '@deepseek-ai/dsh-permission-presets'
  disabled: false
  config:
    presets:
      read-only:
        sandbox: read-only
        approval: ask
      workspace-write:
        sandbox: workspace-write
        approval: ask
      danger-full-access:
        sandbox: danger-full-access
        approval: never
`

/**
 * Plugins the user adds come and go while dsh runs (HMR, which the ACP bundle switches off), through dsh's plugin
 * manager, which runs the given pnpm; its agent tool lets the model ask for the same, each call approved by the user.
 * A company's own registry (plugin-source.ts) is asked alone, with no public one to fall back to, so a name of
 * theirs is never taken from a public registry instead.
 */
function pluginManagerLines(pnpmCommand: string | null, registry: string | null) {
  const manager = { ...(pnpmCommand ? { pnpmCommand } : {}), ...(registry ? { registry, fallbackRegistries: [] } : {}) }
  return [
    '- id: hmr', "  name: '@deepseek-ai/dsh-hmr'", '  disabled: false', '  config:', '    root: []',
    ...(Object.keys(manager).length ? jsonEntry('plugin-manager', manager) : []),
    '- id: tool-plugin-manager', '  disabled: false',
  ]
}
/**
 * dsh's sub-agents, used within a turn only (system-design §11.7): in the foreground, so the main conversation waits
 * for the result in the same turn; with read-only tools for looking things up, by allow list, so tools dsh or a
 * plugin adds later are not given to them; and unable to delegate further. Work that runs long, should be seen by
 * the user or asked about later goes to Viva's background tasks instead. The follow-up tools (send_message,
 * interrupt_agent, list_agents) serve background children only, so they are off.
 */
export const SUBAGENT_TOOLS = Object.freeze(['read', 'glob', 'grep', 'read_image', 'web_search', 'web_fetch', 'memory_recall', 'search_conversations', 'read_conversation', 'todo_write'])
function subagentLines() {
  const shared = { enableRunInBackground: false, backgroundMode: 'one-shot', toolFilter: { allow: SUBAGENT_TOOLS }, maxDepth: 1 }
  return [
    '- id: tool-subagent', "  name: '@deepseek-ai/dsh-tool-subagent'", '  disabled: false',
    `  config: ${JSON.stringify({ provider: 'spawn', toolName: 'subagent', ...shared })}`,
    '- id: tool-subagent-fork', "  name: '@deepseek-ai/dsh-tool-subagent'", '  disabled: false',
    `  config: ${JSON.stringify({ provider: 'fork', toolName: 'subagent_fork', ...shared })}`,
    '- id: tool-subagent-control', '  disabled: true',
    '- id: tool-subagent-list-agents', '  disabled: true',
  ]
}

/** Which models dsh offers (model-providers.ts): the user's providers, DeepSeek with a key, the one to start with. */
type ProfileModels = { providers: Record<string, object>, deepseek: boolean, defaultModel: { provider: string, model: string } | null }
type Persona = { prefix: string, suffix: string }
/** The profile's package.json, as read: what the app does not write is kept. */
type Manifest = { dependencies?: Record<string, string>, dsh?: { profile?: { bundles?: readonly string[], [field: string]: unknown }, [field: string]: unknown }, [field: string]: unknown }

/** YAML single-quoted scalar: only the quote itself needs escaping, backslashes stay as they are. */
const yamlString = (value: unknown) => `'${String(value).replaceAll("'", "''")}'`
const yamlValue = (value: unknown) => (typeof value === 'boolean' || typeof value === 'number' ? String(value) : yamlString(value))

function configLines(config: ProfilePlugin['config'], indent: string) {
  const entries = Object.entries(config ?? {})
  if (entries.length === 0) return []
  return [`${indent}config:`, ...entries.map(([key, value]) => `${indent}  ${key}: ${yamlValue(value)}`)]
}

/** Stock entries the DeepSeek route needs; without a DeepSeek key they are switched off so it is not offered. */
const DEEPSEEK_ENTRIES = Object.freeze(['llm-deepseek', 'llm-deepseek-account'])

/** dsh-base's attachment store (its cordis.patch.yml). */
const ATTACHMENT_ENTRY = Object.freeze({ id: 'attachment-local', name: '@deepseek-ai/dsh-attachment-local' })

/** JSON is YAML too: nested config goes in as one flow value. */
const jsonEntry = (id: string, config: object) => [`- id: ${id}`, `  config: ${JSON.stringify(config)}`]

/**
 * Which models dsh offers: the user's providers as `llm-pi-ai` routes, DeepSeek only with a key, and the
 * model new sessions start with (the `acp` entry's own default otherwise).
 */
function modelLines({ providers, deepseek, defaultModel }: ProfileModels) {
  return [
    ...(Object.keys(providers).length ? jsonEntry('llm-pi-ai', { providers }) : []),
    ...(deepseek ? [] : DEEPSEEK_ENTRIES.flatMap((id) => [`- id: ${id}`, '  disabled: true'])),
    ...(defaultModel ? jsonEntry('acp', { provider: defaultModel.provider, model: defaultModel.model }) : []),
  ]
}

/**
 * Entries named by id are replaced whole (dsh patches by id do not merge), so both persona parts are
 * stated; then the plugins are inserted, with the stock dsh entries they serve.
 */
export function patchFor({ plugins, persona, models, imagesDir = null, pnpmCommand = null, registry = null }: {
  plugins: readonly ProfilePlugin[], persona?: Persona | null, models?: ProfileModels | null, imagesDir?: string | null, pnpmCommand?: string | null,
  registry?: string | null,
}) {
  const lines = [VIVA_LAYER_MARK]
  if (persona) {
    lines.push('- id: system-prompt', '  config:', `    personaPrefix: ${yamlString(persona.prefix)}`, `    personaSuffix: ${yamlString(persona.suffix)}`)
  }
  if (models) lines.push(...modelLines(models))
  // dsh keeps the pictures it sends the model under <dshHome>/attachments and cache/: in Viva's pictures folder,
  // so settings can count, move and empty them with the ones pasted (image-store.js).
  if (imagesDir) lines.push(`- id: ${ATTACHMENT_ENTRY.id}`, `  name: ${yamlString(ATTACHMENT_ENTRY.name)}`, '  config:', `    dshHome: ${yamlString(imagesDir)}`)
  if (plugins.length) {
    lines.push('- insert:')
    // By file URL: the plugins stay where the app keeps them (inside app.asar when installed), so their imports
    // resolve among the app's packages, and the profile's package manager never sees them.
    for (const plugin of plugins) lines.push(`    - id: ${plugin.name}`, `      name: ${yamlString(pathToFileURL(pluginEntry(plugin.dir)).href)}`, ...configLines(plugin.config, '      '))
    for (const entry of plugins.flatMap((plugin) => plugin.stock ?? [])) lines.push(`    - id: ${entry.id}`, `      name: ${yamlString(entry.name)}`)
  }
  lines.push(...pluginManagerLines(pnpmCommand, registry), ...subagentLines())
  return `${lines.join('\n')}\n${SAFETY_ROWS}`
}

/** Writes `text` unless the file already says exactly that. */
function writeIfChanged(file: string, text: string) {
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === text) return
  fs.writeFileSync(file, text)
}

function readManifest(file: string): Manifest {
  if (!fs.existsSync(file)) return {}
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err: any) {
    throw new Error(t("main.dsh-profile.cannot.read.dsh.profile.package.json", { file: file, message: err.message }))
  }
}

const isOurs = (name: string) => name.startsWith(APP_PLUGIN_PREFIX)

/**
 * Keeps whatever else the manifest declares (the plugins the user installed, their bundles); the app's own plugins
 * are no dependencies (they load by file URL).
 */
function manifestFor(current: Manifest) {
  const bundles = current.dsh?.profile?.bundles?.length ? current.dsh.profile.bundles : BUNDLES
  return {
    name: 'dsh-profile-viva',
    ...current,
    private: true,
    dependencies: current.dependencies ?? {},
    dsh: { ...current.dsh, profile: { ...current.dsh?.profile, bundles } },
  }
}

/**
 * The file dsh loads a plugin from: its TypeScript source where it has one (the repository, as the tests run it:
 * Node drops the types, the file being outside node_modules), else the index.js the build wrote (out/plugins).
 */
export function pluginEntry(dir: string): string {
  const source = path.join(dir, 'index.ts')
  return fs.existsSync(source) ? source : path.join(dir, 'index.js')
}
/** The app's layer, beside the profiles; dsh gets it with --patch (config.ts dshLaunch). */
export const vivaLayerFile = (dshHome: string) => path.join(dshHome, 'viva.patch.yml')

/** The user's layer, started empty. */
function ensureUserLayer(file: string) {
  if (!fs.existsSync(file)) fs.writeFileSync(file, EMPTY_LAYER)
}

/** @returns the profile directory */
export function ensureDshProfile({ dshHome, profile, plugins, persona, models, imagesDir, pnpmCommand, source = { registry: null, hasToken: false } }: {
  dshHome: string, profile: string, plugins: readonly ProfilePlugin[],
  persona?: Persona, models?: ProfileModels, imagesDir?: string, pnpmCommand?: string | null,
  /** The company's plugin source (plugin-source.ts), and whether it has a token for .npmrc to name. */
  source?: PluginSourceView,
}): string {
  const bad = plugins.find((plugin) => !isOurs(plugin.name))
  if (bad) throw new Error(t("main.dsh-profile.plugin.names.must.start.with", { APP_PLUGIN_PREFIX: APP_PLUGIN_PREFIX, name: bad.name }))
  const dir = path.join(dshHome, 'profiles', profile)
  fs.mkdirSync(dir, { recursive: true })
  const manifestFile = path.join(dir, 'package.json')
  writeIfChanged(manifestFile, `${JSON.stringify(manifestFor(readManifest(manifestFile)), null, 2)}\n`)
  if (!fs.existsSync(path.join(dir, 'cordis.yml'))) fs.writeFileSync(path.join(dir, 'cordis.yml'), ROOT_CONFIG)
  if (!fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) fs.writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), WORKSPACE)
  ensureUserLayer(path.join(dir, 'cordis.patch.yml'))
  writeIfChanged(vivaLayerFile(dshHome), patchFor({ plugins, persona, models, imagesDir, pnpmCommand, registry: source.registry }))
  const npmrc = path.join(dir, '.npmrc')
  const current = fs.existsSync(npmrc) ? fs.readFileSync(npmrc, 'utf8') : ''
  const next = npmrcWith(current, source.hasToken ? source.registry : null)
  if (next !== current) fs.writeFileSync(npmrc, next)
  return dir
}

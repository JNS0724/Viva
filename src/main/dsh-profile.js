import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * The app's own dsh profile: the stock ACP composition, the app's persona, and the app's plugins
 * (app-plugins.js). It is written before every launch, so a moved app or data file is picked up, and only
 * files that changed are touched. The user's other profiles (including `acp`) are never read or written.
 */
/** The app's plugins are all named like this, so ones dropped from the list can be told apart and removed. */
export const APP_PLUGIN_PREFIX = 'viva-'
/** Same bundles as dsh's own `acp` template (`dsh --from-default-profile acp`). */
const BUNDLES = Object.freeze(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app'])
const ROOT_CONFIG = `# dsh profile root — an empty entry list; the bundles and cordis.patch.yml compose the app.
[]
`
const WORKSPACE = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
`

/** YAML single-quoted scalar: only the quote itself needs escaping, backslashes stay as they are. */
const yamlString = (value) => `'${String(value).replaceAll("'", "''")}'`
const yamlValue = (value) => (typeof value === 'boolean' || typeof value === 'number' ? String(value) : yamlString(value))

function configLines(config, indent) {
  const entries = Object.entries(config ?? {})
  if (entries.length === 0) return []
  return [`${indent}config:`, ...entries.map(([key, value]) => `${indent}  ${key}: ${yamlValue(value)}`)]
}

/** Stock entries the DeepSeek route needs; without a DeepSeek key they are switched off so it is not offered. */
const DEEPSEEK_ENTRIES = Object.freeze(['llm-deepseek', 'llm-deepseek-account'])

/** dsh-base's attachment store (its cordis.patch.yml). */
const ATTACHMENT_ENTRY = Object.freeze({ id: 'attachment-local', name: '@deepseek-ai/dsh-attachment-local' })

/** JSON is YAML too: nested config goes in as one flow value. */
const jsonEntry = (id, config) => [`- id: ${id}`, `  config: ${JSON.stringify(config)}`]

/**
 * Which models dsh offers: the user's providers as `llm-pi-ai` routes, DeepSeek only with a key, and the
 * model new sessions start with (the `acp` entry's own default otherwise).
 * @param {{ providers: Record<string, object>, deepseek: boolean, defaultModel: { provider: string, model: string } | null }} models
 */
function modelLines({ providers, deepseek, defaultModel }) {
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
export function patchFor({ plugins, persona, models, imagesDir = null }) {
  const lines = ['# Written by Viva on every launch; edits here are replaced.']
  if (persona) {
    lines.push('- id: system-prompt', '  config:', `    personaPrefix: ${yamlString(persona.prefix)}`, `    personaSuffix: ${yamlString(persona.suffix)}`)
  }
  if (models) lines.push(...modelLines(models))
  // dsh keeps the pictures it sends the model under <dshHome>/attachments and cache/: in Viva's pictures folder,
  // so settings can count, move and empty them with the ones pasted (image-store.js).
  if (imagesDir) lines.push(`- id: ${ATTACHMENT_ENTRY.id}`, `  name: ${yamlString(ATTACHMENT_ENTRY.name)}`, '  config:', `    dshHome: ${yamlString(imagesDir)}`)
  if (plugins.length) {
    lines.push('- insert:')
    for (const plugin of plugins) lines.push(`    - id: ${plugin.name}`, `      name: ${plugin.name}`, ...configLines(plugin.config, '      '))
    for (const entry of plugins.flatMap((plugin) => plugin.stock ?? [])) lines.push(`    - id: ${entry.id}`, `      name: ${yamlString(entry.name)}`)
  }
  return `${lines.join('\n')}\n`
}

/** Writes `text` unless the file already says exactly that. */
function writeIfChanged(file, text) {
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === text) return
  fs.writeFileSync(file, text)
}

function readManifest(file) {
  if (!fs.existsSync(file)) return {}
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    throw new Error(`dsh profile 的 package.json 无法读取（${file}）：${err.message}`)
  }
}

const isOurs = (name) => name.startsWith(APP_PLUGIN_PREFIX)

/** Keeps whatever else the manifest declares; the app's plugin dependencies are exactly the given ones. */
function manifestFor(current, plugins) {
  const bundles = current.dsh?.profile?.bundles?.length ? current.dsh.profile.bundles : BUNDLES
  const others = Object.fromEntries(Object.entries(current.dependencies ?? {}).filter(([name]) => !isOurs(name)))
  const ours = Object.fromEntries(plugins.map((plugin) => [plugin.name, `link:${plugin.dir}`]))
  return {
    name: 'dsh-profile-viva',
    ...current,
    private: true,
    dependencies: { ...others, ...ours },
    dsh: { ...current.dsh, profile: { ...current.dsh?.profile, bundles } },
  }
}

/** First line of every forwarding package the app writes, so it knows which folders are its own. */
const SHIM_MARK = '// Written by Viva: forwards to the plugin inside the app.'

/** The plugin's manifest, kept as it is (dsh checks its peer versions), pointing at the forwarder. */
function shimManifest({ name, dir }) {
  let manifest = {}
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  } catch {
    // a plugin folder without a manifest (tests): the name is enough
  }
  return { ...manifest, name, type: 'module', main: 'index.js', exports: { '.': './index.js', './package.json': './package.json' }, vivaPlugin: dir }
}

const pluginEntry = (dir) => path.join(dir, 'index.js')
const isShim = (folder) => {
  try {
    return fs.readFileSync(path.join(folder, 'index.js'), 'utf8').startsWith(SHIM_MARK)
  } catch {
    return false
  }
}

/**
 * Puts a small forwarding package at `node_modules/<name>`: its index re-exports the plugin by file URL.
 * The plugin stays where the app keeps it (inside app.asar when installed, where a link cannot point),
 * so its own imports resolve among the app's packages; and no junction is needed on Windows. A link left
 * by an earlier version is replaced; a folder the app did not write is reported, never deleted.
 */
function writeShim(modules, plugin) {
  const folder = path.join(modules, plugin.name)
  const existing = fs.lstatSync(folder, { throwIfNoEntry: false })
  if (existing?.isSymbolicLink()) fs.unlinkSync(folder)
  else if (existing && !isShim(folder)) throw new Error(`${folder} 不是 Viva 写的插件入口，请手动移走后重启`)
  fs.mkdirSync(folder, { recursive: true })
  writeIfChanged(path.join(folder, 'package.json'), `${JSON.stringify(shimManifest(plugin), null, 2)}\n`)
  writeIfChanged(path.join(folder, 'index.js'), `${SHIM_MARK}\nexport * from ${JSON.stringify(pathToFileURL(pluginEntry(plugin.dir)).href)}\n`)
}

/** Entries for app plugins no longer in the list go, so dsh stops loading them. */
function removeDropped(modules, plugins) {
  const keep = new Set(plugins.map((plugin) => plugin.name))
  for (const name of fs.readdirSync(modules).filter((entry) => isOurs(entry) && !keep.has(entry))) {
    const folder = path.join(modules, name)
    if (fs.lstatSync(folder).isSymbolicLink()) fs.unlinkSync(folder)
    else if (isShim(folder)) fs.rmSync(folder, { recursive: true, force: true })
  }
}

/**
 * @param {{
 *   dshHome: string,
 *   profile: string,
 *   plugins: Array<{ name: string, dir: string, config?: Record<string, string | boolean | number> }>,
 *   persona?: { prefix: string, suffix: string },
 *   models?: { providers: Record<string, object>, deepseek: boolean, defaultModel: { provider: string, model: string } | null },
 *   imagesDir?: string,
 * }} options
 * @returns {string} the profile directory
 */
export function ensureDshProfile({ dshHome, profile, plugins, persona, models, imagesDir }) {
  const bad = plugins.find((plugin) => !isOurs(plugin.name))
  if (bad) throw new Error(`插件名必须以 ${APP_PLUGIN_PREFIX} 开头：${bad.name}`)
  const dir = path.join(dshHome, 'profiles', profile)
  const modules = path.join(dir, 'node_modules')
  fs.mkdirSync(modules, { recursive: true })
  const manifestFile = path.join(dir, 'package.json')
  writeIfChanged(manifestFile, `${JSON.stringify(manifestFor(readManifest(manifestFile), plugins), null, 2)}\n`)
  if (!fs.existsSync(path.join(dir, 'cordis.yml'))) fs.writeFileSync(path.join(dir, 'cordis.yml'), ROOT_CONFIG)
  if (!fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) fs.writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), WORKSPACE)
  writeIfChanged(path.join(dir, 'cordis.patch.yml'), patchFor({ plugins, persona, models, imagesDir }))
  removeDropped(modules, plugins)
  for (const plugin of plugins) writeShim(modules, plugin)
  return dir
}

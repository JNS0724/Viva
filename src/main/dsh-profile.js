import fs from 'node:fs'
import path from 'node:path'

/**
 * The app's own dsh profile: the stock ACP composition plus the memory plugin. It is written before every
 * launch, so a moved app or memory.db is picked up, and only files that changed are touched. The user's
 * other profiles (including `acp`) are never read or written.
 */
export const MEMORY_PLUGIN = 'my-agent-memory'
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

function patchFor(memoryFile) {
  return `# Written by my-agent on every launch; edits here are replaced.
- insert:
    - id: ${MEMORY_PLUGIN}
      name: ${MEMORY_PLUGIN}
      config:
        file: ${yamlString(memoryFile)}
`
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

/** Keeps whatever else the manifest declares; only the plugin dependency and a missing bundle list are filled in. */
function manifestFor(current, pluginDir) {
  const bundles = current.dsh?.profile?.bundles?.length ? current.dsh.profile.bundles : BUNDLES
  return {
    name: 'dsh-profile-my-agent',
    ...current,
    private: true,
    dependencies: { ...current.dependencies, [MEMORY_PLUGIN]: `link:${pluginDir}` },
    dsh: { ...current.dsh, profile: { ...current.dsh?.profile, bundles } },
  }
}

/**
 * Points `node_modules/my-agent-memory` at the plugin: a junction on Windows, which needs no admin rights.
 * A real directory in its place is reported, not deleted: it is not ours.
 */
function linkPlugin(profileDir, pluginDir, platform) {
  const modules = path.join(profileDir, 'node_modules')
  const link = path.join(modules, MEMORY_PLUGIN)
  fs.mkdirSync(modules, { recursive: true })
  const existing = fs.lstatSync(link, { throwIfNoEntry: false })
  if (existing && !existing.isSymbolicLink()) throw new Error(`${link} 不是链接，请手动移走后重启`)
  if (existing) {
    if (path.resolve(path.dirname(link), fs.readlinkSync(link)) === path.resolve(pluginDir)) return
    fs.unlinkSync(link)
  }
  fs.symlinkSync(pluginDir, link, platform === 'win32' ? 'junction' : 'dir')
}

/**
 * @param {{ dshHome: string, profile: string, pluginDir: string, memoryFile: string, platform?: string }} options
 * @returns {string} the profile directory
 */
export function ensureDshProfile({ dshHome, profile, pluginDir, memoryFile, platform = process.platform }) {
  const dir = path.join(dshHome, 'profiles', profile)
  fs.mkdirSync(dir, { recursive: true })
  const manifestFile = path.join(dir, 'package.json')
  writeIfChanged(manifestFile, `${JSON.stringify(manifestFor(readManifest(manifestFile), pluginDir), null, 2)}\n`)
  if (!fs.existsSync(path.join(dir, 'cordis.yml'))) fs.writeFileSync(path.join(dir, 'cordis.yml'), ROOT_CONFIG)
  if (!fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) fs.writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), WORKSPACE)
  writeIfChanged(path.join(dir, 'cordis.patch.yml'), patchFor(memoryFile))
  linkPlugin(dir, pluginDir, platform)
  return dir
}

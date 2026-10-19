import fs from 'node:fs'
import path from 'node:path'

/**
 * What the app adds to dsh: its persona, and its plugins with the data contract each one provides.
 * The app talks to a plugin only through that contract (a SQLite file the plugin writes and the app reads),
 * so a plugin can be replaced by any other that provides the same contract version.
 */

/** dsh's ACP template calls the model a coding agent; this app is a personal work assistant. */
export const PERSONA = Object.freeze({
  prefix: [
    '你是用户的个人工作助手，运行在用户自己的电脑上，由 {{model}} 模型驱动。',
    '你帮助用户处理日常工作：写作、整理资料、检索信息、分析问题和编程。用用户使用的语言回答。',
    '涉及对外发送的事（邮件、即时消息等），你只起草，由用户自己决定是否发送。',
  ].join(''),
  suffix: '你的工作目录是 {{cwd}}。',
})

/** The contract versions this app reads and writes. A plugin must provide exactly these. */
export const CONTRACTS = Object.freeze({ memory: 1, trace: 1, policy: 1 })

/** config: built from the app's data directory, written into the profile for the plugin. */
export const APP_PLUGINS = Object.freeze([
  { name: 'viva-memory', dir: 'plugins/memory', contract: 'memory', config: ({ userData }) => ({ file: path.join(userData, 'memory.db') }) },
  { name: 'viva-trace', dir: 'plugins/trace', contract: 'trace', config: ({ userData }) => ({ file: path.join(userData, 'trace.db') }) },
  { name: 'viva-policy', dir: 'plugins/policy', contract: 'policy', config: () => ({}) },
])

/** The dsh version installed with the app; plugins pin their dsh peers to it. */
export function installedDshVersion(appRoot) {
  const manifest = path.join(appRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  return JSON.parse(fs.readFileSync(manifest, 'utf8')).version
}

/** dsh refuses a plugin whose exact dsh peers differ from its own version; say so before it does. */
function peerProblem(peers, dshVersion) {
  const pinned = Object.entries(peers ?? {}).filter(([name, range]) => name.startsWith('@deepseek-ai/dsh') && /^\d/.test(range))
  const stale = pinned.find(([, range]) => range !== dshVersion)
  return stale ? `需要 dsh ${stale[1]}，当前是 ${dshVersion}` : null
}

/**
 * @returns {string | null} why the plugin can't be used, or null when it can
 */
export function pluginProblem(plugin, { dir, dshVersion }) {
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  } catch {
    return '找不到插件，或者它的 package.json 无法读取'
  }
  if (manifest.name !== plugin.name) return `插件名是 ${manifest.name}，应为 ${plugin.name}`
  const provided = manifest.viva?.contract?.[plugin.contract]
  if (provided !== CONTRACTS[plugin.contract]) {
    return `约定 ${plugin.contract} 的版本是 ${provided ?? '（未声明）'}，应用需要 ${CONTRACTS[plugin.contract]}`
  }
  return peerProblem(manifest.peerDependencies, dshVersion)
}

/**
 * The plugins to put in the profile, with their config, and the ones left out with the reason.
 * @returns {{ plugins: Array<{ name: string, dir: string, config: object }>, problems: Array<{ name: string, contract: string, problem: string }> }}
 */
export function resolvePlugins({ appRoot, userData, dshVersion, plugins = APP_PLUGINS }) {
  return plugins.reduce(({ plugins: usable, problems }, plugin) => {
    const dir = path.join(appRoot, plugin.dir)
    const problem = pluginProblem(plugin, { dir, dshVersion })
    return problem
      ? { plugins: usable, problems: [...problems, { name: plugin.name, contract: plugin.contract, problem }] }
      : { plugins: [...usable, { name: plugin.name, dir, config: plugin.config({ userData }) }], problems }
  }, { plugins: [], problems: [] })
}

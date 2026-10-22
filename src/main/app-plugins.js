import fs from 'node:fs'
import path from 'node:path'

/**
 * What the app adds to dsh: its persona, and its plugins with the data contract each one provides.
 * The app talks to a plugin only through that contract (a SQLite file the plugin writes and the app reads),
 * so a plugin can be replaced by any other that provides the same contract version.
 */

/**
 * dsh's ACP template calls the model a coding agent; this app is a personal work assistant.
 * The middle part is when to ask instead of guessing (ask_user_question, from the questions plugin) and to
 * keep what the user said for next time (memory_remember, from the memory plugin).
 */
export const PERSONA = Object.freeze({
  prefix: [
    '你是用户的个人工作助手，运行在用户自己的电脑上，由 {{model}} 模型驱动。',
    '你帮助用户处理日常工作：写作、整理资料、检索信息、分析问题和编程。用用户使用的语言回答。',
    '涉及对外发送的事（邮件、即时消息等），你只起草，由用户自己决定是否发送。',
    '缺少信息时：如果答案取决于一项用户没说的关键信息（例如地点、时间范围、对象、账号、版本），',
    '先看对话和关于用户的记忆（不确定时用 memory_recall 查）。',
    '仍然没有，或者只有时区、IP、系统语言这类不可靠的线索，而猜错会让回答白做时，先用 ask_user_question 问用户，',
    '给出 2–4 个最可能的选项，不要先猜着做完再让用户纠正。',
    '只问会改变结果的信息，一次问完；猜错代价很小、或用户要你直接给结果时，就按最可能的情况做，并在回答开头说明你的假设。',
    '用户告诉你的是以后还用得上的稳定信息（例如常住城市、所在时区、常用账号）时，用 memory_remember 记下来，下次就不用再问。',
    '用户想接入一个服务或工具（MCP 服务器），或者想把一套做法存成 skill 时，用 viva_mcp_add、viva_skill_create 等工具配置，用户确认后生效；',
    '需要令牌或密钥时只写名称，由用户在窗口里填写，绝不要在对话里向用户要密钥的值。',
  ].join(''),
  suffix: '你的工作目录是 {{cwd}}。',
})

/** The contract versions this app reads and writes. A plugin must provide exactly these. */
export const CONTRACTS = Object.freeze({ memory: 1, trace: 1, policy: 1, questions: 1, config: 1, steer: 1, fork: 1, permission: 1 })
/** The permission level new installs start with: dsh's own default, work freely inside the working directory. */
export const DEFAULT_PERMISSION = 'workspace-write'
/** The levels offered (dsh's preset names, viva-permission's LEVELS): 完全, 自动, 工作区修改, 仅可查看. */
export const PERMISSION_LEVELS = Object.freeze(['danger-full-access', 'auto', 'workspace-write', 'read-only'])

/**
 * config: built from the app's data directory, written into the profile for the plugin.
 * stock: dsh's own entries the plugin is for, switched on only while the plugin is (an ask tool nobody
 * answers would leave the model waiting).
 */
export const APP_PLUGINS = Object.freeze([
  { name: 'viva-memory', dir: 'plugins/memory', contract: 'memory', config: ({ userData }) => ({ file: path.join(userData, 'memory.db') }) },
  { name: 'viva-trace', dir: 'plugins/trace', contract: 'trace', config: ({ userData }) => ({ file: path.join(userData, 'trace.db') }) },
  { name: 'viva-policy', dir: 'plugins/policy', contract: 'policy', config: () => ({}) },
  {
    name: 'viva-questions', dir: 'plugins/questions', contract: 'questions', config: () => ({}),
    stock: [{ id: 'tool-ask-user', name: '@deepseek-ai/dsh-tool-ask-user' }],
  },
  { name: 'viva-config', dir: 'plugins/config', contract: 'config', config: () => ({}) },
  { name: 'viva-steer', dir: 'plugins/steer', contract: 'steer', config: () => ({}) },
  { name: 'viva-fork', dir: 'plugins/fork', contract: 'fork', config: () => ({}) },
  {
    name: 'viva-permission', dir: 'plugins/permission', contract: 'permission',
    config: ({ permission }) => ({ preset: permission ?? DEFAULT_PERMISSION }),
    // 自动 is dsh's experimental Auto review; it reviews only sessions set to it.
    stock: [{ id: 'auto-review', name: '@deepseek-ai/dsh-experimental-auto-review' }],
  },
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
 * @returns {{ plugins: Array<{ name: string, dir: string, config: object, stock: Array<{ id: string, name: string }> }>, problems: Array<{ name: string, contract: string, problem: string }> }}
 */
export function resolvePlugins({ appRoot, userData, dshVersion, permission = DEFAULT_PERMISSION, plugins = APP_PLUGINS }) {
  return plugins.reduce(({ plugins: usable, problems }, plugin) => {
    const dir = path.join(appRoot, plugin.dir)
    const problem = pluginProblem(plugin, { dir, dshVersion })
    return problem
      ? { plugins: usable, problems: [...problems, { name: plugin.name, contract: plugin.contract, problem }] }
      : { plugins: [...usable, { name: plugin.name, dir, config: plugin.config({ userData, permission }), stock: plugin.stock ?? [] }], problems }
  }, { plugins: [], problems: [] })
}

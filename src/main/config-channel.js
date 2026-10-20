/**
 * MCP servers and skills set up from the conversation, on the app's side of the config contract (version 1,
 * see plugins/config/lib/channel.js). The plugin asks only after the user approved the change on the card;
 * this desk checks the request, asks the window for any keys it names (their values never go back to dsh),
 * and performs it through `actions`, which main.js backs with the MCP store and the skills folder.
 */
const OPS = new Set(['mcp_list', 'mcp_add', 'mcp_remove', 'skill_list', 'skill_create', 'skill_install', 'skill_remove'])
const MAX_ID_CHARS = 128
const MAX_NAME_CHARS = 60
const MAX_COMMAND_CHARS = 500
const MAX_ARGS = 50
const MAX_ARG_CHARS = 1000
const MAX_URL_CHARS = 2000
const MAX_SECRETS = 10
const MAX_SECRET_VALUE_CHARS = 4000
const MAX_DESCRIPTION_CHARS = 300
const MAX_INSTRUCTIONS_CHARS = 20_000
const MAX_PATH_CHARS = 1000
const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,127}$/
/** dsh's own rule for skill names (dsh-skill). */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

class Refused extends Error {}
const refuse = (message) => { throw new Refused(message) }

function text(value, what, max, { optional = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (optional) return ''
    refuse(`缺少${what}`)
  }
  if (typeof value !== 'string') refuse(`${what}要是文字`)
  if (value.length > max) refuse(`${what}太长了（上限 ${max} 字）`)
  return value.trim()
}

function list(value, what, { max, itemMax, pattern }) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > max) refuse(`${what}最多 ${max} 项`)
  return value.map((item) => {
    if (typeof item !== 'string' || item.length > itemMax) refuse(`${what}里有一项不对`)
    if (pattern && !pattern.test(item)) refuse(`${what}不合法：${item.slice(0, 40)}`)
    return item
  })
}

function skillName(name) {
  if (!SKILL_NAME.test(name)) refuse('skill 名字只能用英文小写字母、数字和连字符，例如 weekly-report')
  return name
}

/** Each operation's arguments, checked and reduced to what it uses. */
const ARGS = {
  mcp_list: () => ({}),
  mcp_add: (args) => {
    const spec = {
      name: text(args.name, '服务器名称', MAX_NAME_CHARS),
      command: text(args.command, '启动命令', MAX_COMMAND_CHARS, { optional: true }),
      args: list(args.args, '启动参数', { max: MAX_ARGS, itemMax: MAX_ARG_CHARS }),
      url: text(args.url, '服务器地址', MAX_URL_CHARS, { optional: true }),
      secrets: list(args.secrets, '密钥名', { max: MAX_SECRETS, itemMax: 128, pattern: SECRET_NAME }),
    }
    if (Boolean(spec.command) === Boolean(spec.url)) refuse('启动命令和服务器地址要二选一')
    return spec
  },
  mcp_remove: (args) => ({ name: text(args.name, '服务器名称', MAX_NAME_CHARS) }),
  skill_list: () => ({}),
  skill_create: (args) => ({
    name: skillName(text(args.name, 'skill 名字', MAX_NAME_CHARS)),
    description: text(args.description, 'skill 说明', MAX_DESCRIPTION_CHARS),
    instructions: text(args.instructions, '具体做法', MAX_INSTRUCTIONS_CHARS),
  }),
  skill_install: (args) => ({ path: text(args.path, '路径', MAX_PATH_CHARS) }),
  skill_remove: (args) => ({ id: text(args.id, 'skill 的 id', MAX_PATH_CHARS) }),
}

const isId = (value) => typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_CHARS

/**
 * @returns {{ id: string, sessionId: string, op: string, args: object } | { id: string, problem: string } | null}
 *   null when there is no id to answer
 */
export function parseConfigRequest(message) {
  if (message?.type !== 'config' || !isId(message.id)) return null
  const { id } = message
  if (!OPS.has(message.op)) return { id, problem: `不支持的配置操作：${String(message.op).slice(0, 40)}` }
  try {
    const args = ARGS[message.op](message.args && typeof message.args === 'object' ? message.args : {})
    return { id, sessionId: String(message.sessionId ?? ''), op: message.op, args }
  } catch (err) {
    if (err instanceof Refused) return { id, problem: err.message }
    throw err
  }
}

/** The keys as typed: one for every name asked, each on one line. */
function checkSecrets(names, values) {
  return Object.fromEntries(names.map((name) => {
    const value = values?.[name]
    if (typeof value !== 'string' || !value.trim()) throw new Error(`请填写 ${name}`)
    if (/[\r\n]/.test(value)) throw new Error(`${name} 要写在一行里`)
    if (value.length > MAX_SECRET_VALUE_CHARS) throw new Error(`${name} 太长了`)
    return [name, value.trim()]
  }))
}

const bullet = (items) => items.map((item) => `- ${item}`).join('\n')

/**
 * @param {{
 *   send: (message: object) => void, emit: (event: object) => void, sessionId: () => string | null,
 *   actions: {
 *     listServers(): string[], prepareServer(spec: object): void, addServer(spec: object, secrets: Record<string, string>): string,
 *     removeServer(name: string): string, listSkills(): string[], createSkill(spec: object): string,
 *     installSkill(path: string): string, removeSkill(id: string): Promise<string> | string,
 *   },
 * }} io send: to the plugin; emit: to the window; sessionId: the conversation on screen
 */
export function createConfigDesk({ send, emit, sessionId, actions }) {
  /** Servers waiting for the user's keys, by request id. */
  const pending = new Map()

  const reply = (id, ok, text) => send({ type: 'config_result', id, ok, text })

  async function perform(id, op, args) {
    try {
      reply(id, true, await RUN[op](args))
    } catch (err) {
      reply(id, false, err?.message ?? String(err))
    }
  }

  const RUN = {
    mcp_list: () => {
      const servers = actions.listServers()
      return servers.length ? `已接入的 MCP 服务器：\n${bullet(servers)}` : '用户还没有接入任何 MCP 服务器。'
    },
    mcp_add: (spec) => actions.addServer(spec, {}),
    mcp_remove: ({ name }) => actions.removeServer(name),
    skill_list: () => {
      const skills = actions.listSkills()
      return skills.length ? `用户的 skill：\n${bullet(skills)}` : '用户还没有 skill。'
    },
    skill_create: (spec) => actions.createSkill(spec),
    skill_install: ({ path }) => actions.installSkill(path),
    skill_remove: ({ id }) => actions.removeSkill(id),
  }

  /** A message from the plugin. */
  function receive(message) {
    if (message?.type === 'config_closed') {
      if (pending.delete(message.id)) emit({ type: 'secret_closed', requestId: message.id })
      return
    }
    const request = parseConfigRequest(message)
    if (!request) return
    if (request.problem) return reply(request.id, false, request.problem)
    if (request.sessionId !== sessionId()) return reply(request.id, false, '用户已经离开了这段对话，配置没有进行。')
    const { id, op, args } = request
    if (op !== 'mcp_add' || args.secrets.length === 0) return perform(id, op, args)
    try {
      actions.prepareServer(args)
    } catch (err) {
      return reply(id, false, err?.message ?? String(err))
    }
    pending.set(id, args)
    emit({ type: 'secret_request', requestId: id, server: args.name, names: args.secrets })
  }

  /**
   * The user filled in the keys (or declined with null).
   * @returns {boolean} false when nothing waits for them any more; throws when they do not fit
   */
  function provideSecrets(requestId, values) {
    const spec = pending.get(requestId)
    if (!spec) return false
    if (values === null) {
      pending.delete(requestId)
      reply(requestId, false, `用户没有填写密钥，「${spec.name}」没有接入。`)
      return true
    }
    const secrets = checkSecrets(spec.secrets, values)
    pending.delete(requestId)
    Promise.resolve()
      .then(() => actions.addServer(spec, secrets))
      .then((text) => reply(requestId, true, text), (err) => reply(requestId, false, err?.message ?? String(err)))
    return true
  }

  /** The conversation is left (or dsh is going away): no key is asked for any more. */
  function closeAll() {
    for (const [requestId, spec] of [...pending]) {
      pending.delete(requestId)
      reply(requestId, false, `用户离开了这段对话，「${spec.name}」没有接入。`)
      emit({ type: 'secret_closed', requestId })
    }
  }

  return { receive, provideSecrets, closeAll }
}

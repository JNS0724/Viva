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
const refuse = (message: string): never => { throw new Refused(message) }

function text(value: unknown, what: string, max: number, { optional = false } = {}): string {
  if (value === undefined || value === null || value === '') {
    if (optional) return ''
    refuse(`缺少${what}`)
  }
  if (typeof value !== 'string') refuse(`${what}要是文字`)
  const given = value as string
  if (given.length > max) refuse(`${what}太长了（上限 ${max} 字）`)
  return given.trim()
}

function list(value: unknown, what: string, { max, itemMax, pattern }: { max: number, itemMax: number, pattern?: RegExp }): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > max) refuse(`${what}最多 ${max} 项`)
  return (value as unknown[]).map((item) => {
    if (typeof item !== 'string' || item.length > itemMax) refuse(`${what}里有一项不对`)
    const given = item as string
    if (pattern && !pattern.test(given)) refuse(`${what}不合法：${given.slice(0, 40)}`)
    return given
  })
}

function skillName(name: string): string {
  if (!SKILL_NAME.test(name)) refuse('skill 名字只能用英文小写字母、数字和连字符，例如 weekly-report')
  return name
}

/** An MCP server the model asked for; `secrets` names the keys the user is asked to type. */
export interface ServerSpec { name: string, command: string, args: string[], url: string, secrets: string[] }

/** Each operation's arguments, checked and reduced to what it uses. */
const ARGS: Record<string, (args: any) => any> = {
  mcp_list: () => ({}),
  mcp_add: (args): ServerSpec => {
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

const isId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_CHARS

/** A request as checked: to perform, or to answer with why not. */
export type ConfigRequest = { id: string, sessionId: string, op: string, args: any } | { id: string, problem: string }

/** @returns null when there is no id to answer */
export function parseConfigRequest(message: any): ConfigRequest | null {
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
function checkSecrets(names: readonly string[], values: any): Record<string, string> {
  return Object.fromEntries(names.map((name) => {
    const value = values?.[name]
    if (typeof value !== 'string' || !value.trim()) throw new Error(`请填写 ${name}`)
    if (/[\r\n]/.test(value)) throw new Error(`${name} 要写在一行里`)
    if (value.length > MAX_SECRET_VALUE_CHARS) throw new Error(`${name} 太长了`)
    return [name, value.trim()]
  }))
}

const bullet = (items: readonly string[]) => items.map((item) => `- ${item}`).join('\n')

/** What main.js does for the desk, with the MCP store and the skills folder. */
export interface ConfigActions {
  listServers(): string[]
  prepareServer(spec: ServerSpec): void
  addServer(spec: ServerSpec, secrets: Record<string, string>): string
  removeServer(name: string): string
  listSkills(): string[]
  createSkill(spec: { name: string, description: string, instructions: string }): string
  installSkill(path: string): string
  removeSkill(id: string): Promise<string> | string
}

/**
 * send: to the plugin; emit: to the window; sessionId: the conversation on screen.
 */
export function createConfigDesk({ send, emit, sessionId, actions }: {
  send: (message: object) => void, emit: (event: { type: string, [field: string]: unknown }) => void, sessionId: () => string | null, actions: ConfigActions,
}) {
  /** Servers waiting for the user's keys, by request id. */
  const pending = new Map<string, ServerSpec>()

  const reply = (id: string, ok: boolean, text: string) => send({ type: 'config_result', id, ok, text })

  async function perform(id: string, op: string, args: any): Promise<void> {
    try {
      reply(id, true, await RUN[op](args))
    } catch (err: any) {
      reply(id, false, err?.message ?? String(err))
    }
  }

  const RUN: Record<string, (args: any) => string | Promise<string>> = {
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
  function receive(message: any): void | Promise<void> {
    if (message?.type === 'config_closed') {
      if (pending.delete(message.id)) emit({ type: 'secret_closed', requestId: message.id })
      return
    }
    const request = parseConfigRequest(message)
    if (!request) return
    if ('problem' in request) return reply(request.id, false, request.problem)
    if (request.sessionId !== sessionId()) return reply(request.id, false, '用户已经离开了这段对话，配置没有进行。')
    const { id, op, args } = request
    if (op !== 'mcp_add' || args.secrets.length === 0) return perform(id, op, args)
    try {
      actions.prepareServer(args)
    } catch (err: any) {
      return reply(id, false, err?.message ?? String(err))
    }
    pending.set(id, args)
    emit({ type: 'secret_request', requestId: id, server: args.name, names: args.secrets })
  }

  /**
   * The user filled in the keys (or declined with null).
   * @returns false when nothing waits for them any more; throws when they do not fit
   */
  function provideSecrets(requestId: string, values: Record<string, unknown> | null): boolean {
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
  function closeAll(): void {
    for (const [requestId, spec] of [...pending]) {
      pending.delete(requestId)
      reply(requestId, false, `用户离开了这段对话，「${spec.name}」没有接入。`)
      emit({ type: 'secret_closed', requestId })
    }
  }

  return { receive, provideSecrets, closeAll }
}

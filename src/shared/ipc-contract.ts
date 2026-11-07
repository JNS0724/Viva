import { z } from 'zod'

/**
 * What the window (preload.cjs) and the desktop island (desk-preload.cjs) may send the main process, channel
 * by channel: the outline of the arguments, with bounds loose enough for every real use. It is the first gate:
 * a page that sends anything else is refused here, in one place, before a handler runs. The handlers still
 * check what the values mean (an id that exists, a path inside the workspace, words within their limit).
 * test/ipc-contract.test.js keeps this table, the preload scripts and the handlers in step.
 */
const MAX_TEXT_CHARS = 200_000
const MAX_ID_CHARS = 1_000
const MAX_PATH_CHARS = 4_096
const MAX_LIST = 5_000
const MAX_IMAGES = 50

const text = z.string().max(MAX_TEXT_CHARS)
const id = z.string().max(MAX_ID_CHARS)
const path = z.string().max(MAX_PATH_CHARS)
const count = z.number().int().nonnegative()
const record = z.looseObject({})
const images = z.array(z.looseObject({ id })).max(MAX_IMAGES)
const bytes = z.union([z.instanceof(Uint8Array), z.instanceof(ArrayBuffer)])
const none = z.tuple([])
const QUERY = 'query'
/** A channel that only reads (QUERY_CHANNELS below): said here, where the channel is defined, not in a list apart. */
const read = <T extends z.ZodType>(schema: T): T => schema.describe(QUERY) as T

/** Each channel's arguments after the event, as a tuple; a trailing `.optional()` may be left out. */
export const IPC_ARGS = Object.freeze({
  'language:get': read(none),
  'language:set': z.tuple([z.enum(['system', 'zh-CN', 'en'])]),
  'agent:info': read(none),
  'agent:waits': read(none),
  'agent:prompt': z.tuple([text, images.optional()]),
  'agent:steer': z.tuple([text]),
  'agent:cancel': none,
  'agent:new-session': none,
  'agent:set-config': z.tuple([id, id]),
  'agent:permission': z.tuple([id, id.nullable()]),
  'agent:answer': z.tuple([id, z.array(record).max(MAX_LIST)]),
  'agent:secrets': z.tuple([id, z.record(z.string(), z.unknown()).nullable()]),

  'shell:open-link': z.tuple([path]),
  'settings:get': read(none),
  'settings:save-key': z.tuple([id]),
  'settings:clear-key': none,
  'settings:set-desk-island': z.tuple([z.boolean()]),
  'settings:set-permission': z.tuple([id]),
  'settings:set-open-at-login': z.tuple([z.boolean()]),
  'settings:reset-desk-place': none,

  'images:keep': z.tuple([bytes]),
  'images:usage': read(none),
  'images:open-folder': none,
  'images:clear': none,
  'images:move': none,

  'models:get': read(none),
  'models:add': z.tuple([record]),
  'models:update': z.tuple([id, record]),
  'models:remove': z.tuple([id]),
  'models:discover': read(z.tuple([record, id.optional()])),

  'history:load': read(none),
  'history:save': z.tuple([z.array(record).max(MAX_LIST)]),
  'history:list': read(z.tuple([count.optional()])),
  'history:search': read(z.tuple([text])),
  'history:resume-topic': z.tuple([id]),
  'history:resume-check': read(z.tuple([id])),
  'history:continue-from-records': z.tuple([id, path]),
  'history:trace': read(z.tuple([id, z.number().optional()])),
  'history:rename': z.tuple([id, text]),
  'history:pin': z.tuple([id, z.boolean()]),
  'history:delete': z.tuple([id]),
  'history:restore': z.tuple([id]),
  'history:export': z.tuple([id]),
  'history:segments-before': read(z.tuple([id, count.optional()])),
  'history:search-messages': read(z.tuple([text])),
  'history:review': read(z.tuple([z.object({ lastAt: z.number(), topicId: id }).nullable().optional(), z.enum(['all', 'tasks', 'files']).optional()])),
  'history:read': read(z.tuple([id, z.object({
    from: count.optional(), around: z.object({ segmentId: id, seq: count }).optional(), count: count.optional(), whole: z.boolean().optional(),
  }).optional()])),
  'history:locate': read(z.tuple([z.object({ segmentId: id, seq: count, messageId: count.optional() })])),
  'history:star': z.tuple([id, count, z.boolean()]),
  'history:stars-in': read(z.tuple([z.array(id).max(MAX_LIST)])),
  'history:starred': read(none),

  'timeline:rewind': z.tuple([record]),
  'timeline:rewind-effects': read(z.tuple([record])),
  'timeline:folded': read(z.tuple([id])),
  'timeline:switch-path': z.tuple([id]),

  'task:start': z.tuple([record]),
  'task:finished': read(none),
  'task:close': z.tuple([id]),
  'task:stop': z.tuple([id]),

  'workdir:get': read(none),
  'workdir:choose': none,
  'workdir:switch': z.tuple([path, record.optional()]),
  'workdir:forget': z.tuple([path]),
  'workdir:reveal': none,

  'memory:get': read(none),
  'memory:list': read(z.tuple([text.optional()])),
  'memory:set-profile': z.tuple([z.record(z.string(), z.unknown())]),
  'memory:add': z.tuple([text, id.optional()]),
  'memory:update': z.tuple([z.number(), text]),
  'memory:delete': z.tuple([z.number()]),
  'memory:restore': z.tuple([record]),
  'memory:list-invalid': read(none),
  'memory:revive': z.tuple([z.number()]),
  'memory:onboarding': z.tuple([id]),
  'memory:add-docs': none,

  'files:list': read(z.tuple([path])),
  'files:preview': read(z.tuple([path, count.optional()])),
  'files:reveal': z.tuple([path]),
  'files:apps': read(z.tuple([path])),
  'files:open': z.tuple([path, path.nullable().optional()]),
  'files:image': read(z.tuple([path])),
  'files:watch': z.tuple([path.nullable()]),

  'ext:get': read(none),
  'ext:remove-mcp': z.tuple([id]),
  'ext:update-mcp': z.tuple([id, record]),
  'ext:import-dsh': z.tuple([z.enum(['default', 'last', 'choose'])]),
  'ext:remove-skill': z.tuple([id]),
  'ext:reveal-skill': z.tuple([id]),
  'ext:skill-sources': read(none),
  'ext:scan-skills': z.tuple([id]),
  'ext:import-skills': z.tuple([id, z.array(id).max(MAX_LIST)]),

  'plugins:get': read(none),
  'plugins:inspect': read(z.tuple([path])),
  'plugins:install': z.tuple([path, z.array(id).max(50).optional()]),
  'plugins:remove': z.tuple([id]),
  'plugins:set-enabled': z.tuple([id, z.boolean()]),

  'schedules:list': read(none),
  'schedules:accept': z.tuple([id]),
  'schedules:decline': z.tuple([id]),
  'schedules:pause': z.tuple([id, z.boolean()]),
  'schedules:delete': z.tuple([id]),
  'feed:list': read(none),
  'feed:seen': z.tuple([id]),

  'island:view': read(z.tuple([record])),
  'island:act': z.tuple([record]),
  'island:files': read(z.tuple([z.array(path).max(MAX_LIST)])),
  'island:ask': z.tuple([record]),
  'island:keep-image': z.tuple([bytes]),
})

export type Channel = keyof typeof IPC_ARGS

/**
 * The channels that only read, marked `read(...)` in IPC_ARGS: no state of the backend changes when a page asks them,
 * so they are no signal of the event core (src/backend/commands.ts). Every other channel is something the user did,
 * recorded as a signal first.
 */
export const QUERY_CHANNELS: ReadonlySet<Channel> = new Set(
  (Object.entries(IPC_ARGS) as Array<[Channel, z.ZodType]>).filter(([, schema]) => schema.description === QUERY).map(([channel]) => channel),
)
/** What a page sends on a channel, as the handler receives it. */
export type ChannelArgs<C extends Channel> = z.input<(typeof IPC_ARGS)[C]>

/**
 * Why `args` do not fit `channel`, or null when they do. A trailing argument the page left undefined counts as
 * left out (ipcRenderer.invoke('history:list', undefined) arrives as [undefined]).
 */
export function argsProblem(channel: string, args: readonly unknown[]): string | null {
  const schema: z.ZodType | undefined = (IPC_ARGS as Readonly<Record<string, z.ZodType>>)[channel]
  if (!schema) return `unknown channel ${channel}`
  let given = args
  while (given.length > 0 && given[given.length - 1] === undefined) given = given.slice(0, -1)
  const result = schema.safeParse(given)
  if (result.success) return null
  const issue = result.error.issues[0]
  return `invalid ${channel} arguments: ${issue.path.length ? `#${issue.path.join('.')} ` : ''}${issue.message}`
}

type Listener = (event: any, ...args: any[]) => unknown
/** A listener on `channel`: the event, then what the page sent, as the table says it is once checked. */
type ChannelListener<C extends Channel> = (event: any, ...args: ChannelArgs<C>) => unknown

/** What of Electron's ipcMain the gate wraps. */
export interface RawIpc {
  handle: (channel: string, listener: Listener) => void
  on: (channel: string, listener: Listener) => void
}

/** What every register*Ipc is given: only channels in the table, each listener taking that channel's arguments. */
export interface IpcRegistry {
  handle: <C extends Channel>(channel: C, listener: ChannelListener<C>) => void
  on: <C extends Channel>(channel: C, listener: ChannelListener<C>) => void
}

/**
 * `ipcMain` with every message checked against IPC_ARGS before its listener runs, given to every register*Ipc.
 * A channel missing from the table is refused when it is registered, so none can go unchecked. What fits goes
 * on unchanged: the gate never rewrites what the page sent.
 */
export function checkedIpc(ipcMain: RawIpc, { onRefused = () => {} }: { onRefused?: (channel: string, problem: string) => void } = {}): IpcRegistry {
  const known = (channel: string) => {
    if (!Object.hasOwn(IPC_ARGS, channel)) throw new Error(`IPC channel ${channel} has no entry in ipc-contract.ts`)
  }
  return {
    handle(channel, listener) {
      known(channel)
      ipcMain.handle(channel, (event, ...args) => {
        const problem = argsProblem(channel, args)
        if (problem) {
          onRefused(channel, problem)
          throw new Error(problem)
        }
        return (listener as Listener)(event, ...args)
      })
    },
    /** One-way messages have no one to answer; what does not fit is dropped. */
    on(channel, listener) {
      known(channel)
      ipcMain.on(channel, (event, ...args) => {
        const problem = argsProblem(channel, args)
        if (problem) return onRefused(channel, problem)
        return (listener as Listener)(event, ...args)
      })
    },
  }
}

/** handle without the event, for the modules whose handlers only read what the page sent. */
export function handlerOf(ipcMain: Pick<IpcRegistry, 'handle'>) {
  return <C extends Channel>(channel: C, listener: (...args: ChannelArgs<C>) => unknown) =>
    ipcMain.handle(channel, (_event, ...args) => listener(...args))
}

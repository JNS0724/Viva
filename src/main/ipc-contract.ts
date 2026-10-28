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

/** Each channel's arguments after the event, as a tuple; a trailing `.optional()` may be left out. */
export const IPC_ARGS = Object.freeze({
  'agent:info': none,
  'agent:prompt': z.tuple([text, images.optional()]),
  'agent:steer': z.tuple([text]),
  'agent:cancel': none,
  'agent:new-session': none,
  'agent:set-config': z.tuple([id, id]),
  'agent:permission': z.tuple([id, id.nullable()]),
  'agent:answer': z.tuple([id, z.array(record).max(MAX_LIST)]),
  'agent:secrets': z.tuple([id, z.record(z.string(), z.unknown()).nullable()]),

  'shell:open-link': z.tuple([path]),
  'settings:get': none,
  'settings:save-key': z.tuple([id]),
  'settings:clear-key': none,
  'settings:set-desk-island': z.tuple([z.boolean()]),
  'settings:set-permission': z.tuple([id]),
  'settings:set-open-at-login': z.tuple([z.boolean()]),
  'settings:reset-desk-place': none,

  'images:keep': z.tuple([bytes]),
  'images:usage': none,
  'images:open-folder': none,
  'images:clear': none,
  'images:move': none,

  'models:get': none,
  'models:add': z.tuple([record]),
  'models:remove': z.tuple([id]),

  'history:load': none,
  'history:save': z.tuple([z.array(record).max(MAX_LIST)]),
  'history:list': z.tuple([count.optional()]),
  'history:search': z.tuple([text]),
  'history:open': z.tuple([id]),
  'history:resume-topic': z.tuple([id]),
  'history:trace': z.tuple([id, z.number().optional()]),
  'history:rename': z.tuple([id, text]),
  'history:pin': z.tuple([id, z.boolean()]),
  'history:delete': z.tuple([id]),
  'history:restore': z.tuple([id]),
  'history:export': z.tuple([id]),
  'history:segments-before': z.tuple([id, count.optional()]),
  'history:search-messages': z.tuple([text]),
  'history:review': z.tuple([z.object({ lastAt: z.number(), topicId: id }).nullable().optional(), z.enum(['all', 'tasks', 'files']).optional()]),
  'history:read': z.tuple([id, z.object({
    from: count.optional(), around: z.object({ segmentId: id, seq: count }).optional(), count: count.optional(), whole: z.boolean().optional(),
  }).optional()]),
  'history:locate': z.tuple([z.object({ segmentId: id, seq: count, messageId: count.optional() })]),
  'history:star': z.tuple([id, count, z.boolean()]),
  'history:stars-in': z.tuple([z.array(id).max(MAX_LIST)]),
  'history:starred': none,

  'timeline:rewind': z.tuple([record]),
  'timeline:rewind-effects': z.tuple([record]),
  'timeline:folded': z.tuple([id]),
  'timeline:switch-path': z.tuple([id]),

  'task:spin-off': z.tuple([record]),
  'task:start': z.tuple([record]),
  'task:save': z.tuple([id, z.array(record).max(MAX_LIST), record.optional()]),
  'task:unfinished': none,
  'task:finished': none,
  'task:ask': z.tuple([id, text]),
  'task:resume': z.tuple([id]),
  'task:forget': z.tuple([id]),
  'task:undo': z.tuple([id]),
  'task:close': z.tuple([id]),
  'task:stop': z.tuple([id]),
  'task:steer': z.tuple([id, text]),

  'workdir:get': none,
  'workdir:choose': none,
  'workdir:switch': z.tuple([path, record.optional()]),
  'workdir:forget': z.tuple([path]),
  'workdir:reveal': none,

  'memory:get': none,
  'memory:list': z.tuple([text.optional()]),
  'memory:set-profile': z.tuple([z.record(z.string(), z.unknown())]),
  'memory:add': z.tuple([text, id.optional()]),
  'memory:update': z.tuple([z.number(), text]),
  'memory:delete': z.tuple([z.number()]),
  'memory:restore': z.tuple([record]),
  'memory:list-invalid': none,
  'memory:revive': z.tuple([z.number()]),
  'memory:onboarding': z.tuple([id]),
  'memory:add-docs': none,

  'files:list': z.tuple([path]),
  'files:preview': z.tuple([path, count.optional()]),
  'files:reveal': z.tuple([path]),
  'files:apps': z.tuple([path]),
  'files:open': z.tuple([path, path.nullable().optional()]),
  'files:image': z.tuple([path]),
  'files:watch': z.tuple([path.nullable()]),

  'ext:get': none,
  'ext:remove-mcp': z.tuple([id]),
  'ext:update-mcp': z.tuple([id, record]),
  'ext:import-dsh': z.tuple([z.enum(['default', 'last', 'choose'])]),
  'ext:remove-skill': z.tuple([id]),

  'sources:get': none,
  'sources:save': z.tuple([id, record]),
  'sources:check': z.tuple([id, record.optional()]),
  'sources:poll-now': z.tuple([id]),
  'sources:open-folder': none,
  'sources:choose': none,
  'sources:install': none,
  'sources:cancel-install': none,
  'sources:remove': z.tuple([id]),

  'followups:get': none,
  'followups:accept': z.tuple([record]),
  'followups:decline': z.tuple([record]),
  'followups:dismiss': z.tuple([id]),
  'followups:continue': z.tuple([id]),
  'followups:prepare-now': z.tuple([id]),
  'followups:wake': none,
  'followups:set-schedule': z.tuple([record]),
  'followups:pause': z.tuple([count]),
  'followups:suggestion': z.tuple([id, z.enum(['accept', 'decline', 'never'])]),

  'island:view': z.tuple([record]),
  'island:act': z.tuple([record]),
  'island:files': z.tuple([z.array(path).max(MAX_LIST)]),
  'island:ask': z.tuple([record]),
  'island:keep-image': z.tuple([bytes]),
})

export type Channel = keyof typeof IPC_ARGS
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

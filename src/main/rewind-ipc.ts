/**
 * Going back to something the user said and on from there with other words (phase 2, 「从这里重来」 and
 * 「改了重发」). The agent forks to before that turn (the viva-fork plugin finds it by the words); the timeline
 * goes on in a new segment holding what came before it and the new words; the segment left behind folds there.
 */
import type { openTraceDb } from '../../plugins/trace/lib/store.ts'
import type { Conversation, openHistoryDb } from './history-db.ts'
import type { StartedAgent } from './history-ipc.ts'
import type { IpcRegistry } from './ipc-contract.ts'
import { sideEffectsOf } from './side-effects.ts'

const MAX_TEXT_CHARS = 20_000

export const REWIND_PROBLEMS: Readonly<Record<string, string>> & { busy: string, unsaved: string } = Object.freeze({
  busy: '先停止当前任务，再回到前面重来',
  unsaved: '这句话还没有保存好，稍后再试',
  invalid: '在助手的记录里找不到这句话，没法从这里重来',
  missing: '当前对话已经结束，请稍后再试',
  unavailable: '这个版本的助手不支持回到前面，请更新 Viva',
})

const isText = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_TEXT_CHARS
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

/** words: what the user said there; occurrence: which such turn from the end; keep: messages before it; text: the new words. */
function checked(request: { words?: unknown, occurrence?: unknown, keep?: unknown, text?: unknown } | null | undefined) {
  const { words, occurrence = 0, keep, text } = request ?? {}
  if (!isText(words) || !isCount(occurrence) || !isCount(keep) || !isText(text)) throw new Error('invalid rewind request')
  return { words, occurrence, keep, text }
}

export function registerRewindIpc(ipcMain: Pick<IpcRegistry, 'handle'>, { db, current, setCurrent, isBusy, agentInfo, forkAgent, switchAgent, traceDb }: {
  db: ReturnType<typeof openHistoryDb>,
  current: () => Conversation, setCurrent: (conversation: Conversation) => void, isBusy: () => boolean,
  agentInfo: () => { mode?: string | null, model?: string | null },
  forkAgent: (request: { words: string, occurrence: number }) => Promise<{ ok: true, info: StartedAgent } | { ok: false, reason: string }>,
  switchAgent: (sessionId: string | null, cwd?: string | null) => Promise<StartedAgent>,
  traceDb?: () => Pick<ReturnType<typeof openTraceDb>, 'stepsOf'> | null,
}) {
  async function rewind(request: Parameters<typeof checked>[0]) {
    const { words, occurrence, keep, text } = checked(request)
    if (isBusy()) return { ok: false, problem: REWIND_PROBLEMS.busy }
    const previous = current()
    const stored = db.get(previous.id)
    if (stored?.messages[keep]?.text !== words) return { ok: false, problem: REWIND_PROBLEMS.unsaved }
    const forked = await forkAgent({ words, occurrence })
    if (!forked.ok) return { ok: false, problem: REWIND_PROBLEMS[forked.reason] ?? `没能回到那里（${forked.reason}）` }
    const kept = stored.messages.slice(0, keep)
    const { mode, model } = { ...agentInfo(), ...forked.info }
    const next = db.save(
      db.create({ sessionId: forked.info.sessionId, mode, model, cwd: previous.cwd, parentId: previous.parentId }),
      [...kept, { role: 'user', text, receipt: null }],
    )
    db.fold(previous.id, { into: next.id, at: keep })
    setCurrent(next)
    return { ok: true, info: forked.info, conversation: { id: next.id, messages: kept }, folds: db.foldsOf(next.id) }
  }

  /** A path folded off the conversation on screen, or null. */
  function foldedOff(id: unknown) {
    if (typeof id !== 'string' || !id) throw new Error('invalid path id')
    const fold = db.foldsOf(current().id).find((entry) => entry.id === id)
    const found = fold && db.get(id)
    return found ? { fold, found } : null
  }

  /** What a folded path holds after the part it shares with the conversation on screen, to read in place. */
  function folded(id: unknown) {
    const path = foldedOff(id)
    return { messages: path ? path.found.messages.slice(path.fold.at) : [] }
  }

  /**
   * Back onto a folded path: its own dsh session again, it back in the timeline, and the conversation that was
   * on screen folded off it where the two part.
   */
  async function switchPath(id: unknown) {
    if (isBusy()) return { ok: false, problem: REWIND_PROBLEMS.busy }
    const path = foldedOff(id)
    if (!path) return { ok: false, problem: REWIND_PROBLEMS.unsaved }
    const previous = current()
    const { conversation, messages } = path.found
    const started = await switchAgent(conversation.sessionId, conversation.cwd)
    db.unfold(id)
    db.fold(previous.id, { into: id, at: path.fold.at })
    setCurrent({ ...conversation, sessionId: started.sessionId, cwd: started.cwd ?? conversation.cwd })
    return {
      ok: true,
      info: { ...started, remembersHistory: started.resumed },
      conversation: { id, messages },
      folds: db.foldsOf(id),
    }
  }

  /**
   * What the part that would fold did to the computer: the steps of the conversation's sessions from the
   * message gone back to on (the trace plugin's record). Nothing when there is no record.
   */
  function effects(request: { keep?: unknown } | null | undefined) {
    const keep = request?.keep
    if (!isCount(keep)) throw new Error('invalid rewind request')
    const trace = traceDb?.()
    const since = db.timelineOf(current().id)[keep]?.at
    if (!trace || since === undefined) return { files: [], commands: [] }
    const steps = db.sessionIds(current().id).flatMap((sessionId) => trace.stepsOf(sessionId))
    return sideEffectsOf(steps, since)
  }

  ipcMain.handle('timeline:rewind', (_event, request) => rewind(request))
  ipcMain.handle('timeline:rewind-effects', (_event, request) => effects(request))
  ipcMain.handle('timeline:folded', (_event, id) => folded(id))
  ipcMain.handle('timeline:switch-path', (_event, id) => switchPath(id))
}

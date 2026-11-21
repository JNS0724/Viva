import { onLocaleChange } from '../shared/i18n/locale.ts'
import { t } from '../shared/i18n/translate.ts'
/**
 * Resending a user message with optional edits starts a new segment from before that turn. The old segment
 * folds at the point where the conversation branched.
 */
import type { openTraceDb } from '../../plugins/trace/lib/store.ts'
import type { HistoryCarry } from './history-carry.ts'
import type { Conversation, openHistoryDb } from './history-db.ts'
import type { StartedAgent } from './history-ipc.ts'
import type { IpcRegistry } from '../shared/ipc-contract.ts'
import { sideEffectsOf } from './side-effects.ts'
import type { ReadNativeTrace } from './dsh-log.ts'
import type { StoredMessage } from './history-schema.ts'
import type { MemoryHistoryEdit } from './memory-withdrawal.ts'
import { CONVERSATION_WINDOW_MESSAGES } from '../shared/renderer-sync.ts'
import { randomUUID } from 'node:crypto'

const MAX_TEXT_CHARS = 20_000
type SelectionOps = {
  select: (conversation: Conversation) => void
  forkAgent: (request: { words: string, occurrence: number }) => Promise<{ ok: true, info: StartedAgent } | { ok: false, reason: string }>
  switchAgent: (sessionId: string | null, cwd?: string | null) => Promise<StartedAgent>
}
type SelectSession = <T>(work: (ops: SelectionOps) => Promise<T>) => Promise<T>

export let REWIND_PROBLEMS: Readonly<Record<string, string>> & { busy: string, unsaved: string } = Object.freeze({
  busy: t("main.rewind-ipc.stop.the.current.task.before.restarting.from"),
  unsaved: t("main.rewind-ipc.this.message.has.not.been.saved.yet"),
  invalid: t("main.rewind-ipc.this.message.is.not.in.the.assistant"),
  missing: t("main.main.this.conversation.has.ended.try.again.later"),
  unavailable: t("main.rewind-ipc.this.assistant.version.cannot.rewind.update.viva"),
})

const isText = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_TEXT_CHARS
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

/** words: what the user said there; occurrence: which such turn from the end; keep: messages before it; text: the new words. */
function checked(request: { words?: unknown, occurrence?: unknown, keep?: unknown, text?: unknown } | null | undefined) {
  const { words, occurrence = 0, keep, text } = request ?? {}
  if (!isText(words) || !isCount(occurrence) || !isCount(keep) || !isText(text)) throw new Error('invalid rewind request')
  return { words, occurrence, keep, text }
}

export function registerRewindIpc(ipcMain: Pick<IpcRegistry, 'handle'>, deps: {
  db: ReturnType<typeof openHistoryDb>,
  current: () => Conversation, isBusy: () => boolean | Promise<boolean>,
  agentInfo: () => { mode?: string | null, model?: string | null },
  selectSession: SelectSession,
  replaySource?: (id: string, text: string) => boolean | Promise<boolean>,
  derivedSource?: (id: string) => boolean | Promise<boolean>,
  canEditSource?: (id: string) => boolean | Promise<boolean>,
  commitEdit?: (edit: MemoryHistoryEdit) => Promise<Conversation>,
  rebuild?: (previous: Conversation, kept: readonly StoredMessage[], force?: boolean) => Promise<HistoryCarry | null>,
  publishCarry?: (target: Conversation, carry: HistoryCarry) => Promise<boolean>,
  onContinuation?: (conversation: Conversation, started: StartedAgent) => void | Promise<void>,
  traceDb?: () => Pick<ReturnType<typeof openTraceDb>, 'stepsOf'> | null,
  readNativeTrace?: ReadNativeTrace,
}) {
  const { db, current, isBusy, agentInfo, traceDb, selectSession } = deps
  async function rewind(request: Parameters<typeof checked>[0]) {
    const { words, occurrence, keep, text } = checked(request)
    if (await isBusy()) return { ok: false, problem: REWIND_PROBLEMS.busy }
    const previous = current()
    const stored = db.get(previous.id)
    const original = stored?.messages[keep]
    if (!stored || original?.role !== 'user' || original.text !== words) return { ok: false, problem: REWIND_PROBLEMS.unsaved }
    if (original.sourceId && await deps.derivedSource?.(original.sourceId)) return { ok: false, problem: t('main.feed.rewind.derived') }
    const edit = text !== words && original.sourceId && deps.commitEdit
      ? { oldSource: original.sourceId, newSource: randomUUID(), previous } : null
    if (edit && await deps.canEditSource?.(edit.oldSource) === false) return { ok: false, problem: t('main.memory.rewind.edit.unavailable') }
    const sourceId = edit ? edit.newSource : text === words ? original.sourceId : undefined
    if (sourceId && !edit && deps.replaySource && !await deps.replaySource(sourceId, text)) return { ok: false, problem: t('main.memory.context.stale') }
    return selectSession(async ({ forkAgent, switchAgent, select }) => {
      const kept = stored.messages.slice(0, keep)
      const forked = edit ? { ok: false as const, reason: 'missing' } : await forkAgent({ words, occurrence })
      if (!forked.ok && forked.reason !== 'missing') return { ok: false, problem: REWIND_PROBLEMS[forked.reason] ?? t("main.rewind-ipc.could.not.return.there", { reason: forked.reason }) }
      const fallback = !edit && !forked.ok ? await deps.rebuild?.(previous, kept) : null
      if (!edit && !forked.ok && !fallback) return { ok: false, problem: REWIND_PROBLEMS[forked.reason] }
      const started = forked.ok ? forked.info : await switchAgent(null, previous.cwd)
      const { mode, model } = { ...agentInfo(), ...started }
      const draft = db.create({ sessionId: started.sessionId, mode, model, cwd: previous.cwd, parentId: previous.parentId, topicId: db.topicOf(previous.id) })
      const save = () => {
        const next = db.save(
          // Going back stays in the topic, even from its first segment (which has no parent to take it from).
          draft,
          [...kept, { role: 'user', text, receipt: null, ...(sourceId ? { sourceId } : {}) }],
          { copy: { from: previous.id, count: keep } },
        )
        db.fold(previous.id, { into: next.id, at: keep })
        db.moveRecords({ from: previous.id, to: next.id, upTo: keep })
        return next
      }
      const next = edit ? await deps.commitEdit!({ ...edit, next: draft, kept, keep, text }) : save()
      const carried = edit ? await deps.rebuild?.(previous, kept, true) : fallback
      select(next)
      if (carried?.turns) {
        await deps.publishCarry?.(next, carried)
      }
      const offset = Math.max(0, keep - CONVERSATION_WINDOW_MESSAGES)
      const messages = db.sliceMessages(next.id, offset, keep)
      return { ok: true, info: { ...started, conversationId: next.id },
        conversation: { id: next.id, messages, ...(offset > 0 ? { offset, total: keep } : {}), ...withRecords(next.id) },
        folds: db.foldsOf(next.id), ...(sourceId ? { sourceId } : {}), ...(edit ? { newSource: true } : {}) }
    })
  }

  /** A conversation's task records (history-db.ts report_records), when it has any. */
  const withRecords = (id: string) => {
    const records = db.recordsOf(id)
    return records.length ? { records } : {}
  }

  /** A path folded off the conversation on screen, or null. */
  function foldedOff(id: unknown) {
    if (typeof id !== 'string' || !id) throw new Error('invalid path id')
    const fold = db.foldsOf(current().id).find((entry) => entry.id === id)
    const found = fold && db.get(id)
    return found ? { fold, found } : null
  }

  /**
   * What a folded path holds after the part it shares with the conversation on screen, to read in place: its
   * messages, and its task records placed among them (after the shared part, so counted from there).
   */
  function folded(id: unknown) {
    const path = foldedOff(id)
    if (!path) return { messages: [] }
    const at = path.fold.at
    const records = path.found.records.filter((record) => record.after > at).map((record) => ({ ...record, after: record.after - at }))
    return { messages: path.found.messages.slice(at), ...(records.length ? { records } : {}) }
  }

  /**
   * Back onto a folded path: its own dsh session again, it back in the timeline, and the conversation that was
   * on screen folded off it where the two part.
   */
  async function switchPath(id: unknown) {
    if (await isBusy()) return { ok: false, problem: REWIND_PROBLEMS.busy }
    const path = foldedOff(id)
    if (!path) return { ok: false, problem: REWIND_PROBLEMS.unsaved }
    const previous = current()
    const { conversation } = path.found
    return selectSession(async ({ switchAgent, select }) => {
      const started = await switchAgent(conversation.sessionId, conversation.cwd)
      db.unfold(id)
      db.fold(previous.id, { into: id, at: path.fold.at })
      db.moveRecords({ from: previous.id, to: conversation.id, upTo: path.fold.at })
      select({ ...conversation, sessionId: started.sessionId, cwd: started.cwd ?? conversation.cwd })
      await deps.onContinuation?.(conversation, started)
      const tail = db.getTail(conversation.id, CONVERSATION_WINDOW_MESSAGES)
      const messages = tail?.messages ?? path.found.messages
      const offset = tail?.offset ?? 0
      const total = tail?.total ?? messages.length
      return {
        ok: true,
        info: { ...started, remembersHistory: started.resumed, conversationId: conversation.id },
        conversation: { id, messages, ...(offset > 0 ? { offset, total } : {}), ...withRecords(conversation.id) },
        folds: db.foldsOf(id),
      }
    })
  }

  /**
   * What the part that would fold did to the computer: the steps of the conversation's sessions from the
   * message gone back to on (the trace plugin's record). Nothing when there is no record.
   */
  function effects(request: { keep?: unknown } | null | undefined) {
    const keep = request?.keep
    if (!isCount(keep)) throw new Error('invalid rewind request')
    const conversation = current().id
    const since = db.timelineOf(conversation)[keep]?.at
    if (since === undefined) return { files: [], commands: [] }
    const sessions = db.sessionIds(conversation)
    const read = (visible: readonly string[]) => {
      const trace = traceDb?.()
      return sideEffectsOf(trace ? visible.flatMap(session => trace.stepsOf(session)) : [], since)
    }
    return deps.readNativeTrace ? deps.readNativeTrace(sessions, read) : read(sessions)
  }

  ipcMain.handle('timeline:rewind', (_event, request) => rewind(request))
  ipcMain.handle('timeline:rewind-effects', (_event, request) => effects(request))
  ipcMain.handle('timeline:folded', (_event, id) => folded(id))
  ipcMain.handle('timeline:switch-path', (_event, id) => switchPath(id))
}

onLocaleChange(() => {
  REWIND_PROBLEMS = Object.freeze({
  busy: t("main.rewind-ipc.stop.the.current.task.before.restarting.from"),
  unsaved: t("main.rewind-ipc.this.message.has.not.been.saved.yet"),
  invalid: t("main.rewind-ipc.this.message.is.not.in.the.assistant"),
  missing: t("main.main.this.conversation.has.ended.try.again.later"),
  unavailable: t("main.rewind-ipc.this.assistant.version.cannot.rewind.update.viva"),
})
})

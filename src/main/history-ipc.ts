import { onLocaleChange } from '../shared/i18n/locale.ts'
import { t } from '../shared/i18n/translate.ts'
import fs from 'node:fs/promises'
import { readSessionTrace } from './dsh-log.ts'
import { exportFileName, toMarkdown } from './history-export.ts'
import type { Conversation, openHistoryDb } from './history-db.ts'
import { assertId } from './history-schema.ts'
import { handlerOf, type IpcRegistry } from './ipc-contract.ts'
import type { openTraceDb } from '../../plugins/trace/lib/store.ts'

/** How long "已删除 · 撤销" stays up; the conversation is purged for good after that. */
export const UNDO_WINDOW_MS = 8000
const PURGE_SLACK_MS = 1000
const MAX_QUERY_CHARS = 200

type HistoryDb = ReturnType<typeof openHistoryDb>
/** The agent as it started on a session (acp-bridge.ts): the session, where it runs, whether dsh had it still. */
export type StartedAgent = { sessionId: string | null, cwd?: string | null, resumed?: boolean, [field: string]: unknown }

const summaryOf = (conversation: Pick<Conversation, 'id' | 'title' | 'updatedAt'>) => ({ id: conversation.id, title: conversation.title, updatedAt: conversation.updatedAt })
/** With what it goes on from and when it began: the window draws where its topic starts (renderer/topics.js). */
const viewOf = (found: ReturnType<HistoryDb['get']>) => (found
  ? { ...summaryOf(found.conversation), parentId: found.conversation.parentId, createdAt: found.conversation.createdAt, messages: found.messages }
  : null)
let BUSY = t("main.history-ipc.wait.for.this.turn.to.finish.before")
let GONE = t("main.history-ipc.cannot.resume.that.topic.the.assistant.no")

function assertQuery(value: unknown) {
  if (typeof value !== 'string' || value.length > MAX_QUERY_CHARS) throw new Error('invalid search query')
  return value
}

/**
 * IPC for the history panel. The main process owns "the conversation on screen" and the agent;
 * they are reached through the callbacks so this module stays testable without Electron.
 */
export function registerHistoryIpc(ipcMain: Pick<IpcRegistry, 'handle'>, deps: {
  db: HistoryDb,
  dshHome: string,
  traceDb?: () => ReturnType<typeof openTraceDb> | null,
  current: () => Conversation, setCurrent: (conversation: Conversation) => void,
  agentInfo: () => { mode: string | null, model: string | null, [field: string]: unknown },
  switchAgent: (sessionId: string | null, cwd?: string | null) => Promise<StartedAgent>,
  chooseExportPath: (defaultName: string) => Promise<string | null>,
  schedule?: (fn: () => void, ms: number) => void,
  isBusy?: () => boolean,
}) {
  const { db, dshHome, traceDb, current, setCurrent, agentInfo, switchAgent, chooseExportPath } = deps
  const isBusy = deps.isBusy ?? (() => false)
  const schedule = deps.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms).unref?.())
  const handle = handlerOf(ipcMain)

  /** The conversation on screen, with the paths folded off it where the user went back (rewind-ipc.js). */
  handle('history:load', () => {
    const view = viewOf(db.get(current().id))
    return view && { ...view, folds: db.foldsOf(view.id) }
  })

  handle('history:save', (messages) => {
    const { mode, model } = agentInfo()
    const saved = db.save({ ...current(), mode, model }, messages)
    setCurrent(saved)
    return summaryOf(saved)
  })

  handle('history:list', (offset = 0) => db.list({ offset: Number(offset) || 0 }))
  handle('history:search', (query) => db.search(assertQuery(query)))
  /** The one timeline: the segments before `id` (the window scrolls up into them), and search across all of it. */
  handle('history:segments-before', (id, limit) => db.segmentsBefore(assertId(id), { limit: Number(limit) || undefined }))
  handle('history:search-messages', (query) => db.searchMessages(assertQuery(query)))

  /** Shows an older conversation and reattaches the agent to its dsh session when it still can. */
  handle('history:open', async (id) => {
    const found = db.get(assertId(id))
    if (!found) throw new Error(t("main.history-ipc.conversation.not.found.it.may.have.been"))
    if (found.conversation.id === current().id) return { conversation: viewOf(found), info: agentInfo() }
    const started = await switchAgent(found.conversation.sessionId, found.conversation.cwd)
    setCurrent({ ...found.conversation, sessionId: started.sessionId, cwd: started.cwd ?? found.conversation.cwd })
    return { conversation: viewOf(found), info: { ...started, remembersHistory: started.resumed } }
  })

  /**
   * 回到这个话题, and 撤销 a new topic: the agent takes up that segment's session again, and what is said from
   * now on goes in a new segment at the end of the timeline that goes on from it, so the timeline stays in order.
   */
  handle('history:resume-topic', async (id) => {
    if (isBusy()) throw new Error(BUSY)
    const found = db.get(assertId(id))
    if (!found) throw new Error(t("main.history-ipc.conversation.not.found.it.may.have.been"))
    const { sessionId, cwd } = found.conversation
    const started = await switchAgent(sessionId, cwd)
    if (!started.resumed) throw new Error(GONE)
    const { mode, model } = agentInfo()
    setCurrent(db.create({ sessionId: started.sessionId, mode, model, cwd: started.cwd ?? cwd, parentId: found.conversation.id }))
    return { info: { ...started, remembersHistory: true }, parentId: found.conversation.id }
  })

  handle('history:trace', (id, until) => readSessionTrace({
    dshHome,
    traceDb: traceDb?.() ?? null,
    sessionIds: db.sessionIds(assertId(id)),
    until: typeof until === 'number' && Number.isFinite(until) ? until : Date.now(),
  }))

  handle('history:rename', (id, title) => db.rename(id, title))
  handle('history:pin', (id, pinned) => db.setPinned(id, pinned === true))
  handle('history:delete', (id) => {
    db.softDelete(id)
    schedule(() => db.purgeDeleted({ olderThanMs: UNDO_WINDOW_MS }), UNDO_WINDOW_MS + PURGE_SLACK_MS)
  })
  handle('history:restore', (id) => db.restore(id))

  handle('history:export', async (id) => {
    const found = db.get(assertId(id))
    if (!found) throw new Error(t("main.history-ipc.conversation.not.found.it.may.have.been"))
    const file = await chooseExportPath(exportFileName(found.conversation.title))
    if (!file) return { saved: false }
    await fs.writeFile(file, toMarkdown(found.conversation, found.messages), 'utf8')
    return { saved: true, file }
  })
}

onLocaleChange(() => {
  BUSY = t("main.history-ipc.wait.for.this.turn.to.finish.before")
  GONE = t("main.history-ipc.cannot.resume.that.topic.the.assistant.no")
})

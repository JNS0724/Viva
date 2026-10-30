import { onLocaleChange } from '../shared/i18n/locale.ts'
import { t } from '../shared/i18n/translate.ts'
import fs from 'node:fs/promises'
import { readSessionTrace } from './dsh-log.ts'
import { exportFileName, toMarkdown } from './history-export.ts'
import type { Conversation, openHistoryDb } from './history-db.ts'
import { assertId } from './history-schema.ts'
import { CARRY_TURNS, carriedRecords } from './history-carry.ts'
import { ResumeError } from './resume-failure.ts'
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
  switchAgent: (sessionId: string | null, cwd?: string | null, options?: { exactly?: boolean }) => Promise<StartedAgent>,
  chooseExportPath: (defaultName: string) => Promise<string | null>,
  schedule?: (fn: () => void, ms: number) => void,
  isBusy?: () => boolean,
  /** Whether a directory is there; the one the agent is in now. */
  folderExists?: (dir: string) => boolean,
  workDir?: () => string | null,
  /** Records to go with the first question of a conversation (main.ts agent:prompt). */
  carryNext?: (conversationId: string, text: string) => void,
}) {
  const { db, dshHome, traceDb, current, setCurrent, agentInfo, switchAgent, chooseExportPath } = deps
  const folderExists = deps.folderExists ?? (() => true)
  const workDir = deps.workDir ?? (() => null)
  const carryNext = deps.carryNext ?? (() => {})
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
  /**
   * 回顾: the topics, the one last talked in first, a page after the topic named last; a part of a topic's or a
   * segment's messages to read (history-reader.ts); the stars, putting one on saying whether it changed anything.
   * Reading never touches the agent: it stays on the conversation it is on, in its directory.
   */
  handle('history:review', (after, filter) => db.review({ after: after ?? null, filter: filter ?? 'all' }))
  handle('history:read', (key, request) => db.read(key, request ?? {}))
  /** A link, search hit or star: where the message is now, and where 回顾 reads it (history-db.ts locate). */
  handle('history:locate', (ref) => {
    const located = db.locate(ref)
    const reader = located.status === 'deleted' ? null : db.readerOf(located.segmentId)
    return reader ? { ...located, reader } : { status: 'deleted' as const, segmentId: located.segmentId, reader: null }
  })
  handle('history:star', (id, seq, starred) => db.setStar(id, seq, starred === true))
  handle('history:stars-in', (ids) => db.starsIn(ids))
  handle('history:starred', () => db.starredMessages())

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
   * Before 继续这个话题: the directory it goes on in, whether that is still there, and whether it is the one the
   * agent is in now (the window says so before switching, and asks for another when it is gone).
   */
  handle('history:resume-check', (id) => {
    const found = db.get(assertId(id))
    if (!found) throw new Error(t("main.history-ipc.conversation.not.found.it.may.have.been"))
    const { cwd } = found.conversation
    return { cwd, exists: Boolean(cwd && folderExists(cwd)), same: Boolean(cwd && cwd === workDir()) }
  })

  /**
   * 继续这个话题, and 撤销 a new topic: the agent takes up that segment's own session again, in its own directory,
   * and what is said from now on goes in a new segment at the end of the timeline that goes on from it. When it
   * cannot (resume-failure.ts) the agent stays where it was and the window is told why: `info`, where it is now.
   */
  handle('history:resume-topic', async (id) => {
    if (isBusy()) throw new Error(BUSY)
    const found = db.get(assertId(id))
    if (!found) throw new Error(t("main.history-ipc.conversation.not.found.it.may.have.been"))
    const { sessionId, cwd } = found.conversation
    if (!sessionId) return { ok: false as const, reason: 'gone' as const, message: GONE, cwd, info: null }
    try {
      const started = await switchAgent(sessionId, cwd, { exactly: true })
      const { mode, model } = agentInfo()
      setCurrent(db.create({ sessionId: started.sessionId, mode, model, cwd: started.cwd ?? cwd, parentId: found.conversation.id }))
      return { ok: true as const, info: { ...started, remembersHistory: true }, parentId: found.conversation.id }
    } catch (err) {
      if (!(err instanceof ResumeError)) throw err
      return { ok: false as const, reason: err.reason, message: err.message, cwd, info: err.info && { ...err.info, remembersHistory: Boolean(err.info.resumed) } }
    }
  })

  /**
   * The topic's own session gone (or its directory): it goes on in a new session in `dir`, its latest turns carried
   * with the first question as records to refer to (history-carry.ts); the new segment goes on from it.
   */
  handle('history:continue-from-records', async (id, dir) => {
    if (isBusy()) throw new Error(BUSY)
    const found = db.get(assertId(id))
    if (!found) throw new Error(t("main.history-ipc.conversation.not.found.it.may.have.been"))
    if (typeof dir !== 'string' || !folderExists(dir)) throw new Error(t("workspace.missing.choose"))
    const topicId = db.topicOf(found.conversation.id)
    const part = topicId ? db.read(`t:${topicId}`, { from: Number.MAX_SAFE_INTEGER, count: CARRY_TURNS * 2 }) : null
    const carried = carriedRecords(part?.messages ?? found.messages)
    const started = await switchAgent(null, dir)
    const { mode, model } = agentInfo()
    const next = db.create({ sessionId: started.sessionId, mode, model, cwd: started.cwd ?? dir, parentId: found.conversation.id })
    setCurrent(next)
    if (carried.turns) carryNext(next.id, carried.text)
    return { info: { ...started, remembersHistory: false }, parentId: found.conversation.id, turns: carried.turns }
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

import fs from 'node:fs/promises'
import path from 'node:path'
import { stepsFrom } from '../../plugins/trace/lib/steps.js'
import { assertId } from './history-schema.js'
import { decompressZstdFrames } from './zstd-frames.js'

/**
 * The 过程 of saved conversations. The trace plugin records every turn into trace.db (its contract);
 * sessions from before it existed are read from dsh's own log, whose format is dsh-private. Both become the
 * same steps (plugins/trace/lib/steps.js), shown here the way the live drawer shows them.
 */

const LOG_FILE = 'session.v4.jsonl.zstd'
const MAX_LOG_BYTES = 64 * 1024 * 1024
const TITLE_CHARS = 60

const shorten = (text) => {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  return value.length > TITLE_CHARS ? `${value.slice(0, TITLE_CHARS - 1)}…` : value
}
const fileName = (p) => path.basename(String(p ?? ''))
const at = (p) => (p ? [{ path: String(p) }] : [])

/** How each dsh tool shows up in the trace. Only small, non-content arguments are kept. */
const TOOL_VIEWS = {
  bash: (a) => ({ kind: 'execute', title: shorten(a.description || a.command), rawInput: { command: shorten(a.command) } }),
  read: (a) => ({ kind: 'read', title: `读取 ${fileName(a.file_path)}`, locations: at(a.file_path) }),
  edit: (a) => ({ kind: 'edit', title: `编辑 ${fileName(a.file_path)}`, locations: at(a.file_path) }),
  write: (a) => ({ kind: 'edit', title: `写入 ${fileName(a.file_path)}`, locations: at(a.file_path) }),
  web_fetch: (a) => ({ kind: 'fetch', title: '抓取网页', rawInput: { url: String(a.url ?? '') } }),
  web_search: (a) => {
    const query = (Array.isArray(a.queries) ? a.queries : [a.query]).filter(Boolean).join(' / ')
    return { kind: 'search', title: shorten(`搜索 ${query}`), rawInput: { query } }
  },
  todo_write: () => ({ kind: 'think', title: '更新待办' }),
}

function toolFrom(sessionId, step) {
  const view = TOOL_VIEWS[step.name]?.(step.args ?? {}) ?? { kind: 'other', title: String(step.name || '工具调用') }
  return { locations: [], rawInput: null, ...view, id: `${sessionId}:${step.callId}`, status: step.status, at: step.at }
}

function parseLines(text) {
  return text.split('\n').flatMap((line) => {
    try {
      return line.trim() ? [JSON.parse(line)] : []
    } catch {
      return []
    }
  })
}

/**
 * The drawer's trace (thoughts, tool calls, their order) from one session's steps. Steps after `until` are
 * skipped, so turns the live view already shows are not repeated.
 * @returns {{ thoughts: object[], tools: Record<string, object>, timeline: object[] }}
 */
export function traceFromSteps(steps, { sessionId, until = Infinity }) {
  const trace = { thoughts: [], tools: {}, timeline: [] }
  for (const step of steps.filter((item) => item.at <= until)) {
    if (step.kind === 'thought') {
      const id = `log-${sessionId}-${trace.thoughts.length}`
      trace.thoughts = [...trace.thoughts, { id, text: step.text, open: false, at: step.at }]
      trace.timeline = [...trace.timeline, { kind: 'thought', ref: id, at: step.at }]
    } else {
      const tool = toolFrom(sessionId, step)
      trace.tools = { ...trace.tools, [tool.id]: tool }
      trace.timeline = [...trace.timeline, { kind: 'tool', ref: tool.id, at: step.at }]
    }
  }
  return trace
}

/** The trace of one dsh session log (the text of `session.v4.jsonl`). */
export const parseSessionLog = (text, options) => traceFromSteps(stepsFrom(parseLines(text)), options)

/** dsh keeps `<home>/sessions/<workspace>/<id>/` (older builds: `session-<id>/`). */
async function findLog(dshHome, sessionId) {
  const root = path.join(dshHome, 'sessions')
  const workspaces = await fs.readdir(root).catch(() => [])
  for (const workspace of workspaces) {
    for (const dir of [sessionId, `session-${sessionId}`]) {
      const file = path.join(root, workspace, dir, LOG_FILE)
      const stat = await fs.stat(file).catch(() => null)
      if (stat?.isFile() && stat.size <= MAX_LOG_BYTES) return file
    }
  }
  return null
}

const mergeTraces = (a, b) => ({
  thoughts: [...a.thoughts, ...b.thoughts],
  tools: { ...a.tools, ...b.tools },
  timeline: [...a.timeline, ...b.timeline],
})

async function traceFromLog(dshHome, sessionId, until) {
  const file = await findLog(dshHome, sessionId)
  if (!file) throw new Error('not found')
  const text = (await decompressZstdFrames(await fs.readFile(file))).toString('utf8')
  return parseSessionLog(text, { sessionId, until })
}

/**
 * Best-effort read of the trace for a conversation's dsh sessions, oldest session first: from trace.db when
 * the trace plugin recorded the session, else from dsh's log, which may not parse after a dsh upgrade. A
 * session that can't be read is just counted as missing.
 * @param {{ dshHome: string, traceDb?: ReturnType<import('../../plugins/trace/lib/store.js').openTraceDb> | null, sessionIds: string[], until: number }} options
 */
export async function readSessionTrace({ dshHome, traceDb = null, sessionIds, until }) {
  let trace = { thoughts: [], tools: {}, timeline: [] }
  let missing = 0
  for (const sessionId of sessionIds.map(assertId)) {
    try {
      const found = traceDb?.hasSession(sessionId)
        ? traceFromSteps(traceDb.stepsOf(sessionId, until), { sessionId, until })
        : await traceFromLog(dshHome, sessionId, until)
      trace = mergeTraces(trace, found)
    } catch {
      missing += 1
    }
  }
  return { trace, available: missing < sessionIds.length, missing }
}

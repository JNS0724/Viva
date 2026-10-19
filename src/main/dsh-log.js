import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import zlib from 'node:zlib'
import { assertId } from './history-schema.js'

const LOG_FILE = 'session.v4.jsonl.zstd'
const MAX_LOG_BYTES = 64 * 1024 * 1024
const TITLE_CHARS = 60
const zstdDecompress = promisify(zlib.zstdDecompress)

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

function parseArguments(raw) {
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : (raw ?? {})
  } catch {
    return {}
  }
}

function toolFrom(sessionId, data, time) {
  const view = TOOL_VIEWS[data.name]?.(parseArguments(data.arguments)) ?? { kind: 'other', title: String(data.name ?? '工具调用') }
  return { locations: [], rawInput: null, ...view, id: `${sessionId}:${data.callId}`, status: 'in_progress', at: time }
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
 * Rebuilds the drawer's trace (thoughts, tool calls, their order) from one dsh session log.
 * Events after `until` are skipped, so turns the live view already shows are not repeated.
 * @returns {{ thoughts: object[], tools: Record<string, object>, timeline: object[] }}
 */
export function parseSessionLog(text, { sessionId, until = Infinity }) {
  const trace = { thoughts: [], tools: {}, timeline: [] }
  for (const { type, time, data } of parseLines(text)) {
    if (!data || time > until) continue
    if (type === 'assistant/message') {
      const reasoning = (data.message?.content ?? []).filter((p) => p.type === 'reasoning').map((p) => p.text).join('')
      if (!reasoning) continue
      const id = `log-${sessionId}-${trace.thoughts.length}`
      trace.thoughts = [...trace.thoughts, { id, text: reasoning, open: false, at: time }]
      trace.timeline = [...trace.timeline, { kind: 'thought', ref: id, at: time }]
    } else if (type === 'tool/call' && data.callId) {
      const tool = toolFrom(sessionId, data, time)
      trace.tools = { ...trace.tools, [tool.id]: tool }
      trace.timeline = [...trace.timeline, { kind: 'tool', ref: tool.id, at: time }]
    } else if (type === 'tool/result') {
      const id = `${sessionId}:${data.message?.toolCallId}`
      const tool = trace.tools[id]
      if (tool) trace.tools = { ...trace.tools, [id]: { ...tool, status: data.message.isError ? 'failed' : 'completed' } }
    }
  }
  return trace
}

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

/**
 * Best-effort read of the trace for a conversation's dsh sessions, oldest session first.
 * The log format is dsh-private and may change, so a session that can't be read is just counted as missing.
 */
export async function readSessionTrace({ dshHome, sessionIds, until }) {
  let trace = { thoughts: [], tools: {}, timeline: [] }
  let missing = 0
  for (const sessionId of sessionIds.map(assertId)) {
    try {
      const file = await findLog(dshHome, sessionId)
      if (!file) throw new Error('not found')
      const text = (await zstdDecompress(await fs.readFile(file))).toString('utf8')
      trace = mergeTraces(trace, parseSessionLog(text, { sessionId, until }))
    } catch {
      missing += 1
    }
  }
  return { trace, available: missing < sessionIds.length, missing }
}

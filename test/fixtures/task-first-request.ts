import fs from 'node:fs/promises'
import path from 'node:path'
import { decompressZstdFrames } from '../../src/backend/zstd-frames.ts'
import { withoutTaskHeaders } from '../../src/shared/request-routing/task-header.ts'

const recoveryOpening = 'The previous generated context has been retired. The following are authorized earlier user messages, retained as historical context.'
const recoveryClosing = '\n[End of earlier user messages]\n'
const deliverySuffix = /\n\n<memory-delivery id="[a-f0-9-]+" \/>$/u
const contextKinds = new Set(['runtime-context', 'skill-catalog', 'viva-memory'])
const structuralEvents = new Set(['permission/preset', 'sandbox/mode', 'approval/policy', 'session/title'])

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null

function textParts(content: unknown): string[] | null {
  if (typeof content === 'string') return [content]
  if (!Array.isArray(content)) return null
  const parts: string[] = []
  for (const item of content) {
    const block = object(item)
    if (block?.type !== 'text' || typeof block.text !== 'string') return null
    parts.push(block.text)
  }
  return parts
}

const normalizeBrief = (text: string) => withoutTaskHeaders(text.replace(deliverySuffix, ''))

function isBrief(message: Record<string, unknown>, brief: string): boolean {
  const parts = textParts(message.content)
  return message.role === 'user' && parts?.length === 1 && normalizeBrief(parts[0]!) === brief
}

/** Raw provider evidence only; never discard recovery history or system-reminder text. */
export function providerReceivedTaskBrief(requests: readonly unknown[], brief: string): boolean {
  return requests.some(value => {
    const messages = object(value)?.messages
    return Array.isArray(messages) && messages.some(value => {
      const message = object(value)
      return message?.role === 'user' && textParts(message.content)?.some(text => normalizeBrief(text) === brief)
    })
  })
}

export interface TaskFirstRequestEvidence {
  ok: boolean
  reason: string | null
  sessionId: string
  firstRequestSeq: number | null
  humanMessages: number
  recoveryFrames: number
  contextKinds: string[]
  file?: string
}

/** Inspect the persisted first-request prefix, including content removed from its live surface. */
export function taskFirstRequestEvidence(rows: readonly unknown[], sessionId: string, brief: string): TaskFirstRequestEvidence {
  const evidence: TaskFirstRequestEvidence = { ok: false, reason: null, sessionId, firstRequestSeq: null,
    humanMessages: 0, recoveryFrames: 0, contextKinds: [] }
  const reject = (reason: string) => ({ ...evidence, reason })
  const header = object(rows[0])
  if (header?.type !== 'session' || header.version !== 4 || header.id !== sessionId || header.isSeeded !== false) return reject('Not an unseeded V4 task session')
  let systemMessages = 0, turns = 0, steps = 0
  const briefIds = new Set<string>()
  for (const [index, raw] of rows.slice(1).entries()) {
    const event = object(raw), data = object(event?.data)
    if (!event || event.seq !== index || typeof event.type !== 'string' || !data) return reject('Malformed native event prefix')
    if (event.type === 'request/header') {
      evidence.firstRequestSeq = index
      if (evidence.humanMessages !== 1 || briefIds.size !== 1 || systemMessages !== 1 || turns !== 1 || steps !== 1) return reject('First request is not solely the new task brief and declared context')
      return { ...evidence, ok: true }
    }
    if (structuralEvents.has(event.type)) continue
    if (event.type === 'turn/start') {
      if (data.turn !== 1 || ++turns !== 1) return reject('Earlier task turns precede the first request')
      continue
    }
    if (event.type === 'step/start') {
      if (data.turn !== 1 || data.step !== 1 || ++steps !== 1) return reject('Earlier task steps precede the first request')
      continue
    }
    if (event.type === 'agent/inbox/spliced') {
      if (!Array.isArray(data.inserted)) return reject('Malformed initial inbox')
      for (const raw of data.inserted) {
        const message = object(raw)
        if (!message || object(message.source)?.kind !== 'user' || !isBrief(message, brief) || typeof message.id !== 'string') return reject('Another message entered the task inbox')
        briefIds.add(message.id)
      }
      continue
    }
    if (event.type === 'system/message') {
      const message = object(data.message)
      if (message?.role !== 'system' || !textParts(message.content) || ++systemMessages !== 1) return reject('Unexpected system history before task request')
      continue
    }
    if (event.type !== 'user/message' || event.surfaceOp !== 'append') return reject(`Unexpected prior native event: ${event.type}`)
    const source = object(data.source), parts = textParts(data.content)
    if (data.role !== 'user' || !source || !parts) return reject('Malformed task user message')
    if (source.kind === 'user' || source.kind === 'viva-task-brief') {
      if (!isBrief(data, brief) || typeof data.id !== 'string') return reject('Parent or different human original precedes the task request')
      evidence.humanMessages++
      briefIds.add(data.id)
    } else if (source.kind === 'viva-memory-recovery') {
      if (evidence.humanMessages || ++evidence.recoveryFrames !== 1 || !Array.isArray(source.originalMessageIds) || source.originalMessageIds.length
        || parts.length !== 2 || parts[0] !== recoveryOpening || parts[1] !== recoveryClosing) return reject('Recovery contains earlier conversation content')
    } else if (typeof source.kind === 'string' && contextKinds.has(source.kind) && evidence.humanMessages === 1) {
      evidence.contextKinds.push(source.kind)
    } else return reject('Undeclared user-role context before task request')
  }
  return reject('No persisted first request header')
}

/** readFile/decompression closes its own handles; no database or live persistence reader is opened. */
export async function readTaskFirstRequest(userData: string, sessionId: string, brief: string): Promise<TaskFirstRequestEvidence> {
  const unavailable = (reason: string): TaskFirstRequestEvidence => ({ ok: false, reason, sessionId,
    firstRequestSeq: null, humanMessages: 0, recoveryFrames: 0, contextKinds: [] })
  if (!/^[A-Za-z0-9-]{1,128}$/u.test(sessionId)) return unavailable('Invalid native task ID')
  try {
    const root = path.join(userData, 'dsh', 'sessions'), files: string[] = []
    for (const workspace of await fs.readdir(root, { withFileTypes: true })) {
      if (!workspace.isDirectory()) continue
      const file = path.join(root, workspace.name, sessionId, 'session.v4.jsonl.zstd')
      const stat = await fs.stat(file).catch(() => null)
      if (stat?.isFile()) files.push(file)
    }
    if (files.length !== 1) return unavailable('Missing or ambiguous native task artifact')
    const file = files[0]!, bytes = await fs.readFile(file)
    if (bytes.length > 64 * 1024 * 1024) return unavailable('Task artifact exceeds the smoke evidence bound')
    const text = (await decompressZstdFrames(bytes)).toString('utf8')
    const rows: unknown[] = text.trimEnd().split('\n').map(line => JSON.parse(line) as unknown)
    return { ...taskFirstRequestEvidence(rows, sessionId, brief), file }
  } catch (error) { return unavailable(`Cannot read native task evidence: ${error instanceof Error ? error.message : String(error)}`) }
}

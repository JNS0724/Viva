/** Deterministic stratified LongMemEval cleaned-S sampler & date parser (aligned with ReMe run.py). */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { LmeItem, LmeSessionMessage, LmeSessionSampling } from './types.ts'

export const LME_QUESTION_TYPES = [
  'single-session-user',
  'single-session-assistant',
  'single-session-preference',
  'multi-session',
  'knowledge-update',
  'temporal-reasoning',
] as const

export interface SortedLmeSession {
  originalIndex: number
  timestampMs: number
  dateStr: string
  isoStr: string
  sessionId: string
  messages: LmeSessionMessage[]
}

/** Parse LongMemEval date format: '2023/05/20 (Sat) 02:21' -> UTC ms + YYYY-MM-DD + ISO. */
export function parseLmeDate(dateStr: string): { timestampMs: number, dateStr: string, isoStr: string } {
  const match = /^(\d{4})\/(\d{2})\/(\d{2})\s+\(\w+\)\s+(\d{2}):(\d{2})/.exec(dateStr.trim())
  if (!match) throw new Error(`Cannot parse LongMemEval date: ${dateStr}`)
  const [, year, month, day, hour, minute] = match
  const isoDate = `${year}-${month}-${day}`
  const isoStr = `${isoDate}T${hour}:${minute}:00`
  const timestampMs = Date.parse(`${isoStr}Z`)
  if (!Number.isFinite(timestampMs)) throw new Error(`Invalid parsed timestamp for ${dateStr}`)
  return { timestampMs, dateStr: isoDate, isoStr }
}

/** Sort sessions chronologically and drop sessions strictly after question_date (same as ReMe run.py).
 * Defaults to label-free 'recent' truncation when maxSessions > 0; 'answer-aware' requires explicit opt-in. */
export function sortAndFilterLmeSessions(
  item: LmeItem,
  maxSessions = 0,
  sampling: LmeSessionSampling = 'recent',
): SortedLmeSession[] {
  const questionMs = item.question_date ? parseLmeDate(item.question_date).timestampMs : Number.POSITIVE_INFINITY
  const entries: SortedLmeSession[] = item.haystack_sessions.map((messages, originalIndex) => {
    const parsed = parseLmeDate(item.haystack_dates[originalIndex]!)
    return {
      originalIndex,
      ...parsed,
      sessionId: item.haystack_session_ids[originalIndex]!,
      messages,
    }
  })
  entries.sort((a, b) => a.timestampMs - b.timestampMs || a.originalIndex - b.originalIndex)
  const filtered = entries.filter(entry => entry.timestampMs <= questionMs)
  if (maxSessions <= 0 || filtered.length <= maxSessions) return filtered
  if (sampling === 'recent') {
    // Label-free truncation: keep the latest maxSessions sessions chronologically without consulting answer_session_ids.
    return filtered.slice(-maxSessions)
  }
  // Explicit opt-in answer-aware sampling: preserve answer_session_ids first, then fill with evenly spaced distractors.
  const answerSet = new Set(item.answer_session_ids)
  const mustKeep = filtered.filter(entry => answerSet.has(entry.sessionId))
  const distractors = filtered.filter(entry => !answerSet.has(entry.sessionId))
  const remaining = Math.max(0, maxSessions - mustKeep.length)
  const step = remaining > 0 ? distractors.length / remaining : 1
  const picked = new Set(mustKeep.map(entry => entry.sessionId))
  for (let i = 0; i < remaining && i < distractors.length; i++) {
    picked.add(distractors[Math.floor(i * step)]!.sessionId)
  }
  return filtered.filter(entry => picked.has(entry.sessionId))
}

/** True when truncation dropped at least one pre-question answer_session_id for a non-abstention item. */
export function hasTruncatedAnswerEvidence(item: LmeItem, sessions: readonly SortedLmeSession[]): boolean {
  if (String(item.question_id).endsWith('_abs') || !item.answer_session_ids.length) return false
  const questionMs = item.question_date ? parseLmeDate(item.question_date).timestampMs : Number.POSITIVE_INFINITY
  const kept = new Set(sessions.map(session => session.sessionId))
  const answerSet = new Set(item.answer_session_ids)
  for (let i = 0; i < item.haystack_session_ids.length; i++) {
    const id = item.haystack_session_ids[i]!
    if (!answerSet.has(id)) continue
    const ts = parseLmeDate(item.haystack_dates[i]!).timestampMs
    if (ts <= questionMs && !kept.has(id)) return true
  }
  return false
}

/** Deterministic stratified slice across all 6 LongMemEval categories (guarantees abstention coverage when perType >= 2). */
export function selectStratifiedLmeSlice(
  items: readonly LmeItem[],
  perType: number,
  excludeIds?: ReadonlySet<string>,
): {
  items: LmeItem[]
  sliceSha256: string
} {
  if (!Number.isSafeInteger(perType) || perType < 1) throw new Error(`Invalid perType: ${perType}`)
  const selected: LmeItem[] = []
  for (const type of LME_QUESTION_TYPES) {
    const pool = items
      .filter(item => item.question_type === type && !excludeIds?.has(item.question_id))
      .sort((a, b) => a.question_id.localeCompare(b.question_id))
    const regular = pool.filter(item => !String(item.question_id).endsWith('_abs'))
    const abstention = pool.filter(item => String(item.question_id).endsWith('_abs'))
    const pick: LmeItem[] = []
    const pickedIds = new Set<string>()
    const add = (item: LmeItem) => {
      if (pickedIds.has(item.question_id)) return
      pickedIds.add(item.question_id)
      pick.push(item)
    }
    // Include 1 abstention item in multi-session / knowledge-update / single-session-user when perType >= 2.
    const wantAbs = perType >= 2 && abstention.length > 0 && ['single-session-user', 'knowledge-update', 'multi-session'].includes(type) ? 1 : 0
    for (let i = 0; i < wantAbs; i++) {
      add(abstention[Math.floor((i * abstention.length) / wantAbs)]!)
    }
    const wantReg = Math.min(regular.length, perType - pick.length)
    for (let i = 0; i < wantReg; i++) {
      add(regular[Math.floor((i * regular.length) / wantReg)]!)
    }
    // Backfill with remaining abstention items if regular items ran short (e.g., after excludeIds or large perType).
    if (pick.length < perType) {
      const remainingAbs = abstention.filter(item => !pickedIds.has(item.question_id))
      const needMore = Math.min(remainingAbs.length, perType - pick.length)
      for (let i = 0; i < needMore; i++) {
        add(remainingAbs[Math.floor((i * remainingAbs.length) / needMore)]!)
      }
    }
    if (pick.length < perType) {
      throw new Error(`Insufficient LongMemEval items for category "${type}": requested ${perType}, available ${pool.length}`)
    }
    selected.push(...pick)
  }
  const sliceSha256 = createHash('sha256')
    .update(JSON.stringify(selected.map(item => item.question_id)))
    .digest('hex')
  return { items: selected, sliceSha256 }
}

export function loadLmeDataset(datasetPath: string): LmeItem[] {
  return JSON.parse(readFileSync(datasetPath, 'utf8')) as LmeItem[]
}

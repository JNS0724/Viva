import { createHash } from 'node:crypto'
import { looksSecret } from '../contracts/memory-sensitive.ts'

/** Raw question option shape before display normalization/truncation. */
export type RawQuestionOption = {
  label: string
  description?: string
}

/** Raw question card shape before display normalization/truncation. */
export type RawQuestionCard = {
  id: string
  question: string
  header?: string
  multiSelect?: boolean
  options?: readonly RawQuestionOption[]
}

/** Validated answer item shape matching DSH `ask_user_question`. */
export type RawQuestionAnswer = {
  id: string
  selected: readonly string[]
  custom?: string
}

/** One memory-eligible custom answer after privacy, NUL/surrogate, and structural screening. */
export type EligibleQuestionAnswer = {
  id: string
  question: string
  custom: string
}

/** One memory-eligible option selection after privacy, NUL/surrogate, and contextual-secret screening. */
export type EligibleQuestionSelection = {
  id: string
  question: string
  selected: string[]
}

const TRAILING_PROMPT_CHAR = /[\s?？:：!！。.,，;；]/u

/**
 * Reject NUL bytes and unpaired UTF-16 surrogates that SQLite (`node:sqlite`)
 * truncates or replaces on round-trip, which would break idempotency comparisons.
 */
export function hasUnsupportedSqliteChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code === 0) return true
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < value.length ? value.charCodeAt(i + 1) : 0
      if (next < 0xdc00 || next > 0xdfff) return true
      i++
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true
    }
  }
  return false
}

/**
 * Linear O(n) backward scan stripping trailing whitespace and prompt punctuation
 * before contextual `looksSecret` checks (avoids quadratic regex backtracking on
 * long padded headers).
 */
export function stripTrailingPromptPunctuation(label: string): string {
  let end = label.length
  while (end > 0 && TRAILING_PROMPT_CHAR.test(label[end - 1]!)) end--
  return end === label.length ? label : label.slice(0, end)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * Screen raw (pre-truncation) question cards for uniqueness, SQLite safety, and
 * credentials across EVERY string field (including options 9+ and >200-char headers).
 */
export function areRawCardsMemoryEligible(cards: readonly RawQuestionCard[]): boolean {
  if (!Array.isArray(cards) || cards.length === 0) return false
  const seen = new Set<string>()
  for (const card of cards) {
    if (!card || typeof card !== 'object') return false
    if (!isNonEmptyString(card.id) || !isNonEmptyString(card.question)) return false
    if (seen.has(card.id)) return false
    seen.add(card.id)
    if (hasUnsupportedSqliteChars(card.id) || looksSecret(card.id)) return false
    if (hasUnsupportedSqliteChars(card.question) || looksSecret(card.question)) return false
    if (card.header !== undefined) {
      if (typeof card.header !== 'string') return false
      if (hasUnsupportedSqliteChars(card.header) || looksSecret(card.header)) return false
    }
    if (card.options !== undefined) {
      if (!Array.isArray(card.options)) return false
      for (const option of card.options) {
        if (!option || typeof option !== 'object' || typeof option.label !== 'string') return false
        if (hasUnsupportedSqliteChars(option.label) || looksSecret(option.label)) return false
        if (option.description !== undefined) {
          if (typeof option.description !== 'string') return false
          if (hasUnsupportedSqliteChars(option.description) || looksSecret(option.description)) return false
        }
      }
    }
  }
  return true
}

export function answerHitsContextualSecret(card: RawQuestionCard, custom: string): boolean {
  const questionStem = stripTrailingPromptPunctuation(card.question)
  if (looksSecret(`${questionStem}: ${custom}`) || looksSecret(`${card.question}: ${custom}`)) return true
  if (card.header) {
    const headerStem = stripTrailingPromptPunctuation(card.header)
    if (looksSecret(`${headerStem}: ${custom}`) || looksSecret(`${card.header}: ${custom}`)) return true
  }
  return false
}

/**
 * Canonical projection of memory-eligible custom answers for one `ask_user_question`
 * occurrence. Used identically at host submission, DSH receipt creation, and log replay:
 * - rejects batches with invalid 1:1 card/answer correspondence or secret/lossy card fields;
 * - excludes selected-only answers, secret/lossy custom text, and split card+answer secrets
 *   (e.g., `"What is your OTP?"` + `"123456"`) while preserving safe sibling cards;
 * - returns entries canonically sorted by card `id`.
 */
export function eligibleQuestionAnswers(
  cards: readonly RawQuestionCard[],
  answers: readonly RawQuestionAnswer[],
): EligibleQuestionAnswer[] {
  if (!areRawCardsMemoryEligible(cards)) return []
  if (!Array.isArray(answers) || answers.length !== cards.length) return []
  const answerById = new Map<string, RawQuestionAnswer>()
  for (const answer of answers) {
    if (!answer || typeof answer !== 'object' || !isNonEmptyString(answer.id)) return []
    if (!Array.isArray(answer.selected) || !answer.selected.every((item: unknown) => typeof item === 'string')) return []
    if (answer.custom !== undefined && typeof answer.custom !== 'string') return []
    if (answerById.has(answer.id)) return []
    answerById.set(answer.id, answer)
  }
  const eligible: EligibleQuestionAnswer[] = []
  for (const card of cards) {
    const answer = answerById.get(card.id)
    if (!answer) return []
    const custom = typeof answer.custom === 'string' ? answer.custom.trim() : ''
    if (!custom) continue
    if (hasUnsupportedSqliteChars(custom) || looksSecret(custom)) continue
    if (answerHitsContextualSecret(card, custom)) continue
    eligible.push({ id: card.id, question: card.question, custom })
  }
  eligible.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return eligible
}

/** SHA-256 digest over ONLY the pre-filtered eligible `{ id, custom }` projection. */
export function canonicalEligibleAnswersDigest(eligible: readonly EligibleQuestionAnswer[]): string {
  return createHash('sha256')
    .update(JSON.stringify(eligible.map(({ id, custom }) => ({ id, custom }))))
    .digest('hex')
}

/**
 * Canonical projection of memory-eligible option selections for one `ask_user_question` occurrence:
 * - requires full raw-card eligibility (`areRawCardsMemoryEligible`) and 1:1 card/answer mapping;
 * - rejects multi-selection on single-select cards or options absent from `card.options`;
 * - normalizes `selected` in `card.options` definition order;
 * - screens every selected label and joined selection string with `answerHitsContextualSecret`
 *   (blocking split credentials such as `"验证码？"` + `"123456"`).
 */
export function eligibleQuestionSelections(
  cards: readonly RawQuestionCard[],
  answers: readonly RawQuestionAnswer[],
): EligibleQuestionSelection[] {
  if (!areRawCardsMemoryEligible(cards)) return []
  if (!Array.isArray(answers) || answers.length !== cards.length) return []
  const answerById = new Map<string, RawQuestionAnswer>()
  for (const answer of answers) {
    if (!answer || typeof answer !== 'object' || !isNonEmptyString(answer.id)) return []
    if (!Array.isArray(answer.selected) || !answer.selected.every((item: unknown) => typeof item === 'string')) return []
    if (answer.custom !== undefined && typeof answer.custom !== 'string') return []
    if (answerById.has(answer.id)) return []
    answerById.set(answer.id, answer)
  }
  const eligible: EligibleQuestionSelection[] = []
  for (const card of cards) {
    const answer = answerById.get(card.id)
    if (!answer) return []
    const uniqueSelected = [...new Set(answer.selected)]
    if (!card.multiSelect && uniqueSelected.length > 1) return []
    const optionLabels = (card.options ?? []).map(option => option.label)
    const allowedLabels = new Set(optionLabels)
    if (!uniqueSelected.every(label => allowedLabels.has(label))) return []
    if (uniqueSelected.length === 0) continue
    const selected = optionLabels.filter(label => uniqueSelected.includes(label) && label.trim().length > 0)
    const joined = selected.join('、')
    if (selected.length === 0 || !joined.trim()) continue
    if (selected.some(label => hasUnsupportedSqliteChars(label) || looksSecret(label) || answerHitsContextualSecret(card, label))) continue
    if (hasUnsupportedSqliteChars(joined) || looksSecret(joined) || answerHitsContextualSecret(card, joined)) continue
    eligible.push({ id: card.id, question: card.question, selected })
  }
  eligible.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return eligible
}

/** SHA-256 digest over ONLY the pre-filtered eligible `{ id, selected }` projection. */
export function canonicalEligibleSelectionsDigest(eligible: readonly EligibleQuestionSelection[]): string {
  return createHash('sha256')
    .update(JSON.stringify(eligible.map(({ id, selected }) => ({ id, selected }))))
    .digest('hex')
}

/** SHA-256 hash of provider `callId` (SQLite never stores raw provider `callId`). */
export function questionCallIdHash(callId: string): string {
  return createHash('sha256').update(callId).digest('hex')
}

/** Stable sibling-shared `requestId` for all cards in one `ask_user_question` occurrence. */
export function questionOccurrenceRequestId(callSeq: number, callIdHash: string): string {
  return `q:${callSeq}:${callIdHash.slice(0, 16)}`
}

/**
 * Deterministic UUIDv4-shaped source ID for one answered question card.
 * Includes `callSeq` so same-session `callId`/`questionId` reuse never collides.
 */
export function questionAnswerSourceId(
  sessionId: string,
  callSeq: number,
  callId: string,
  questionId: string,
): string {
  const digest = createHash('sha256')
    .update(JSON.stringify(['question-answer', sessionId, callSeq, callId, questionId]))
    .digest('hex')
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`
}

/**
 * Disjoint deterministic UUIDv4-shaped source ID for one option-selected question card.
 * Never collides with `questionAnswerSourceId` on mixed answers (`selected` + `custom`).
 */
export function questionSelectionSourceId(
  sessionId: string,
  callSeq: number,
  callId: string,
  questionId: string,
): string {
  const digest = createHash('sha256')
    .update(JSON.stringify(['question-selection', sessionId, callSeq, callId, questionId]))
    .digest('hex')
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`
}

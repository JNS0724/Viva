import type { MemoryDomainErrorCode } from '../contracts/domain-error.ts'
/** Optional wording supplied by a host; domain error codes and rules do not depend on its locale. */
const defaultText = Object.freeze({
  'change.pending': 'A memory change is in progress.',
  'credentials': 'Credentials cannot be stored as memory.',
  'invalid.text': 'Invalid memory text.',
  'not.found': 'Memory not found.',
  'operation.conflict': 'The operation ID was already used with different input.',
  'restore.explicit': 'Explicit restoration is required.',
  'revision.conflict': 'Memory changed. Refresh before trying again.',
  'clarify.pending.ended': 'No longer applies',
  'clarify.negative': 'Not {value}',
  'clarify.pending.event.question': 'Has this condition happened: {event}?',
  'clarify.pending.dated.question': 'Which statement applied on {date}?',
  'clarify.pending.question': 'Which statement applies?',
  'clarify.pending.current': 'Keep the saved statement: {value}',
  'clarify.pending.alternative': 'Use the alternative: {value}',
  'clarify.dated.question': 'Which statement applied on {date}?',
  'clarify.question': 'Which statement applies?',
  'clarify.file.question': 'What should I use for {topic} in this request?',
})
export type MemoryTextKey = keyof typeof defaultText
export type MemoryTextValues = Readonly<Record<string, string | number>>
export interface MemoryPresentation {
  profileLabels?: () => readonly { key: string, label: string }[]
  text?: (key: MemoryTextKey, values?: MemoryTextValues) => string
}
export function defaultMemoryText(key: MemoryTextKey, values: MemoryTextValues = {}): string {
  return defaultText[key].replace(/\{(\w+)\}/g, (slot, name: string) => Object.hasOwn(values, name) ? String(values[name]) : slot)
}
export class MemoryDomainError extends Error {
  readonly code: MemoryDomainErrorCode
  constructor(code: MemoryDomainErrorCode, message = defaultMemoryText(code)) {
    super(message)
    this.name = 'MemoryDomainError'
    this.code = code
  }
}

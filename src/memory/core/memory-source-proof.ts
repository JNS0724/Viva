import type { DocumentSourceRef } from './ports/documents.ts'

export function documentSourceProofCurrent(ref: DocumentSourceRef, text: string, token: string): boolean {
  return ref.token === token && (!ref.spans || ref.spans.length > 0 && ref.spans.every(({ start, end }) =>
    Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end > start && end <= text.length))
}

import type {} from '@deepseek-ai/dsh-llm'
import type { SteerMessageSource } from '../../../src/shared/request-routing/provenance.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'viva-memory': { kind: 'viva-memory', form?: 'recall' }
    'viva-memory-recovery': { kind: 'viva-memory-recovery', ticketId: string, originalMessageIds: string[] }
    'viva-main-human-steer': Extract<SteerMessageSource, { kind: 'viva-main-human-steer' }>
    'viva-task-human-steer': Extract<SteerMessageSource, { kind: 'viva-task-human-steer' }>
    'viva-task-router-message': Extract<SteerMessageSource, { kind: 'viva-task-router-message' }>
  }
}
/** Generated memory context is never an original user source. */
export const memorySource = { kind: 'viva-memory' } as const

/** Native DSH schedules do not carry the creating session's memory read set in this DSH version.
 * A fresh target session is not evidence that their stored prompt is independent of forgotten memory.
 * Viva scheduled deliveries use the trusted host alias protocol instead of this unsupported source.
 */
export function assertMemorySourceSupported(kind: string) {
  if (kind === 'schedule') throw new Error('Native DSH scheduled prompts require verified memory provenance')
}

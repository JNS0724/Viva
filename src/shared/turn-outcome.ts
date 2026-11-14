import { t } from './i18n/translate.ts'

/** Incomplete turns retain their partial output and explain why a final reply is unavailable. */
export function turnProblem(stopReason: string | undefined): string | null {
  if (stopReason === 'max_tokens') return t('turn.output.limit')
  if (stopReason === 'no_response') return t('turn.no.final.reply')
  return null
}

import { t } from '../../shared/i18n/translate.ts'
import type { PluginFit } from '../capability-types.ts'

/**
 * Whether a plugin works in Viva (backend/plugin-fit.ts), as the 插件 views say it: an installed one's facts
 * (view/capability-plugins.ts), one about to be installed (view/plugins.ts), one the company source has
 * (view/plugin-catalog.ts).
 */

/** What is known of it in Viva, in words; null when nothing can be told. */
export function fitText(fit: PluginFit): string | null {
  if (fit.kind === 'declared') return t('plugins.fit.declared')
  if (fit.kind === 'no-conflict') return t('plugins.fit.no.conflict')
  if (fit.kind === 'web-part') return t('plugins.fit.web.part')
  if (fit.kind === 'needs-web') return t('plugins.fit.needs.web', { needs: fit.needs.join('、') })
  return null
}

/** Its tone beside a name (`.ext-status[data-tone]`): off when it cannot work here, ok when its author says it does. */
export const fitTone = (fit: PluginFit): 'off' | 'ok' | 'idle' => (fit.kind === 'needs-web' ? 'off' : fit.kind === 'declared' ? 'ok' : 'idle')

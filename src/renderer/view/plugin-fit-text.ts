import { t } from '../../shared/i18n/translate.ts'
import type { PluginFit } from '../capability-types.ts'

/**
 * Whether a plugin works in Viva (backend/plugin-fit.ts), as the 插件 views say it: an installed one's facts
 * (view/capability-plugins.ts), one about to be installed (view/plugins.ts), one the company source has
 * (view/plugin-catalog.ts).
 */

/** The manifest finding in the catalogue, preview, or installed details. */
export function fitText(fit: PluginFit): string {
  if (fit.kind === 'declared') return t('plugins.fit.declared')
  if (fit.kind === 'no-conflict') return t('plugins.fit.no.conflict')
  if (fit.kind === 'web-part') return t('plugins.fit.web.part')
  if (fit.kind === 'needs-web') return t('plugins.fit.needs.web')
  if (fit.kind === 'dsh-version') return t('plugins.fit.dsh.version')
  return t('plugins.fit.unknown')
}

export const fitTone = (fit: PluginFit): 'off' | 'idle' => fit.kind === 'needs-web' || fit.kind === 'dsh-version' ? 'off' : 'idle'

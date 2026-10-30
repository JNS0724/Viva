import { onLocaleChange } from './i18n/locale.ts'
import { t } from './i18n/translate.ts'
/** The existing main/task IPC limit, also checked before a renderer clears or forks a draft. */
export const MAX_MESSAGE_CHARS = 20_000
export let MESSAGE_TOO_LONG = t('input.too.long')
onLocaleChange(() => { MESSAGE_TOO_LONG = t('input.too.long') })

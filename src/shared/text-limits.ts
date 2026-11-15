import { onLocaleChange } from './i18n/locale.ts'
import { t } from './i18n/translate.ts'
export { MAX_MESSAGE_CHARS } from '../memory/contracts/text-limits.ts'
export let MESSAGE_TOO_LONG = t('input.too.long')
onLocaleChange(() => { MESSAGE_TOO_LONG = t('input.too.long') })

import { t } from './i18n/translate.ts'
/**
 * The fields of the user's profile ("关于你"). Shared by the main process (storage, the memory tools,
 * the context sent with each prompt) and the renderer (the profile page and the intro form).
 */
export interface ProfileField { key: string, label: string, hint: string }

export const PROFILE_FIELDS: readonly ProfileField[] = Object.freeze([
  { key: 'role', get label() { return t('profile.role') }, get hint() { return t('profile.role.hint') } },
  { key: 'projects', get label() { return t('profile.projects') }, get hint() { return t('profile.projects.hint') } },
  { key: 'preferences', get label() { return t('profile.preferences') }, get hint() { return t('profile.preferences.hint') } },
])

export const PROFILE_KEYS: readonly string[] = Object.freeze(PROFILE_FIELDS.map((field) => field.key))
export const MAX_FIELD_CHARS = 1000


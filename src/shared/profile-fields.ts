import { t } from './i18n/translate.ts'
/**
 * The fields of the user's profile ("关于你"). Shared by the main process (storage, the memory tools,
 * the context sent with each prompt) and the renderer (the profile page and the intro form).
 */
export interface ProfileField { key: string, label: string, hint: string }

/** kind: the memory it becomes; names: its text is also the memory's keyword; private: never moved, shown or sent. */
export interface RetiredField { key: string, label: string, kind?: string, names?: boolean, private?: boolean }

export const PROFILE_FIELDS: readonly ProfileField[] = Object.freeze([
  { key: 'role', get label() { return t('profile.role') }, get hint() { return t('profile.role.hint') } },
  { key: 'projects', get label() { return t('profile.projects') }, get hint() { return t('profile.projects.hint') } },
  { key: 'preferences', get label() { return t('profile.preferences') }, get hint() { return t('profile.preferences.hint') } },
])

/**
 * Fields the profile had up to 0.2.1. What the user wrote in them becomes their own memories once (the
 * memory store's migration), so it stays visible and editable, with `kind` and, for `names` fields, the
 * name as a keyword. The email is private: it is not moved, shown or sent to the model.
 */
export const RETIRED_FIELDS: readonly RetiredField[] = Object.freeze([
  { key: 'department', label: '部门', kind: 'role', names: true },
  { key: 'domain', label: '领域', kind: 'role', names: true },
  { key: 'people', label: '常打交道的人', kind: 'person', names: true },
  { key: 'sources', label: '常用网站和文档', kind: 'fact', names: false },
  { key: 'email', label: '工作邮箱', private: true },
  { key: 'im', label: '工作 IM', kind: 'fact', names: false },
])

export const PROFILE_KEYS: readonly string[] = Object.freeze(PROFILE_FIELDS.map((field) => field.key))
export const MAX_FIELD_CHARS = 1000

export const fieldLabel = (key: string): string => [...PROFILE_FIELDS, ...RETIRED_FIELDS].find((field) => field.key === key)?.label ?? key

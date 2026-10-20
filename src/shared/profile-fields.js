/**
 * The fields of the user's profile ("关于你"). Shared by the main process (storage, the memory tools,
 * the context sent with each prompt) and the renderer (the profile page and the intro form).
 */
export const PROFILE_FIELDS = Object.freeze([
  { key: 'role', label: '角色与职责', hint: '例如：支付平台部的后端负责人，负责清结算' },
  { key: 'projects', label: '在推进的事', hint: '例如：Q4 对账系统重构，每周四上线' },
  { key: 'preferences', label: '偏好与习惯', hint: '例如：回答先给结论；对比方案时用表格' },
])

/**
 * Fields the profile had up to 0.2.1. What the user wrote in them becomes their own memories once (the
 * memory store's migration), so it stays visible and editable, with `kind` and, for `names` fields, the
 * name as a keyword. The email is private: it is not moved, shown or sent to the model.
 */
export const RETIRED_FIELDS = Object.freeze([
  { key: 'department', label: '部门', kind: 'role', names: true },
  { key: 'domain', label: '领域', kind: 'role', names: true },
  { key: 'people', label: '常打交道的人', kind: 'person', names: true },
  { key: 'sources', label: '常用网站和文档', kind: 'fact', names: false },
  { key: 'email', label: '工作邮箱', private: true },
  { key: 'im', label: '工作 IM', kind: 'fact', names: false },
])

export const PROFILE_KEYS = Object.freeze(PROFILE_FIELDS.map((field) => field.key))
export const MAX_FIELD_CHARS = 1000

/** @param {string} key @returns {string} */
export const fieldLabel = (key) => [...PROFILE_FIELDS, ...RETIRED_FIELDS].find((field) => field.key === key)?.label ?? key

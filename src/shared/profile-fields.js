/**
 * The fields of the user's profile ("关于你"). Shared by the main process (storage, the memory tools,
 * the context sent with each prompt) and the renderer (the profile page and the intro form).
 */
export const PROFILE_FIELDS = Object.freeze([
  { key: 'role', label: '角色与职责', hint: '例如：支付平台的后端负责人，负责清结算' },
  { key: 'department', label: '部门', hint: '例如：支付平台部' },
  { key: 'domain', label: '领域', hint: '例如：清结算、风控' },
  { key: 'projects', label: '在推进的事', hint: '例如：Q4 对账系统重构，每周四上线' },
  { key: 'people', label: '常打交道的人', hint: '例如：张三（上级）、李四（风控对接人）' },
  { key: 'preferences', label: '偏好与习惯', hint: '例如：回答先给结论；对比方案时用表格' },
  { key: 'sources', label: '常用网站和文档', hint: '一行一个网址或文档' },
  { key: 'email', label: '工作邮箱', hint: '可以留空，以后接入邮件时使用' },
  { key: 'im', label: '工作 IM', hint: '可以留空，例如：飞书、钉钉、企业微信、Slack' },
])

export const PROFILE_KEYS = Object.freeze(PROFILE_FIELDS.map((field) => field.key))
export const MAX_FIELD_CHARS = 1000

/** @param {string} key @returns {string} */
export const fieldLabel = (key) => PROFILE_FIELDS.find((field) => field.key === key)?.label ?? key

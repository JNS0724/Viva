/**
 * dsh asks for approval with the tool call's id only (dsh-acp sends `toolCall: { toolCallId }` and English
 * option names): what is to be approved comes from the tool call it announced just before, which carries the
 * tool's name and arguments.
 */
const COMMAND_TOOLS = new Set(['bash', 'pwsh'])
const WRITE_TOOLS = new Set(['write'])
const EDIT_TOOLS = new Set(['edit', 'str_replace_editor'])
const COMMAND_LIMIT = 60

/** The app's own configuration tools (viva-config plugin), said plainly. */
const CONFIG_TITLES = {
  viva_mcp_add: (input) => `接入 MCP 服务器「${input?.name ?? ''}」`,
  viva_mcp_remove: (input) => `移除 MCP 服务器「${input?.name ?? ''}」`,
  viva_skill_create: (input) => `新建 skill「${input?.name ?? ''}」`,
  viva_skill_install: (input) => `安装 skill：${input?.path ?? ''}`,
  viva_skill_remove: (input) => `删除 skill「${input?.id ?? ''}」`,
}

/** What each kind of answer is called on the card, whatever dsh names it. */
const OPTION_NAMES = { allow_once: '允许', allow_always: '总是允许', reject_once: '拒绝', reject_always: '总是拒绝' }

const fileName = (input) => String(input?.path ?? input?.file_path ?? '').split(/[\\/]/).filter(Boolean).pop() ?? ''

function oneLine(text) {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > COMMAND_LIMIT ? `${line.slice(0, COMMAND_LIMIT - 1)}…` : line
}

/**
 * A short title for the card: the command to run, the file to write or change, else the tool's name.
 * @param {{ title: string, rawInput?: object } | null | undefined} tool the announced tool call
 * @returns {string | null}
 */
export function approvalTitle(tool) {
  if (!tool) return null
  const input = tool.rawInput
  if (CONFIG_TITLES[tool.title]) return CONFIG_TITLES[tool.title](input)
  if (COMMAND_TOOLS.has(tool.title) && typeof input?.command === 'string') return `运行命令：${oneLine(input.command)}`
  const file = fileName(input)
  if (WRITE_TOOLS.has(tool.title) && file) return `写入 ${file}`
  if (EDIT_TOOLS.has(tool.title) && file) return `修改 ${file}`
  return tool.title
}

/** @param {{ name: string, kind?: string }} option @returns {string} */
export const optionName = (option) => OPTION_NAMES[option.kind] ?? option.name

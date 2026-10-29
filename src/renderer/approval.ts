import { onLocaleChange } from '../shared/i18n/locale.ts'
import { t } from '../shared/i18n/translate.ts'
/**
 * dsh asks for approval with the tool call's id only (dsh-acp sends `toolCall: { toolCallId }` and English
 * option names): what is to be approved comes from the tool call it announced just before, which carries the
 * tool's name and arguments.
 */
const COMMAND_TOOLS = new Set(['bash', 'pwsh'])
const WRITE_TOOLS = new Set(['write'])
const EDIT_TOOLS = new Set(['edit', 'str_replace_editor'])
const COMMAND_LIMIT = 60

/** A tool call's arguments, as the agent announced them. */
type ToolInput = Record<string, any> | null | undefined

/** The app's own configuration tools (viva-config plugin), said plainly. */
const CONFIG_TITLES: Readonly<Record<string, (input: ToolInput) => string>> = {
  viva_mcp_add: (input) => t("approval.connect.mcp.server", { value1: input?.name ?? '' }),
  viva_mcp_remove: (input) => t("approval.remove.mcp.server", { value1: input?.name ?? '' }),
  viva_skill_create: (input) => t("approval.create.skill", { value1: input?.name ?? '' }),
  viva_skill_install: (input) => t("approval.install.skill", { value1: input?.path ?? '' }),
  viva_skill_remove: (input) => t("approval.delete.skill", { value1: input?.id ?? '' }),
}

/** What each kind of answer is called on the card, whatever dsh names it. */
let OPTION_NAMES: Readonly<Record<string, string>> = { allow_once: t("approval.allow"), allow_always: t("approval.always.allow"), reject_once: t("approval.deny"), reject_always: t("approval.always.deny") }

const fileName = (input: ToolInput) => String(input?.path ?? input?.file_path ?? '').split(/[\\/]/).filter(Boolean).pop() ?? ''

function oneLine(text: string) {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > COMMAND_LIMIT ? `${line.slice(0, COMMAND_LIMIT - 1)}…` : line
}

/**
 * A short title for the card: the command to run, the file to write or change, else the tool's name.
 * @param tool the announced tool call
 */
export function approvalTitle(tool: { title: string, rawInput?: ToolInput } | null | undefined): string | null {
  if (!tool) return null
  const input = tool.rawInput
  if (CONFIG_TITLES[tool.title]) return CONFIG_TITLES[tool.title](input)
  if (COMMAND_TOOLS.has(tool.title) && typeof input?.command === 'string') return t("approval.run.command", { value1: oneLine(input.command) })
  const file = fileName(input)
  if (WRITE_TOOLS.has(tool.title) && file) return t("approval.write", { file: file })
  if (EDIT_TOOLS.has(tool.title) && file) return t("approval.edit", { file: file })
  return tool.title
}

export const optionName = (option: { name: string, kind?: string }): string => OPTION_NAMES[option.kind ?? ''] ?? option.name

onLocaleChange(() => {
  OPTION_NAMES = { allow_once: t("approval.allow"), allow_always: t("approval.always.allow"), reject_once: t("approval.deny"), reject_always: t("approval.always.deny") }
})

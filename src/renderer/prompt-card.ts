import { permissionDetail } from './selectors.ts'

/**
 * What waits on the user, as both hosts show it: the card in the thread (view/thread.js) and the desktop
 * island's panel (view/island-dom.js). They draw it at their own size; what it says and which button matters
 * come from here, so the two do not drift apart.
 */
export { PROMPT_HEADS } from './selectors.ts'

const COMMAND_TITLE = '运行命令'

/** A tool call whose only argument is the command it runs. */
const commandOf = (rawInput: Record<string, any> | null | undefined): string => (typeof rawInput?.command === 'string' && Object.keys(rawInput).length === 1 ? rawInput.command : '')

/** Buttons by role: the main one (the first that allows, filled), the others (outlined). */
export function promptButtons(options: readonly PermissionOption[]): Array<PermissionOption & { role: 'primary' | 'secondary' }> {
  const main = options.findIndex((option) => option.kind?.startsWith('allow'))
  return options.map((option, i) => ({ ...option, role: i === main ? 'primary' : 'secondary' }))
}

/**
 * An approval's title and what it is about. A command is titled as one and shown in full below, not in the
 * title; `command` is that text, the one line the island shows.
 */
export function permissionCard(permission: { title: string, rawInput?: Record<string, any> | null }): { title: string, detail: string, command: string } {
  const command = commandOf(permission.rawInput)
  return { title: command ? COMMAND_TITLE : permission.title, detail: permissionDetail(permission), command }
}

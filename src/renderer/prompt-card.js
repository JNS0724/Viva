import { permissionDetail } from './selectors.js'

/**
 * What waits on the user, as both hosts show it: the card in the thread (view/thread.js) and the desktop
 * island's panel (view/island-dom.js). They draw it at their own size; what it says and which button matters
 * come from here, so the two do not drift apart.
 */
export { PROMPT_HEADS } from './selectors.js'

const COMMAND_TITLE = '运行命令'

/** A tool call whose only argument is the command it runs. */
const commandOf = (rawInput) => (typeof rawInput?.command === 'string' && Object.keys(rawInput).length === 1 ? rawInput.command : '')

/**
 * Buttons by role: the main one (the first that allows, filled), the others (outlined).
 * @param {{ kind?: string }[]} options @returns {object[]} each option with its `role`
 */
export function promptButtons(options) {
  const main = options.findIndex((option) => option.kind?.startsWith('allow'))
  return options.map((option, i) => ({ ...option, role: i === main ? 'primary' : 'secondary' }))
}

/**
 * An approval's title and what it is about. A command is titled as one and shown in full below, not in the
 * title; `command` is that text, the one line the island shows.
 * @param {{ title: string, rawInput?: object | null }} permission
 * @returns {{ title: string, detail: string, command: string }}
 */
export function permissionCard(permission) {
  const command = commandOf(permission.rawInput)
  return { title: command ? COMMAND_TITLE : permission.title, detail: permissionDetail(permission), command }
}

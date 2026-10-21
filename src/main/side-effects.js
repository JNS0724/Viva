/**
 * What a path of the conversation did to the computer, from the trace plugin's steps (plugins/trace): the files
 * it wrote and the commands it ran. Going back over them does not undo them, so the window says so first.
 */
const WRITES = new Set(['write', 'edit'])
const RUNS = new Set(['bash'])
/** A failed or refused step changed nothing. */
const CHANGED_NOTHING = new Set(['failed', 'rejected', 'denied', 'cancelled'])
const MAX_ITEMS = 8
const MAX_COMMAND_CHARS = 120

const cut = (text) => (text.length > MAX_COMMAND_CHARS ? `${text.slice(0, MAX_COMMAND_CHARS)}…` : text)

/**
 * @param {{ at: number, kind: string, name?: string, args?: object, status?: string }[]} steps in order
 * @param {number} since ms: only what happened from then on
 * @returns {{ files: { path: string, times: number }[], commands: string[] }}
 */
export function sideEffectsOf(steps, since) {
  const done = steps.filter((step) => step.kind === 'tool' && step.at >= since && !CHANGED_NOTHING.has(step.status))
  const writes = new Map()
  for (const step of done.filter((s) => WRITES.has(s.name) && typeof s.args?.file_path === 'string')) {
    writes.set(step.args.file_path, (writes.get(step.args.file_path) ?? 0) + 1)
  }
  const commands = done.filter((s) => RUNS.has(s.name) && typeof s.args?.command === 'string').map((s) => cut(s.args.command))
  return {
    files: [...writes].slice(0, MAX_ITEMS).map(([path, times]) => ({ path, times })),
    commands: commands.slice(0, MAX_ITEMS),
  }
}

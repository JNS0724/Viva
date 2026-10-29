import { onLocaleChange } from '../../shared/i18n/locale.ts'
import { t } from '../../shared/i18n/translate.ts'
import { h } from './dom.ts'

/**
 * Going back to something the user said (phase 2, rewind-state.js): the small bar over a message of theirs,
 * the message turned into an editor in place (改了重发), and the paths left behind, folded where they went
 * another way.
 */

/** Over a message of the user's, on hover: say it again from here, or change it first. */
/** A part of the timeline folded away (rewind-state.ts): its id, how many messages, and whether a task took it. */
type Fold = { id: string, count: number, kind?: string | null }
type FoldOptions = { opened: readonly ThreadMessage[] | undefined, handlers: Handlers, messageView: (message: ThreadMessage) => View, tasks?: State['tasks'] }
/** Where the editor's cursor was, before the thread was rebuilt. */
type EditorFocus = { start: number | null, end: number | null }

export function rewindBar(message: ThreadMessage, handlers: Handlers) {
  return h('div', { class: 'rewind-bar', role: 'toolbar', 'aria-label': t("rewind.return.to.this.message") },
    h('button', { class: 'rewind-act', type: 'button', title: t("rewind.return.before.this.message.and.ask.again"), text: t("rewind.start.again.here"), onClick: () => handlers.redoFrom(message.id) }),
    h('button', { class: 'rewind-act', type: 'button', title: t("rewind.edit.and.resend.later.messages.will.be"), text: t("rewind.edit.and.resend"), onClick: () => handlers.editFrom(message.id) }))
}

/**
 * The editor lives across renders (the thread is rebuilt whenever the state changes): what is typed and where
 * the cursor is stay, and it keeps the keyboard.
 */
let editor: ReturnType<typeof makeEditor> | null = null

function makeEditor(message: ThreadMessage, handlers: Handlers, later: number) {
  const field = h('textarea', { class: 'rewind-field', rows: 2, 'aria-label': t("rewind.edit.and.resend.2") })
  field.value = message.text
  const send = () => handlers.submitEdit(message.id, field.value)
  field.addEventListener('keydown', (event) => {
    if (event.isComposing) return
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      send()
    } else if (event.key === 'Escape') {
      event.stopPropagation()
      handlers.cancelEdit()
    }
  })
  const el = h('div', { class: 'rewind-editor' },
    field,
    h('div', { class: 'rewind-editor-row' },
      // The old words fold too: the path left behind starts with them.
      h('span', { class: 'rewind-hint', text: later ? t("rewind.this.message.and.the.next.will.be", { later: later }) : t("rewind.this.message.will.be.folded.away.not") }),
      h('button', { class: 'btn btn-text', type: 'button', text: t("extensions.cancel"), onClick: () => handlers.cancelEdit() }),
      h('button', { class: 'btn btn-primary rewind-send', type: 'button', text: t("rewind.resend"), onClick: send })))
  return { id: message.id, el, field, fresh: true }
}

/** @param later how many messages after it would fold */
export function rewindEditor(message: ThreadMessage, handlers: Handlers, later: number) {
  if (!editor || editor.id !== message.id) editor = makeEditor(message, handlers, later)
  return editor.el
}

/** Before the thread is rebuilt: whether the editor has the keyboard, and where its cursor is. */
export function editorFocus(): EditorFocus | null {
  if (!editor || document.activeElement !== editor.field) return editor?.fresh ? { start: editor.field.value.length, end: editor.field.value.length } : null
  return { start: editor.field.selectionStart, end: editor.field.selectionEnd }
}

/** After the thread is rebuilt: the editor gets the keyboard back (or for the first time), cursor where it was. */
export function restoreEditorFocus(focus: EditorFocus | null, editingId: string | null) {
  if (editor && editor.id !== editingId) editor = null
  if (!editor || !focus) return
  editor.fresh = false
  editor.field.focus({ preventScroll: true })
  editor.field.setSelectionRange(focus.start, focus.end)
}

const timesNote = (times: number) => (times > 1 ? t("rewind.edited.times", { times: times }) : '')

/** What going back would not undo (timeline:rewind-effects), as the question shown asks it. */
type Confirm = { id: string, text: string, effects: { files: ReadonlyArray<{ path: string, times: number }>, commands: readonly string[] } }
let shownConfirm: Confirm | null = null

/**
 * Before going back over a part that wrote files or ran commands: what will not be undone, and that the agent
 * will not know about it. Shown only then; built once per question so its button keeps the keyboard.
 */
export function renderRewindConfirm(root: HTMLElement, state: State, handlers: Handlers) {
  const asked: Confirm | null = state.rewind.confirm
  if (asked === shownConfirm) return
  shownConfirm = asked
  if (!asked) return root.replaceChildren()
  const { files, commands } = asked.effects
  root.replaceChildren(h('div', { class: 'workdir-scrim', onClick: () => handlers.cancelRewindConfirm() }),
    h('div', { class: 'workdir-sheet rewind-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': t("rewind.these.changes.will.not.be.undone") },
      h('div', { class: 'workdir-sheet-title', text: t("rewind.these.changes.will.not.be.undone") }),
      h('p', { class: 'workdir-sheet-text', text: t("rewind.the.conversation.restarts.before.this.message.but") }),
      h('ul', { class: 'rewind-effects' },
        ...files.map((file) => h('li', {}, h('span', { class: 'rewind-effect-kind', text: t("rewind.writes") }), h('code', { text: file.path }), timesNote(file.times))),
        ...commands.map((command) => h('li', {}, h('span', { class: 'rewind-effect-kind', text: t("rewind.commands") }), h('code', { text: command })))),
      h('p', { class: 'workdir-sheet-text', text: t("rewind.the.restarted.assistant.will.not.know.about") }),
      h('div', { class: 'workdir-sheet-actions' },
        h('button', { class: 'btn btn-secondary', type: 'button', text: t("extensions.cancel"), onClick: () => handlers.cancelRewindConfirm() }),
        h('button', { class: 'btn btn-primary rewind-confirm', type: 'button', text: t("rewind.understood.restart"), onClick: () => handlers.confirmRewind() }))))
  return root.querySelector<HTMLElement>('.rewind-confirm')?.focus()
}

/**
 * A path left behind, folded where the conversation went another way: opened, what it holds is shown under it,
 * read-only; switched to, it is the conversation again and this one folds in its place.
 */
export function foldStrip(fold: Fold, { opened, handlers, messageView, tasks }: FoldOptions): View[] {
  if (fold.kind === 'task') return taskStrip(fold, { opened, handlers, messageView, tasks })
  const strip = h('div', { class: 'fold', role: 'group', 'aria-label': t("rewind.another.branch"), 'data-fold': fold.id },
    h('span', { class: 'fold-ico', 'aria-hidden': 'true', text: '⑂' }),
    h('span', { text: t("rewind.another.branch.2") }),
    h('b', { text: t("rewind.messages", { count: fold.count }) }),
    h('span', { class: 'fold-actions' },
      h('button', { class: 'fold-act', type: 'button', 'aria-expanded': String(Boolean(opened)), text: opened ? t("rewind.collapse") : t("rewind.expand.to.view"), onClick: () => handlers.toggleFold(fold.id) }),
      h('button', { class: 'fold-act', type: 'button', text: t("rewind.switch.to.this.branch"), onClick: () => handlers.switchPath(fold.id) })))
  return withBody(strip, fold, { opened, messageView })
}

function withBody(strip: HTMLElement, fold: Fold, { opened, messageView }: Pick<FoldOptions, 'opened' | 'messageView'>): View[] {
  if (!opened) return [strip]
  return [strip, h('div', { class: 'fold-body' }, ...opened.flatMap((message, i) => [messageView({ ...message, id: `${fold.id}-${i}` })].flat()))]
}

let TASK_STATUS: Readonly<Record<string, string>> = { running: t("rewind.running.in.background"), waiting: t("rewind.waiting.for.you.in.background"), done: t("island-view.done"), stopped: t("island-view.stopped.2"), error: t("island-view.something.went.wrong") }

/**
 * Where a turn moved to the background (tasks-state.js): what it is doing now, and 撤销 while the move can
 * still be undone. Once it is no longer running here, what it said can be opened like a path.
 */
function taskStrip(fold: Fold, { opened, handlers, messageView, tasks }: FoldOptions) {
  const task: BackgroundTask | undefined = tasks?.list.find((entry: BackgroundTask) => entry.segmentId === fold.id)
  const undoable = task && tasks?.undo?.taskId === task.id
  const status = task?.status === 'running' && task.now ? t("island-tasks.currently", { now: task.now }) : TASK_STATUS[task?.status ?? ''] ?? t("rewind.messages", { count: fold.count })
  const live = task?.status === 'running' || task?.status === 'waiting'
  const strip = h('div', { class: 'fold fold-task', role: 'group', 'aria-label': t("rewind.task.moved.to.background"), 'data-fold': fold.id },
    h('span', { class: 'fold-ico', 'aria-hidden': 'true', text: '↗' }),
    h('span', { text: task ? t("rewind.continued.in.background") : t("rewind.previously.ran.in.background") }),
    task ? h('span', { class: 'fold-tag', title: task.words, text: `#${task.title}` }) : null,
    h('span', { class: 'fold-status', text: `· ${status}` }),
    h('span', { class: 'fold-actions' },
      undoable ? h('button', { class: 'fold-act', type: 'button', title: t("rewind.restore.as.an.interruption.as.if.nothing"), text: t("memory-actions.undo"), onClick: () => handlers.undoMove() }) : null,
      live ? null : h('button', { class: 'fold-act', type: 'button', 'aria-expanded': String(Boolean(opened)), text: opened ? t("rewind.collapse") : t("rewind.expand.to.view"), onClick: () => handlers.toggleFold(fold.id) })))
  return withBody(strip, fold, { opened: live ? undefined : opened, messageView })
}

onLocaleChange(() => {
  TASK_STATUS = { running: t("rewind.running.in.background"), waiting: t("rewind.waiting.for.you.in.background"), done: t("island-view.done"), stopped: t("island-view.stopped.2"), error: t("island-view.something.went.wrong") }
})

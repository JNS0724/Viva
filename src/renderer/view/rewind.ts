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
  return h('div', { class: 'rewind-bar', role: 'toolbar', 'aria-label': '回到这句话' },
    h('button', { class: 'rewind-act', type: 'button', title: '回到这句话之前，原话再问一次', text: '↺ 从这里重来', onClick: () => handlers.redoFrom(message.id) }),
    h('button', { class: 'rewind-act', type: 'button', title: '改一改再发，后面的会折起来', text: '✎ 改了重发', onClick: () => handlers.editFrom(message.id) }))
}

/**
 * The editor lives across renders (the thread is rebuilt whenever the state changes): what is typed and where
 * the cursor is stay, and it keeps the keyboard.
 */
let editor: ReturnType<typeof makeEditor> | null = null

function makeEditor(message: ThreadMessage, handlers: Handlers, later: number) {
  const field = h('textarea', { class: 'rewind-field', rows: 2, 'aria-label': '改了重发' })
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
      h('span', { class: 'rewind-hint', text: later ? `原来这句和后面 ${later} 条会折起来，不会删` : '原来这句会折起来，不会删' }),
      h('button', { class: 'btn btn-text', type: 'button', text: '取消', onClick: () => handlers.cancelEdit() }),
      h('button', { class: 'btn btn-primary rewind-send', type: 'button', text: '重新发送', onClick: send })))
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

const timesNote = (times: number) => (times > 1 ? `（改过 ${times} 次）` : '')

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
    h('div', { class: 'workdir-sheet rewind-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': '这些改动不会跟着撤回' },
      h('div', { class: 'workdir-sheet-title', text: '这些改动不会跟着撤回' }),
      h('p', { class: 'workdir-sheet-text', text: '回到这句话之前，对话会重来；但后面那段已经对电脑做过的事，Viva 改不回去：' }),
      h('ul', { class: 'rewind-effects' },
        ...files.map((file) => h('li', {}, h('span', { class: 'rewind-effect-kind', text: '写入' }), h('code', { text: file.path }), timesNote(file.times))),
        ...commands.map((command) => h('li', {}, h('span', { class: 'rewind-effect-kind', text: '命令' }), h('code', { text: command })))),
      h('p', { class: 'workdir-sheet-text', text: '助手重来时不知道这些改动；要紧的话，在新的话里提一句。' }),
      h('div', { class: 'workdir-sheet-actions' },
        h('button', { class: 'btn btn-secondary', type: 'button', text: '取消', onClick: () => handlers.cancelRewindConfirm() }),
        h('button', { class: 'btn btn-primary rewind-confirm', type: 'button', text: '知道了，重来', onClick: () => handlers.confirmRewind() }))))
  return root.querySelector<HTMLElement>('.rewind-confirm')?.focus()
}

/**
 * A path left behind, folded where the conversation went another way: opened, what it holds is shown under it,
 * read-only; switched to, it is the conversation again and this one folds in its place.
 */
export function foldStrip(fold: Fold, { opened, handlers, messageView, tasks }: FoldOptions): View[] {
  if (fold.kind === 'task') return taskStrip(fold, { opened, handlers, messageView, tasks })
  const strip = h('div', { class: 'fold', role: 'group', 'aria-label': '另一条路', 'data-fold': fold.id },
    h('span', { class: 'fold-ico', 'aria-hidden': 'true', text: '⑂' }),
    h('span', { text: '另一条路 · ' }),
    h('b', { text: `${fold.count} 条消息` }),
    h('span', { class: 'fold-actions' },
      h('button', { class: 'fold-act', type: 'button', 'aria-expanded': String(Boolean(opened)), text: opened ? '收起' : '展开看看', onClick: () => handlers.toggleFold(fold.id) }),
      h('button', { class: 'fold-act', type: 'button', text: '切到这条路', onClick: () => handlers.switchPath(fold.id) })))
  return withBody(strip, fold, { opened, messageView })
}

function withBody(strip: HTMLElement, fold: Fold, { opened, messageView }: Pick<FoldOptions, 'opened' | 'messageView'>): View[] {
  if (!opened) return [strip]
  return [strip, h('div', { class: 'fold-body' }, ...opened.flatMap((message, i) => [messageView({ ...message, id: `${fold.id}-${i}` })].flat()))]
}

const TASK_STATUS: Readonly<Record<string, string>> = { running: '在后台做', waiting: '在后台等你', done: '做完了', stopped: '停下了', error: '出错了' }

/**
 * Where a turn moved to the background (tasks-state.js): what it is doing now, and 撤销 while the move can
 * still be undone. Once it is no longer running here, what it said can be opened like a path.
 */
function taskStrip(fold: Fold, { opened, handlers, messageView, tasks }: FoldOptions) {
  const task: BackgroundTask | undefined = tasks?.list.find((entry: BackgroundTask) => entry.segmentId === fold.id)
  const undoable = task && tasks?.undo?.taskId === task.id
  const status = task?.status === 'running' && task.now ? `在${task.now}` : TASK_STATUS[task?.status ?? ''] ?? `${fold.count} 条消息`
  const live = task?.status === 'running' || task?.status === 'waiting'
  const strip = h('div', { class: 'fold fold-task', role: 'group', 'aria-label': '挪到后台的事', 'data-fold': fold.id },
    h('span', { class: 'fold-ico', 'aria-hidden': 'true', text: '↗' }),
    h('span', { text: task ? '挪到后台接着做了' : '在后台做过' }),
    task ? h('span', { class: 'fold-tag', title: task.words, text: `#${task.title}` }) : null,
    h('span', { class: 'fold-status', text: `· ${status}` }),
    h('span', { class: 'fold-actions' },
      undoable ? h('button', { class: 'fold-act', type: 'button', title: '变回插话，像什么都没发生', text: '撤销', onClick: () => handlers.undoMove() }) : null,
      live ? null : h('button', { class: 'fold-act', type: 'button', 'aria-expanded': String(Boolean(opened)), text: opened ? '收起' : '展开看看', onClick: () => handlers.toggleFold(fold.id) })))
  return withBody(strip, fold, { opened: live ? undefined : opened, messageView })
}

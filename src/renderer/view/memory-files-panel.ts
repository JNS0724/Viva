import { MAX_MESSAGE_CHARS } from '../../shared/text-limits.ts'
import { getLocale } from '../../shared/i18n/locale.ts'
import { t } from '../../shared/i18n/translate.ts'
import type { MemoryFileSummary } from '../../memory/contracts/file-management.ts'
import type { MemoryFileDetailView, MemoryFileSourceView } from '../../shared/ipc-results.ts'
import { canEditMemoryFile, canForgetMemoryFile } from '../memory-file-state.ts'
import type { MemoryFileEditor } from '../action-types.ts'
import { timelinePlace } from '../timeline-search.ts'
import { composedInput, h } from './dom.ts'
import { renderMarkdown } from './markdown.ts'

const titleOf = (item: MemoryFileSummary) => item.title || t(item.identity.kind === 'daily' ? 'memory-files.daily' : 'memory-files.untitled')

function fileMeta(item: MemoryFileSummary) {
  const kind = t(item.identity.kind === 'daily' ? 'memory-files.daily' : 'memory-files.digest')
  const status = item.hasProjection === false || item.identity.kind === 'digest' && !item.enabled ? t('memory-files.stopped') : ''
  return h('p', { class: 'memory-meta memory-file-meta', text: [kind, item.day, status].filter(Boolean).join(' · ') })
}

function fileCard(item: MemoryFileSummary, handlers: Handlers) {
  const title = titleOf(item)
  return h('li', { class: 'memory-item', 'data-memory-file': item.identity.id },
    h('div', { class: 'memory-copy' }, h('strong', { class: 'memory-text', text: title }), fileMeta(item)),
    h('div', { class: 'memory-actions' },
      h('button', { class: 'link-btn', type: 'button', text: t('memory-files.open'),
        'aria-label': t('memory-files.open.named', { title }), onClick: () => handlers.showMemoryFile({ identity: item.identity }) })))
}

function sourcesOf(sources: readonly MemoryFileSourceView[], handlers: Handlers) {
  const targets = sources.map(({ link }) => link && timelinePlace(link) ? link : null)
  const links = [...new Set(targets.filter((link): link is string => link !== null))]
  return [
    links.length ? h('div', { class: 'memory-actions' }, links.map((link, index) => h('button', {
      class: 'link-btn', type: 'button',
      text: links.length === 1 ? t('profile-panel.memory.source') : t('memory-files.source.number', { number: index + 1 }),
      onClick: () => { handlers.closeProfile(); handlers.openLink(link) },
    }))) : null,
    targets.includes(null) ? h('p', { class: 'help', text: t(links.length ? 'memory-files.sources.partial' : 'memory-files.sources.unlocated') }) : null,
  ]
}

/** The owner has already accepted the file. Its metadata fields do not belong in the note body. */
function bodyOf(markdown: string) {
  const lines = markdown.split(/\r\n|\r|\n/)
  const end = lines[0] === '---' ? lines.indexOf('---', 1) : -1
  return end === -1 ? markdown : lines.slice(end + 1).join('\n')
}

function detailsOf(detail: MemoryFileDetailView, busy: boolean, handlers: Handlers) {
  const snapshot = detail.stoppedSnapshot
  const markdown = snapshot ? snapshot.markdown : detail.markdown
  const id = snapshot?.restrictionId
  const action = id ? 'restore-restriction'
    : detail.identity.kind === 'daily' ? detail.actions.stop ? 'stop' : null
      : detail.hasProjection === false ? null : detail.enabled ? 'stop' : 'restore'
  const enable = action === 'restore' || action === 'restore-restriction'
  const restrictions = detail.restrictions ?? []
  const body = markdown ? bodyOf(markdown).trim() : ''
  return h('article', { class: 'profile-section', 'aria-labelledby': 'memory-file-title' },
    h('div', { class: 'memory-copy' },
      h('h4', { class: 'profile-heading memory-text', id: 'memory-file-title', text: titleOf(detail) }), fileMeta(detail)),
    snapshot ? h('p', { class: 'help', text: t('memory-files.stopped.snapshot') }) : null,
    body ? renderMarkdown(body, { openLink: handlers.openLink }) : h('p', { class: 'help',
      text: t(snapshot ? 'memory-files.stopped.body.unavailable' : 'memory-files.empty.body') }),
    sourcesOf(snapshot?.sources ?? detail.sources, handlers),
    h('div', { class: 'memory-actions' },
      canEditMemoryFile(detail) ? h('button', { class: 'link-btn', name: 'memory-file-edit', type: 'button', disabled: busy,
        text: t('memory-files.editor.edit'), onClick: () => handlers.startMemoryFileEditor(detail) }) : null,
      action && detail.actions.setEnabled ? h('button', { class: 'link-btn', type: 'button', disabled: busy,
        text: t(id ? 'memory-files.restore.range' : enable ? 'memory-files.restore' : 'profile-panel.forget.memory'),
        onClick: () => handlers.setManagedMemoryEnabled(detail, enable, id) }) : null,
      !id && detail.actions.undo ? h('button', { class: 'link-btn', type: 'button', disabled: busy,
        text: t('profile-panel.memory.changes.undo'), onClick: () => handlers.undoManagedMemory(detail) }) : null,
      canForgetMemoryFile(detail) ? h('button', { class: 'link-btn', name: 'memory-file-forget', 'data-tone': 'danger', type: 'button', disabled: busy,
        text: t('memory-files.forget'), onClick: () => handlers.askManagedMemoryForget(detail) }) : null),
    snapshot ? h('p', { class: 'help', text: t('memory-files.restore.range.help') }) :
      restrictions.length ? h('div', { class: 'profile-section' },
        h('h5', { class: 'profile-heading', text: t('memory-files.stopped.ranges') }),
        h('div', { class: 'memory-actions' }, restrictions.map((restriction, index) => h('button', {
          class: 'link-btn', type: 'button', text: t('memory-files.open.range', { number: index + 1 }), disabled: busy,
          onClick: () => handlers.showMemoryFile({ identity: detail.identity, restrictionId: restriction.id }),
        })))) : null)
}

function detailView(files: State['memory']['files'], handlers: Handlers) {
  const selection = files.selection!
  return h('div', { class: 'profile-section', 'data-memory-files-view': 'detail' },
    h('div', { class: 'memory-actions' },
      h('button', { class: 'link-btn', name: 'memory-file-back', type: 'button',
        text: t(selection.restrictionId ? 'memory-files.current' : 'memory-files.back'),
        onClick: () => handlers.showMemoryFile(selection.restrictionId ? { identity: selection.identity } : null) })),
    files.writeError ? h('p', { class: 'form-error', role: 'alert', text: files.writeError }) : null,
    files.detail ? detailsOf(files.detail, files.writing, handlers)
      : files.detailError ? h('div', { class: 'profile-section' },
        h('p', { class: 'form-error', role: 'alert', text: files.detailError }),
        h('div', { class: 'memory-actions' }, h('button', { class: 'link-btn', type: 'button', text: t('memory-files.retry'),
          onClick: handlers.reloadMemoryFile }))) : h('p', { class: 'help', role: 'status', text: t('memory-files.loading') }))
}

function listView(files: State['memory']['files'], handlers: Handlers) {
  const search = h('input', { class: 'field', name: 'memory-files-search', type: 'search', value: files.query, maxlength: 500,
    'aria-label': t('memory-files.search'), placeholder: t('memory-files.search'), ...composedInput((value) => handlers.searchMemoryFiles(value)) })
  return h('div', { class: 'profile-section', 'data-memory-files-view': 'list' },
    h('div', { class: 'memory-file-tools' }, search,
      h('button', { class: 'btn btn-outline btn-small', type: 'button', name: 'memory-file-create', disabled: files.writing,
        text: t('memory-files.editor.add'), onClick: () => handlers.startMemoryFileEditor() })),
    files.items.length ? h('ul', { class: 'memory-list', 'aria-label': t('memory-files.title') }, files.items.map(item => fileCard(item, handlers))) : null,
    files.listError ? h('div', { class: 'profile-section' },
      h('p', { class: 'form-error', role: 'alert', text: files.listError }),
      h('div', { class: 'memory-actions' }, h('button', { class: 'link-btn', type: 'button', text: t('memory-files.retry'),
        onClick: handlers.reloadMemoryFileList }))) : null,
    files.loading || !files.loaded && !files.listError ? h('p', { class: 'help', role: 'status', text: t('memory-files.loading') }) : null,
    files.partial && !files.loading && !files.listError ? h('div', { class: 'profile-section' },
      h('p', { class: 'help', role: 'status', text: t('memory-files.list.partial') }),
      h('div', { class: 'memory-actions' }, h('button', { class: 'link-btn', type: 'button', text: t('memory-files.retry'),
        onClick: handlers.reloadMemoryFileList }))) : null,
    files.loaded && !files.loading && !files.partial && !files.items.length && !files.nextCursor && !files.listError ? h('p', { class: 'empty',
      text: files.query.trim() ? t('profile-panel.no.memories.contain', { value1: files.query.trim() }) : t('memory-files.empty') }) : null,
    files.nextCursor && !files.listError ? h('div', { class: 'memory-actions' },
      h('button', { class: 'link-btn', type: 'button', disabled: files.loading, text: t('memory-files.more'), onClick: handlers.loadMoreMemoryFiles })) : null)
}

function editConflict(files: State['memory']['files'], editor: MemoryFileEditor, handlers: Handlers) {
  const { detail, detailError, writing } = files
  if (detailError) return h('div', { class: 'profile-section' },
    h('p', { class: 'form-error', role: 'alert', text: detailError }),
    h('div', { class: 'memory-actions' }, h('button', { class: 'link-btn', type: 'button',
      text: t('memory-files.retry'), onClick: handlers.reloadMemoryFile })))
  if (!detail) return h('p', { class: 'help', role: 'status', text: t('memory-files.loading') })
  if (!canEditMemoryFile(detail)) return h('p', { class: 'help', text: t('memory-files.editor.unavailable') })
  return h('div', { class: 'profile-section' },
    h('div', { class: 'memory-copy' },
      h('h5', { class: 'profile-heading', text: t('memory-files.editor.latest') }),
      detail.editor.title ? h('strong', { class: 'memory-text', text: detail.editor.title }) : null),
    h('textarea', { class: 'field', rows: 4, readonly: true, 'aria-label': t('memory-files.editor.latest') }, detail.editor.text),
    h('div', { class: 'memory-actions' },
      h('button', { class: 'link-btn', type: 'button', disabled: writing, text: t('memory-files.editor.use.latest'),
        onClick: () => handlers.acceptMemoryFileEditVersion(editor.id, detail) })))
}

type EditorComposition = { active: boolean, redraw?: () => void }
const editorCompositions = new WeakMap<HTMLFormElement, EditorComposition>()

/** Rebuilding a composing input copies partial IME text and interrupts the native composition. */
export function deferMemoryFileEditorRender(container: HTMLElement, editor: MemoryFileEditor, redraw: () => void): boolean {
  const form = container.querySelector<HTMLFormElement>('[data-memory-file-editor]')
  if (!form || form.dataset.memoryFileEditor !== String(editor.id)) return false
  const composition = editorCompositions.get(form)
  if (!composition?.active) return false
  composition.redraw = redraw
  return true
}

function editorView(files: State['memory']['files'], editor: MemoryFileEditor, handlers: Handlers) {
  const { writing } = files
  const composition: EditorComposition = { active: false }
  const title = h('input', { class: 'field', type: 'text', name: 'memory-file-draft-title', maxlength: 200,
    readonly: writing, 'data-version': editor.id, value: editor.draft.title })
  const body = h('textarea', { class: 'field', name: 'memory-file-draft-text', maxlength: MAX_MESSAGE_CHARS, rows: 5,
    required: true, readonly: writing, 'data-version': editor.id }, editor.draft.text)
  const form = h('form', { class: 'profile-section', 'data-memory-files-view': editor.kind, 'data-memory-file-editor': editor.id,
    'aria-labelledby': 'memory-file-editor-title',
    'aria-busy': String(writing),
    onCompositionStart: () => { composition.active = true },
    onCompositionEnd: () => {
      composition.active = false
      if (!composition.redraw) return
      // The next frame preserves the final native input value and drops detached editors.
      requestAnimationFrame(() => {
        if (composition.active || !form.isConnected) return
        const redraw = composition.redraw
        composition.redraw = undefined
        redraw?.()
      })
    },
    onKeyDown: (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229 || composition.active) {
        event.stopPropagation()
        return
      }
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      if (!writing) handlers.cancelMemoryFileEditor(editor.id)
    },
    onSubmit: (event: SubmitEvent) => {
      event.preventDefault()
      if (!composition.active && !writing && !editor.conflict) {
        handlers.saveMemoryFileEditor(editor.id, { title: title.value, text: body.value })
      }
    },
  },
  h('h4', { class: 'profile-heading', id: 'memory-file-editor-title',
    text: t(editor.kind === 'create' ? 'memory-files.editor.add' : 'memory-files.editor.edit') }),
  h('label', { class: 'intro-item' }, h('span', { class: 'label', text: t('memory-files.editor.title') }), title),
  h('label', { class: 'intro-item' }, h('span', { class: 'label', text: t('memory-files.editor.body') }), body),
  editor.error ? h('p', { class: 'form-error', role: 'alert', text: editor.error }) : null,
  editor.conflict ? editConflict(files, editor, handlers) : null,
  h('div', { class: 'profile-edit-actions' },
    h('button', { class: 'btn btn-accent btn-small', type: 'submit', disabled: writing || Boolean(editor.conflict),
      text: t(writing ? 'extensions.saving' : 'extensions.save') }),
    h('button', { class: 'btn btn-outline btn-small', type: 'button', disabled: writing, text: t('extensions.cancel'),
      onClick: () => handlers.cancelMemoryFileEditor(editor.id) })))
  editorCompositions.set(form, composition)
  return form
}

const isMemoryPending = (memory: State['memory']) =>
  memory.availability === 'starting' || memory.availability === 'recovering'
const effectiveLoadError = (memory: State['memory']) =>
  memory.loadError ?? (memory.availability === 'unavailable' ? t('memory.read.unavailable') : null)

export function memoryLoadError(memory: State['memory'], handlers: Handlers) {
  const message = effectiveLoadError(memory)
  return message ? h('div', { class: 'profile-section' },
    h('p', { class: 'form-error', role: 'alert', text: message }),
    h('div', { class: 'memory-actions' }, h('button', { class: 'link-btn', type: 'button',
      text: t('memory-files.retry'), onClick: handlers.loadMemory }))) : null
}

function dreamRow(memory: State['memory'], handlers: Handlers) {
  const { dream, dreamUnavailable, requestingDream } = memory
  const pending = isMemoryPending(memory)
  const phase = dreamUnavailable || memory.availability === 'unavailable' ? 'unavailable' : requestingDream ? 'queued' : pending ? 'loading' : dream?.state ?? 'loading'
  const time = (at: number) => new Intl.DateTimeFormat(getLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(at)
  const history = dream ? [
    dream.lastProcessedAt === null ? t('dream.no.history') : t('dream.last.processed', { time: time(dream.lastProcessedAt) }),
    dream.lastCheckedAt !== null && (dream.lastCheckResult === 'empty' || dream.lastCheckResult === 'size-limit')
      ? t(dream.lastCheckResult === 'empty' ? 'dream.last.empty' : 'dream.last.oversized', { time: time(dream.lastCheckedAt) }) : null,
  ].filter(Boolean).join(' · ') : ''
  return h('div', { class: 'memory-item', 'data-dream-state': phase },
    h('div', { class: 'memory-copy' },
      h('strong', { class: 'memory-text', text: t('dream.title') }),
      h('p', { class: 'memory-meta', role: 'status', text: [t(`dream.state.${phase}`), history].filter(Boolean).join(' · ') })),
    h('button', { class: 'btn btn-outline btn-small', type: 'button', name: 'memory-run-dream',
      disabled: !dream || dreamUnavailable || memory.availability !== 'ready' || ['disabled', 'running', 'queued'].includes(phase),
      text: t('dream.run'), onClick: handlers.runDream }))
}

export function memoryFilesSection(memory: State['memory'], handlers: Handlers) {
  const { files } = memory
  const loadError = effectiveLoadError(memory)
  const pending = isMemoryPending(memory)
  return h('section', { class: 'profile-section', 'aria-labelledby': 'memory-files-title' },
    h('h3', { class: 'profile-heading', id: 'memory-files-title', text: t('memory-files.title') }),
    !files.editor && !files.selection ? dreamRow(memory, handlers) : null,
    files.editor ? editorView(files, files.editor, handlers)
      : memory.availability === 'unavailable' ? null
      : pending ? h('p', { class: 'help', role: 'status', text: t(memory.availability === 'recovering' ? 'memory-files.recovering' : 'memory-files.loading') })
      : files.selection ? detailView(files, handlers) : listView(files, handlers),
    forgetView(files, handlers),
    memory.cleanupPending > 0 ? h('p', { class: 'help', role: 'status',
      text: t('memory-files.storage.cleanup.pending', { count: memory.cleanupPending }) }) : null,
    !files.editor && memory.loaded && !loadError && !pending ? h('div', { class: 'memory-actions' },
      h('button', { class: 'link-btn', type: 'button', name: 'memory-rebuild-indexes', disabled: memory.rebuildingIndexes,
        text: t(memory.rebuildingIndexes ? 'profile-panel.memory.index.rebuilding' : 'profile-panel.memory.index.rebuild'),
        onClick: handlers.rebuildMemoryIndexes })) : null)
}

function forgetView(files: State['memory']['files'], handlers: Handlers) {
  const { forget, writing } = files
  if (!forget) return null
  if (forget.phase !== 'confirm') return h('div', { class: 'profile-section', 'data-memory-file-forget-status': forget.phase },
    h('p', { class: forget.error ? 'form-error' : 'help', role: forget.error ? 'alert' : 'status',
      text: forget.error ?? t(forget.phase === 'unconfirmed' ? 'extensions.working' : forget.phase === 'complete' ? 'memory-files.forget.complete' : 'memory-files.forget.pending') }),
    forget.phase === 'unconfirmed' || forget.phase === 'pending' ? h('div', { class: 'memory-actions' },
      h('button', { class: 'link-btn', type: 'button', name: 'memory-file-forget-retry', disabled: writing,
        text: t(writing ? 'extensions.working' : 'memory-files.forget.check'),
        onClick: () => handlers.confirmManagedMemoryForget(forget.id) })) : null)
  return h('section', { class: 'profile-section', role: 'group', 'data-memory-file-forget': forget.id,
    'aria-labelledby': 'memory-file-forget-title', 'aria-describedby': 'memory-file-forget-description',
    onKeyDown: (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) {
        if (event.key === 'Enter') event.preventDefault()
        event.stopPropagation()
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        handlers.cancelManagedMemoryForget(forget.id)
      }
    },
  },
  h('h4', { class: 'profile-heading memory-text', id: 'memory-file-forget-title',
    text: t('memory-files.forget.confirm', { title: forget.title || t('memory-files.untitled') }) }),
  h('p', { class: 'help', id: 'memory-file-forget-description',
    text: t('memory-files.forget.help') }),
  h('div', { class: 'memory-actions' },
    h('button', { class: 'btn btn-outline btn-small', type: 'button', name: 'memory-file-forget-cancel', disabled: writing,
      text: t('extensions.cancel'), onClick: () => handlers.cancelManagedMemoryForget(forget.id) }),
    h('button', { class: 'link-btn', 'data-tone': 'danger', type: 'button', name: 'memory-file-forget-confirm', disabled: writing,
      text: t('memory-files.forget.confirm.action'), onClick: () => handlers.confirmManagedMemoryForget(forget.id) })))
}

import { t } from '../../shared/i18n/translate.ts'
import type { MemoryFileSummary } from '../../memory/contracts/file-management.ts'
import type { MemoryFileDetailView, MemoryFileSourceView } from '../../shared/ipc-results.ts'
import { timelinePlace } from '../timeline-search.ts'
import { h } from './dom.ts'
import { renderMarkdown } from './markdown.ts'

const titleOf = (item: MemoryFileSummary) => item.title || t(item.identity.kind === 'daily' ? 'memory-files.daily' : 'memory-files.untitled')

function fileMeta(item: MemoryFileSummary) {
  const kind = t(item.identity.kind === 'daily' ? 'memory-files.daily' : 'memory-files.digest')
  const status = item.hasProjection === false || item.identity.kind === 'digest' && !item.enabled ? t('memory-files.stopped')
    : item.applicability !== 'current' ? t(`memory-files.${item.applicability}`) : ''
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
      action && detail.actions.setEnabled ? h('button', { class: 'link-btn', type: 'button', disabled: busy,
        text: t(id ? 'memory-files.restore.range' : enable ? 'memory-files.restore' : 'profile-panel.forget.memory'),
        onClick: () => handlers.setManagedMemoryEnabled(detail, enable, id) }) : null,
      !id && detail.actions.undo ? h('button', { class: 'link-btn', type: 'button', disabled: busy,
        text: t('profile-panel.memory.changes.undo'), onClick: () => handlers.undoManagedMemory(detail) }) : null),
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
    'aria-label': t('memory-files.search'), placeholder: t('memory-files.search'), onInput: () => handlers.searchMemoryFiles(search.value) })
  return h('div', { class: 'profile-section', 'data-memory-files-view': 'list' },
    h('div', { class: 'field-row' }, search),
    files.items.length ? h('ul', { class: 'memory-list', 'aria-label': t('memory-files.title') }, files.items.map(item => fileCard(item, handlers))) : null,
    files.listError ? h('div', { class: 'profile-section' },
      h('p', { class: 'form-error', role: 'alert', text: files.listError }),
      h('div', { class: 'memory-actions' }, h('button', { class: 'link-btn', type: 'button', text: t('memory-files.retry'),
        onClick: handlers.reloadMemoryFileList }))) : null,
    files.loading || !files.loaded && !files.listError ? h('p', { class: 'help', role: 'status', text: t('memory-files.loading') }) : null,
    files.loaded && !files.loading && !files.items.length && !files.listError ? h('p', { class: 'empty',
      text: files.query.trim() ? t('profile-panel.no.memories.contain', { value1: files.query.trim() }) : t('memory-files.empty') }) : null,
    files.nextCursor && !files.listError ? h('div', { class: 'memory-actions' },
      h('button', { class: 'link-btn', type: 'button', disabled: files.loading, text: t('memory-files.more'), onClick: handlers.loadMoreMemoryFiles })) : null)
}

export function memoryFilesSection(memory: State['memory'], handlers: Handlers) {
  return h('section', { class: 'profile-section', 'aria-labelledby': 'memory-files-title' },
    h('h3', { class: 'profile-heading', id: 'memory-files-title', text: t('memory-files.title') }),
    memory.files.selection ? detailView(memory.files, handlers) : listView(memory.files, handlers),
    memory.cleanupPending > 0 ? h('p', { class: 'help', role: 'status',
      text: t('memory-files.storage.cleanup.pending', { count: memory.cleanupPending }) }) : null,
    h('div', { class: 'memory-actions' },
      h('button', { class: 'link-btn', type: 'button', name: 'memory-rebuild-indexes', disabled: memory.rebuildingIndexes,
        text: t(memory.rebuildingIndexes ? 'profile-panel.memory.index.rebuilding' : 'profile-panel.memory.index.rebuild'),
        onClick: handlers.rebuildMemoryIndexes })))
}

import { t } from '../../shared/i18n/translate.ts'
import type { DiagnosticNotice } from '../diagnostics-types.ts'
import { h } from './dom.ts'

const noticeText: Readonly<Record<DiagnosticNotice, () => string>> = {
  saved: () => t('diagnostics.export.saved'), failed: () => t('diagnostics.control.failed'), busy: () => t('diagnostics.control.busy'),
  cleared: () => t('diagnostics.clear.done'), cleanup_pending: () => t('diagnostics.clear.pending'),
  debug_enabled: () => t('diagnostics.debug.enabled'), debug_disabled: () => t('diagnostics.debug.disabled'),
}
const stateText = {
  initializing: () => t('diagnostics.state.initializing'), ready: () => t('diagnostics.state.ready'),
  stalled: () => t('diagnostics.state.stalled'), unavailable: () => t('diagnostics.state.unavailable'), closed: () => t('diagnostics.state.closed'),
}

/** Uses the settings page's existing rows and wrapping action layout. No direct IPC. */
export function diagnosticsSection(view: State['diagnostics'], handlers: Handlers) {
  const { status } = view
  const busy = Boolean(view.busy)
  const locked = busy || Boolean(status?.cleanupPending)
  return h('section', { class: 'ext', 'aria-label': t('diagnostics.menu'), 'data-diagnostics': '' },
    h('div', { class: 'pref-copy' },
      h('span', { class: 'profile-heading', text: t('diagnostics.menu') }),
      h('span', { class: 'help', text: t('diagnostics.scope') }),
      h('span', { class: 'help', text: status
        ? t('diagnostics.status.summary', { state: stateText[status.state](), count: status.droppedCount })
        : t(view.failed ? 'diagnostics.status.failed' : 'diagnostics.state.initializing') })),
    h('div', { class: 'settings-actions' },
      h('button', { type: 'button', class: 'btn btn-outline', text: t(view.busy === 'export' ? 'diagnostics.export.working' : 'diagnostics.export'),
        disabled: locked || Boolean(status?.exporting), onClick: handlers.exportDiagnostics }),
      h('button', { type: 'button', class: 'btn btn-outline', text: t('diagnostics.open'), disabled: busy, onClick: handlers.openDiagnosticsFolder }),
      h('button', { type: 'button', class: 'btn btn-outline', text: t(status?.cleanupPending ? 'diagnostics.clear.retry' : 'diagnostics.clear'),
        disabled: busy || Boolean(status?.exporting), onClick: handlers.clearDiagnostics }),
      h('button', { type: 'button', class: 'btn btn-outline', text: t('diagnostics.refresh'), disabled: view.loading || busy, onClick: handlers.refreshDiagnostics })),
    h('label', { class: 'pref-row' },
      h('span', { class: 'pref-copy' }, h('span', { class: 'profile-heading', text: t('diagnostics.debug') }),
        h('span', { class: 'help', text: t('diagnostics.debug.help') })),
      h('input', { type: 'checkbox', class: 'switch', name: 'diagnostics-debug', checked: Boolean(status && status.debugRemainingMs > 0),
        'data-version': `${Boolean(status && status.debugRemainingMs > 0)}:${view.busy ?? ''}`,
        disabled: locked, 'aria-label': t('diagnostics.debug'), onChange: (event: Event) => handlers.debugDiagnostics((event.target as HTMLInputElement).checked) })),
    view.failed && status ? h('p', { class: 'form-error', role: 'status', text: t('diagnostics.status.failed') }) : null,
    view.notice ? h('p', { class: view.notice === 'failed' ? 'form-error' : 'form-notice', role: 'status', text: noticeText[view.notice]() }) : null)
}

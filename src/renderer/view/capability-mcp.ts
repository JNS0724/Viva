import { t } from '../../shared/i18n/translate.ts'
import { serverStanding, shownServer, type ServerStanding } from '../capabilities-state.ts'
import type { ExtensionStatus, ServerView } from '../capability-types.ts'
import { h } from './dom.ts'
import { importButton, serverForm, typeLabel } from './extensions.ts'

/**
 * 能力 · MCP (view/capabilities.ts): the user's servers, how the agent took each this time, and the one picked: what it
 * runs or where it is, the keys it has (by name), edited in place or deleted. New ones come from the conversation or
 * from the user's own dsh.
 */

function standingText(standing: ServerStanding) {
  if (standing.kind === 'missing') return { tone: 'off', text: t('extensions.missing.credentials', { value1: standing.names.join('、') }) }
  if (standing.kind === 'connected') return { tone: 'ok', text: t('extensions.connected') }
  if (standing.kind === 'dropped') return { tone: 'off', text: t('extensions.not.connected', { reason: standing.reason }) }
  return { tone: 'off', text: t('island-view.not.connected') }
}

const statusOf = (state: State) => state.extensions.status as ExtensionStatus

export function serversSide(state: State, handlers: Handlers): Node[] {
  const servers = state.extensions.servers as readonly ServerView[]
  const shown = shownServer(state)
  return [
    h('div', { class: 'cap-tools' }, importButton(state.extensions, handlers)),
    state.extensions.importNote ? h('p', { class: 'ext-import-note', role: 'status', text: state.extensions.importNote }) : null,
    ...servers.map((server) => {
      const standing = standingText(serverStanding(server, statusOf(state)))
      return h('button', {
        class: 'tp-row cap-row', type: 'button', 'data-name': server.name, 'aria-current': server.name === shown?.name ? 'page' : null,
        onClick: () => handlers.selectCapability(server.name),
      }, h('span', { class: 'tp-name', text: server.name }), h('span', { class: 'ext-status', 'data-tone': standing.tone, text: standing.text }))
    }),
    servers.length ? null : h('p', { class: 'help cap-empty', text: t('extensions.no.connections.yet') }),
    h('p', { class: 'help cap-hint', text: t('capabilities.mcp.hint') }),
  ].filter((node) => node !== null)
}

/** What it runs or where it is, its keys by name, and 编辑 / 删除; or, being edited, the form. */
function serverFacts(server: ServerView, state: State, handlers: Handlers) {
  const target = server.type === 'http' ? server.url : [server.command, ...server.args].join(' ')
  const secrets = [...server.envNames, ...server.headerNames]
  const busy = Boolean(state.extensions.busy)
  return h('div', { class: 'ext-item cap-card', 'data-name': server.name },
    h('dl', { class: 'cap-facts' },
      h('dt', { text: t('extensions.connection.type') }), h('dd', { text: typeLabel(server.type) }),
      h('dt', { text: server.type === 'http' ? t('extensions.address') : t('extensions.launch.command') }), h('dd', { class: 'mono', text: target ?? '' }),
      secrets.length ? [h('dt', { text: t('capabilities.keys') }), h('dd', { text: t('extensions.encrypted.and.saved', { value1: secrets.join('、') }) })] : null),
    h('div', { class: 'ext-actions settings-actions' },
      h('button', { class: 'btn btn-outline btn-small', type: 'button', disabled: busy, text: t('extensions.edit'), 'aria-label': t('extensions.edit.mcp.server', { name: server.name }), onClick: () => handlers.editServer(server) }),
      h('button', { class: 'btn btn-outline btn-small', type: 'button', disabled: busy, text: t('extensions.delete'), 'aria-label': t('extensions.delete.mcp.server', { name: server.name }), onClick: () => handlers.removeServer(server.name) })))
}

export function serverMain(state: State, handlers: Handlers): HTMLElement {
  const server = shownServer(state)
  if (!server) return h('div', { class: 'tp-main tp-empty' }, h('p', { class: 'empty', text: t('extensions.no.connections.yet') }))
  const standing = standingText(serverStanding(server, statusOf(state)))
  const editing = state.extensions.editing?.name === server.name ? state.extensions.editing : null
  return h('div', { class: 'tp-main' },
    h('header', { class: 'tp-head' },
      h('h2', { class: 'tp-title', text: server.name }),
      h('span', { class: 'ext-status cap-standing', 'data-tone': standing.tone, title: standing.text, text: standing.text })),
    h('div', { class: 'tp-scroll' },
      editing ? serverForm(server, editing, state.extensions, handlers) : serverFacts(server, state, handlers),
      state.extensions.error ? h('p', { class: 'form-error', role: 'alert', text: state.extensions.error }) : null,
      state.extensions.notice ? h('p', { class: 'form-notice', role: 'status', text: state.extensions.notice }) : null))
}

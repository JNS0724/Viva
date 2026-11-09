import { onLocaleChange } from '../../shared/i18n/locale.ts'
import { t } from '../../shared/i18n/translate.ts'
import { h, label } from './dom.ts'
import { icon } from './icons.ts'
import type { ServerView as Server } from '../capability-types.ts'

/**
 * An MCP server's edit form and 从 dsh 导入's menu, for 能力 · MCP (view/capability-mcp.ts).
 */
/** The 扩展 part of the state (personal-state.ts). */
type Extensions = State['extensions']
/** The server being edited (personal-state.ts EditDraft): the state's types widen it away, so it is written out here. */
type Draft = { name: string, type: string, keys: ReadonlyArray<{ id: number, name: string, saved: boolean }> }

let TYPE_LABEL: Readonly<Record<string, string>> = { stdio: t("extensions.local.command"), http: t("extensions.remote.address") }
/** How a server connects, in words: a local command or a remote address. */
export const typeLabel = (kind: string): string => TYPE_LABEL[kind] ?? kind

const smallButton = (text: string, extra: Record<string, unknown>) => h('button', { class: 'btn btn-outline btn-small', type: 'button', text, ...extra })

/** A key of the form: its name (typed, for a new one), and a value that, left blank, keeps the saved one. */
function keyRow(key: Draft['keys'][number], version: string, handlers: Handlers) {
  const nameCell = key.name
    ? h('span', { class: 'secret-key mono', text: key.name })
    : h('input', { class: 'field mono', name: `mcp-key-name-${key.id}`, 'data-version': version, placeholder: t("extensions.name.e.g.api.token"), autocomplete: 'off', spellcheck: 'false', 'aria-label': t("extensions.credential.name") })
  const placeholder = key.saved ? t("extensions.leave.unchanged.encrypted.enter.a.value.to") : key.name ? t("extensions.no.value.yet.enter.one.to.connect") : t("extensions.value")
  return h('div', { class: 'secret-row', 'data-missing': String(Boolean(key.name) && !key.saved) },
    nameCell,
    h('input', {
      class: 'field', type: 'password', name: `mcp-key-${key.id}`, 'data-version': version, placeholder, autocomplete: 'off', spellcheck: 'false',
      'aria-label': key.name ? t("extensions.value.of", { name: key.name }) : t("extensions.credential.value"),
    }),
    h('button', { class: 'secret-del', type: 'button', title: t("extensions.delete.this.credential"), 'aria-label': t("extensions.delete.credential", { name: key.name }), onClick: () => handlers.removeEditKey(key.id) }, icon('close', 14)))
}

/** What the form holds, as extensions-ipc.ts formChanges takes it; fields of the other type are left out. */
function formValues(form: HTMLFormElement, draft: Draft) {
  const data = new FormData(form)
  const text = (name: string) => {
    const value = data.get(name)
    return typeof value === 'string' ? value : undefined
  }
  return {
    name: text('mcp-name'),
    type: draft.type,
    command: draft.type === 'stdio' ? text('mcp-command') : undefined,
    args: draft.type === 'stdio' ? text('mcp-args') : undefined,
    url: draft.type === 'http' ? text('mcp-url') : undefined,
    keys: draft.keys.map((key) => ({ name: key.name || (text(`mcp-key-name-${key.id}`) ?? '').trim(), value: text(`mcp-key-${key.id}`) ?? '' }))
      .filter((key) => key.name),
  }
}

const formRow = (title: string, field: HTMLElement, top = false) => h('div', { class: top ? 'ext-edit-row top' : 'ext-edit-row' }, label(title), field)

/** The server in place, as a form: what it runs or where it is, and its keys; saved keys stay unless typed again. */
export function serverForm(server: Server, draft: Draft, extensions: Extensions, handlers: Handlers) {
  const version = server.name
  const input = (name: string, value: string, extra: Record<string, unknown> = {}) =>
    h('input', { class: 'field mono', name, value, 'data-version': version, autocomplete: 'off', spellcheck: 'false', ...extra })
  const typeButton = (kind: string) => h('button', {
    type: 'button', 'aria-pressed': String(draft.type === kind), text: TYPE_LABEL[kind], onClick: () => handlers.setEditType(kind),
  })
  return h('div', { class: 'ext-item', 'data-name': server.name, 'data-editing': 'true' },
    h('form', {
      class: 'ext-edit', 'aria-label': t("extensions.edit.mcp.server", { name: server.name }),
      onSubmit: (event: SubmitEvent) => {
        event.preventDefault()
        handlers.saveServer(draft.name, formValues(event.currentTarget as HTMLFormElement, draft))
      },
    },
    h('div', { class: 'ext-edit-head' }, h('span', { class: 'ext-name', text: t("extensions.edit.2", { name: server.name }) })),
    formRow(t("extensions.name"), input('mcp-name', server.name, { 'aria-label': t("extensions.name") })),
    formRow(t("extensions.connection.type"), h('div', { class: 'seg', role: 'group', 'aria-label': t("extensions.connection.type") }, typeButton('stdio'), typeButton('http'))),
    draft.type === 'http'
      ? formRow(t("extensions.address"), input('mcp-url', server.url ?? '', { placeholder: 'https://…', 'aria-label': t("extensions.server.address") }))
      : [
        formRow(t("extensions.launch.command"), input('mcp-command', server.command ?? '', { placeholder: t("extensions.for.example.npx"), 'aria-label': t("extensions.launch.command") })),
        formRow(t("extensions.arguments"), h('textarea', {
          class: 'field', name: 'mcp-args', rows: 2, 'data-version': version, spellcheck: 'false', placeholder: t("extensions.one.per.line"), 'aria-label': t("extensions.arguments"), text: server.args.join('\n'),
        }), true),
      ],
    formRow(draft.type === 'http' ? t("extensions.headers") : t("extensions.environment.variables"), h('div', { class: 'secret-rows' },
      draft.keys.map((key) => keyRow(key, version, handlers)),
      h('button', { class: 'link-btn ext-add-key', type: 'button', text: t("extensions.add.credential"), onClick: () => handlers.addEditKey() })), true),
    h('div', { class: 'ext-edit-foot' },
      h('button', { class: 'btn btn-accent btn-small', type: 'submit', disabled: extensions.busy, text: extensions.busy ? t("extensions.saving") : t("extensions.save") }),
      smallButton(t("extensions.cancel"), { onClick: () => handlers.cancelServerEdit() }),
      h('p', { class: 'help', text: t("extensions.credentials.are.encrypted.on.this.computer.saving") }))))
}

/** 从 dsh 导入, with where from: dsh's default folder, the one used last time, or another the user picks. */
export function importButton(extensions: Extensions, handlers: Handlers) {
  const { dsh, importMenu } = extensions
  const item = (name: string, path: string, from: string) => h('button', {
    class: 'workdir-item', type: 'button', role: 'menuitem', onClick: () => handlers.importDsh(from),
  }, h('span', { class: 'workdir-item-name', text: name }), path ? h('span', { class: 'workdir-item-path mono', title: path, text: path }) : null)
  return h('div', { class: 'import-area' },
    h('button', {
      class: 'btn btn-outline btn-small import-btn', type: 'button', disabled: extensions.busy, 'aria-haspopup': 'menu', 'aria-expanded': String(importMenu),
      onClick: () => handlers.toggleImportMenu(),
    }, h('span', { text: extensions.busy && !extensions.editing ? t("extensions.working") : t("extensions.import.from.dsh") }), icon('chevron', 14)),
    importMenu ? [
      h('div', { class: 'import-scrim', onClick: () => handlers.closeImportMenu() }),
      h('div', { class: 'workdir-menu import-menu', role: 'menu', 'aria-label': t("extensions.choose.a.dsh.installation") },
        h('div', { class: 'workdir-head', text: t("extensions.choose.a.dsh.installation") }),
        item(t("extensions.default.location"), dsh.defaultLabel, 'default'),
        dsh.lastLabel ? item(t("extensions.last.used"), dsh.lastLabel, 'last') : null,
        h('div', { class: 'workdir-sep' }),
        item(t("extensions.choose.another.dsh.folder"), '', 'choose'),
        h('p', { class: 'import-menu-foot', text: t("extensions.includes.credentials.reads.only.your.original.dsh") })),
    ] : null)
}

onLocaleChange(() => {
  TYPE_LABEL = { stdio: t("extensions.local.command"), http: t("extensions.remote.address") }
})

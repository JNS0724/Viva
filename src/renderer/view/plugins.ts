import { t } from '../../shared/i18n/translate.ts'
import { h, label } from './dom.ts'

/** The 插件 part of the state (plugins-state.ts). */
type Plugins = State['plugins']
type Row = { id: string, entryId: string | null, enabled: boolean, phase: string | null }
type Plugin = {
  name: string, version: string | null, description: string | null, enabled: boolean, removable: boolean,
  error: { code: string, detail: string | null } | null, webUi: boolean, rows: Row[], overrides: string[],
}

const button = (kind: 'outline' | 'accent', text: string, onClick: () => unknown, disabled: boolean) =>
  h('button', { class: `btn btn-${kind} btn-small`, type: 'button', text, disabled, onClick })

/** Rows switched on that do not run (waiting for a service dsh's Web client has, failed to load). */
const stalled = (plugin: Plugin) => plugin.rows.filter((row) => plugin.enabled && row.entryId && row.phase !== 'active').map((row) => row.id)

function pluginItem(plugin: Plugin, plugins: Plugins, handlers: Handlers) {
  const notRunning = stalled(plugin)
  return h('li', { class: 'ext-item', 'data-name': plugin.name },
    h('div', { class: 'ext-copy' },
      h('div', { class: 'ext-title' },
        h('span', { class: 'ext-name', text: plugin.name }),
        plugin.version ? h('span', { class: 'badge', text: plugin.version }) : null,
        h('span', { class: 'badge', text: plugin.enabled ? t('plugins.on') : t('plugins.off') })),
      plugin.description ? h('span', { class: 'ext-detail', text: plugin.description }) : null,
      plugin.webUi ? h('span', { class: 'ext-detail', text: t('plugins.web.ui') }) : null,
      notRunning.length ? h('span', { class: 'ext-detail', text: t('plugins.not.running', { rows: notRunning.join('、') }) }) : null,
      plugin.overrides.length ? h('span', { class: 'ext-detail', text: t('plugins.overrides', { rows: plugin.overrides.join('、') }) }) : null,
      plugin.error ? h('span', { class: 'ext-detail', text: plugin.error.detail ?? plugin.error.code }) : null),
    h('div', { class: 'settings-actions' },
      button('outline', plugin.enabled ? t('plugins.disable') : t('plugins.enable'), () => handlers.setPluginEnabled(plugin.name, !plugin.enabled), plugins.busy),
      plugin.removable ? button('outline', t('plugins.remove'), () => handlers.removePlugin(plugin.name), plugins.busy) : null))
}

/** What the spec names, the trust notice, and 安装; or the build scripts a first attempt asked to allow. */
function installCard(plugins: Plugins, handlers: Handlers) {
  const found = plugins.inspection
  if (!found && !plugins.pendingBuilds.length) return null
  return h('div', { class: 'ext-group', role: 'group', 'aria-label': t('plugins.install') },
    found ? h('b', { text: t('plugins.found', { name: found.name ?? plugins.spec, version: found.version ?? '' }).trim() }) : null,
    found?.description ? h('p', { class: 'help', text: found.description }) : null,
    found?.bundle === false ? h('p', { class: 'form-error', text: t('plugins.not.a.bundle') }) : null,
    plugins.pendingBuilds.length ? h('p', { class: 'help', text: t('plugins.builds', { names: plugins.pendingBuilds.join('、') }) }) : null,
    h('p', { class: 'help', text: t('plugins.trust') }),
    h('div', { class: 'settings-actions' },
      button('accent', plugins.pendingBuilds.length ? t('plugins.allow.builds') : t('plugins.install'), () => handlers.installPlugin(), plugins.busy),
      button('outline', t('plugins.cancel'), () => handlers.dismissPluginInstall(), plugins.busy)))
}

function installForm(plugins: Plugins, handlers: Handlers) {
  return h('form', {
    class: 'ext-form',
    onSubmit: (event: SubmitEvent) => {
      event.preventDefault()
      handlers.inspectPlugin()
    },
  },
  h('label', { class: 'intro-item' }, label(t('plugins.spec')),
    h('input', {
      class: 'field', name: 'plugin-spec', type: 'text', value: plugins.spec, placeholder: t('plugins.spec.hint'), 'aria-label': t('plugins.spec'),
      spellcheck: 'false', autocomplete: 'off', onInput: (event: Event) => handlers.editPluginSpec((event.target as HTMLInputElement).value),
    })),
  h('div', { class: 'settings-actions' },
    h('button', { class: 'btn btn-outline btn-small', type: 'submit', disabled: plugins.busy, text: t('plugins.look') })))
}

/** The 插件 part of settings: the dsh plugins the user installed, and installing another. */
export function pluginsSection(plugins: Plugins, handlers: Handlers) {
  if (!plugins.loaded) return h('section', { class: 'ext' }, label(t('plugins.title')), h('p', { class: 'help', text: t('extensions.loading') }))
  if (!plugins.connected) return h('section', { class: 'ext', 'aria-label': t('plugins.title') }, label(t('plugins.title')), h('p', { class: 'help', text: t('plugins.not.connected') }))
  return h('section', { class: 'ext', 'aria-label': t('plugins.title') },
    label(t('plugins.title')),
    h('p', { class: 'help', text: t('plugins.help') }),
    plugins.plugins.length
      ? h('ul', { class: 'ext-list' }, plugins.plugins.map((plugin: Plugin) => pluginItem(plugin, plugins, handlers)))
      : h('p', { class: 'help', text: t('plugins.none') }),
    installForm(plugins, handlers),
    installCard(plugins, handlers),
    plugins.error ? h('p', { class: 'form-error', role: 'alert', text: plugins.error }) : null,
    plugins.notice ? h('p', { class: 'form-notice', role: 'status', text: plugins.notice }) : null)
}

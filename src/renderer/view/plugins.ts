import { t } from '../../shared/i18n/translate.ts'
import { h, label } from './dom.ts'

/** Installing a dsh plugin, for 能力 · 插件 (view/capability-plugins.ts): the spec, what it names, then 安装. */
/** The 插件 part of the state (plugins-state.ts). */
type Plugins = State['plugins']

const button = (kind: 'outline' | 'accent', text: string, onClick: () => unknown, disabled: boolean) =>
  h('button', { class: `btn btn-${kind} btn-small`, type: 'button', text, disabled, onClick })

/** What the spec names, the trust notice, and 安装; or the build scripts a first attempt asked to allow. */
export function installCard(plugins: Plugins, handlers: Handlers) {
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

export function installForm(plugins: Plugins, handlers: Handlers) {
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

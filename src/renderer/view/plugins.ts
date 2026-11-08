import { t } from '../../shared/i18n/translate.ts'
import { h, label } from './dom.ts'
import { fitText } from './plugin-fit-text.ts'

/** Installing a dsh plugin, for 能力 · 插件 (view/capability-plugins.ts): the spec, what it names, then 安装. */
/** The 插件 part of the state (plugins-state.ts). */
type Plugins = State['plugins']

const button = (kind: 'outline' | 'accent', text: string, onClick: () => unknown, disabled: boolean) =>
  h('button', { class: `btn btn-${kind} btn-small`, type: 'button', text, disabled, onClick })

/**
 * What the spec names and whether it works in Viva (from its package.json, before anything is installed), the trust
 * notice, and 安装; or the build scripts a first attempt asked to allow. Under an entry the source listed
 * (`listed`, view/plugin-catalog.ts), which already says its name, what it is and whether it works here, only what
 * the entry does not.
 */
export function installCard(plugins: Plugins, handlers: Handlers, { listed = false } = {}) {
  const found = plugins.inspection
  if (!found && !plugins.pendingBuilds.length) return null
  const fit = !listed && found?.fit ? fitText(found.fit) : null
  return h('div', { class: 'ext-group', role: 'group', 'aria-label': t('plugins.install') },
    found && !listed ? h('b', { text: t('plugins.found', { name: found.name ?? plugins.spec, version: found.version ?? '' }).trim() }) : null,
    found?.description && !listed ? h('p', { class: 'help', text: found.description }) : null,
    found?.bundle === false ? h('p', { class: 'form-error', text: t('plugins.not.a.bundle') }) : null,
    fit ? h('p', { class: found.fit.kind === 'needs-web' ? 'form-error' : 'help', role: found.fit.kind === 'needs-web' ? 'alert' : null, text: fit }) : null,
    plugins.pendingBuilds.length ? h('p', { class: 'help', text: t('plugins.builds', { names: plugins.pendingBuilds.join('、') }) }) : null,
    h('p', { class: 'help', text: t('plugins.trust') }),
    h('div', { class: 'settings-actions' },
      // One that cannot work here can still be installed, but 安装 is not offered as the thing to do.
      button(found?.fit?.kind === 'needs-web' ? 'outline' : 'accent', plugins.pendingBuilds.length ? t('plugins.allow.builds') : t('plugins.install'), () => handlers.installPlugin(), plugins.busy),
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
      class: 'field', name: 'plugin-spec', type: 'text', value: plugins.spec, 'data-version': String(plugins.specVersion), placeholder: t('plugins.spec.hint'), 'aria-label': t('plugins.spec'),
      spellcheck: 'false', autocomplete: 'off', onInput: (event: Event) => handlers.editPluginSpec((event.target as HTMLInputElement).value),
    })),
  h('div', { class: 'settings-actions' },
    h('button', { class: 'btn btn-outline btn-small', type: 'submit', disabled: plugins.busy, text: t('plugins.look') })))
}

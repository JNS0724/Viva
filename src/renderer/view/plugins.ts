import { t } from '../../shared/i18n/translate.ts'
import type { PluginFit } from '../capability-types.ts'
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
 * the entry does not, or what the look-up found that the entry could not say (`listedFit`, what the entry says).
 */
/**
 * Whether the card says if the plugin works in Viva: on its own, whenever the look-up told; under an entry, which says
 * it already, only when the look-up found out other than the entry says (a listing whose package.json could not be read).
 */
export function cardFit(found: PluginFit | null | undefined, { listed = false, listedFit = null }: { listed?: boolean, listedFit?: PluginFit | null } = {}): PluginFit | null {
  if (!found) return null
  return !listed || found.kind !== listedFit?.kind ? found : null
}

export function installCard(plugins: Plugins, handlers: Handlers, { listed = false, listedFit = null }: { listed?: boolean, listedFit?: PluginFit | null } = {}) {
  const found = plugins.inspection
  if (!found && !plugins.pendingBuilds.length) return null
  const shown = cardFit(found?.fit, { listed, listedFit })
  const fit = shown ? fitText(shown) : null
  return h('div', { class: 'ext-group', role: 'group', 'aria-label': t('plugins.install') },
    found && !listed ? h('b', { text: t('plugins.found', { name: found.name ?? plugins.spec, version: found.version ?? '' }).trim() }) : null,
    found?.description && !listed ? h('p', { class: 'help', text: found.description }) : null,
    found?.bundle === false ? h('p', { class: 'form-error', text: t('plugins.not.a.bundle') }) : null,
    fit ? h('p', { class: shown?.kind === 'needs-web' ? 'form-error' : 'help', role: shown?.kind === 'needs-web' ? 'alert' : null, text: fit }) : null,
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

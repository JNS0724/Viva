import { t } from '../../shared/i18n/translate.ts'
import { h, label } from './dom.ts'

/**
 * 能力 · 插件 · 插件源 (view/capability-plugins.ts): the company's registry plugins install from, and its token. The
 * token typed is read from the form on 保存 and never shown again; left blank, the one kept stays.
 */
export const PLUGIN_SOURCE = '+source'

type Source = { registry: string | null, hasToken: boolean }
const sourceOf = (state: State): Source => (state.plugins.source as Source | null) ?? { registry: null, hasToken: false }

/** Where it is, as the list says it: the registry's host, or that there is none. */
function where(source: Source): string {
  if (!source.registry) return t('plugins.source.none')
  try {
    return new URL(source.registry).host
  } catch {
    return source.registry
  }
}

export function sourceRow(state: State, handlers: Handlers, current: boolean): HTMLElement {
  return h('button', {
    class: 'tp-row cap-row', type: 'button', 'aria-current': current ? 'page' : null, onClick: () => handlers.selectCapability(PLUGIN_SOURCE),
  }, h('span', { class: 'tp-name', text: t('capabilities.plugin.source') }), h('span', { class: 'ext-status', 'data-tone': sourceOf(state).registry ? 'ok' : 'idle', text: where(sourceOf(state)) }))
}

const formRow = (title: string, field: HTMLElement) => h('div', { class: 'ext-edit-row' }, label(title), field)

export function sourceMain(state: State, handlers: Handlers): HTMLElement {
  const source = sourceOf(state)
  const busy = Boolean(state.plugins.busy)
  const version = `${source.registry ?? ''}|${source.hasToken}`
  const field = (form: HTMLFormElement, name: string) => {
    const value = new FormData(form).get(name)
    return typeof value === 'string' ? value : ''
  }
  return h('div', { class: 'tp-main' },
    h('header', { class: 'tp-head' }, h('h2', { class: 'tp-title', text: t('capabilities.plugin.source') })),
    h('div', { class: 'tp-scroll' },
      h('form', {
        class: 'ext-edit', 'aria-label': t('capabilities.plugin.source'),
        onSubmit: (event: SubmitEvent) => {
          event.preventDefault()
          const form = event.currentTarget as HTMLFormElement
          handlers.savePluginSource(field(form, 'plugin-source-registry'), field(form, 'plugin-source-token'))
        },
      },
      formRow(t('plugins.source.address'), h('input', {
        class: 'field mono', name: 'plugin-source-registry', value: source.registry ?? '', 'data-version': version, placeholder: 'https://npm.example.com/',
        autocomplete: 'off', spellcheck: 'false', 'aria-label': t('plugins.source.address'),
      })),
      formRow(t('plugins.source.token'), h('input', {
        class: 'field', type: 'password', name: 'plugin-source-token', 'data-version': version, autocomplete: 'off', spellcheck: 'false',
        placeholder: source.hasToken ? t('plugins.source.token.kept') : t('plugins.source.token.none'), 'aria-label': t('plugins.source.token'),
      })),
      h('div', { class: 'ext-edit-foot' },
        h('button', { class: 'btn btn-accent btn-small', type: 'submit', disabled: busy, text: busy ? t('extensions.saving') : t('extensions.save') }),
        source.registry ? h('button', { class: 'btn btn-outline btn-small', type: 'button', disabled: busy, text: t('plugins.source.remove'), onClick: () => handlers.removePluginSource() }) : null),
      h('p', { class: 'help', text: t('plugins.source.help') }))))
}

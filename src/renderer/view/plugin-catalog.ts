import { t } from '../../shared/i18n/translate.ts'
import type { CatalogEntry } from '../capability-types.ts'
import { catalogPick } from '../plugins-state.ts'
import { h, label } from './dom.ts'
import { fitText, fitTone } from './plugin-fit-text.ts'
import { PLUGIN_SOURCE } from './plugin-source.ts'
import { installCard } from './plugins.ts'

/**
 * 能力 · 插件 · 添加插件 (view/capability-plugins.ts): the dsh plugins the company source has (backend/plugin-catalog.ts),
 * searched by name or words, each with whether it works in Viva; 查看 one puts it in the install field and looks it
 * up, so it is installed as one typed (view/plugins.ts), its card under it, where it was asked for. Without a source,
 * the way to set one.
 */
type Plugins = State['plugins']

function entryItem(entry: CatalogEntry, plugins: Plugins, handlers: Handlers, picked: boolean) {
  const fit = fitText(entry.fit)
  return h('li', { class: 'cap-catalog-item', 'data-name': entry.name },
    h('div', { class: 'cap-catalog-head' },
      h('span', { class: 'cap-catalog-name', text: entry.name }),
      h('span', { class: 'cap-catalog-version', text: entry.version }),
      fit ? h('span', { class: 'ext-status', 'data-tone': fitTone(entry.fit), title: fit, text: fit }) : null),
    entry.description ? h('p', { class: 'help', text: entry.description }) : null,
    picked ? installCard(plugins, handlers, { listed: true, listedFit: entry.fit }) : h('div', { class: 'settings-actions' },
      h('button', {
        class: 'btn btn-outline btn-small', type: 'button', disabled: plugins.busy, text: t('plugins.look'),
        'aria-label': t('plugins.catalog.look.named', { name: entry.name }), onClick: () => handlers.pickCatalogEntry(entry.name, entry.version),
      })))
}

export function catalogSection(plugins: Plugins, handlers: Handlers) {
  const title = t('plugins.catalog.title')
  if (!plugins.source?.registry) {
    return h('section', { class: 'ext-group cap-catalog', 'aria-label': title },
      h('b', { text: title }),
      h('p', { class: 'help', text: t('plugins.catalog.no.source') }),
      h('div', { class: 'settings-actions' },
        h('button', { class: 'btn btn-outline btn-small', type: 'button', text: t('plugins.catalog.set.source'), onClick: () => handlers.selectCapability(PLUGIN_SOURCE) })))
  }
  const { catalog } = plugins
  const entries = catalog.entries as readonly CatalogEntry[]
  const picked = catalogPick(plugins)
  const empty = catalog.searched && !catalog.problem && !entries.length
  return h('section', { class: 'ext-group cap-catalog', 'aria-label': title, 'aria-busy': catalog.searching ? 'true' : 'false' },
    h('b', { text: title }),
    h('form', {
      class: 'ext-form',
      onSubmit: (event: SubmitEvent) => {
        event.preventDefault()
        handlers.searchCatalog()
      },
    },
    h('label', { class: 'intro-item' }, label(t('plugins.catalog.query')),
      h('input', {
        class: 'field', name: 'plugin-catalog-query', type: 'search', value: catalog.query, placeholder: t('plugins.catalog.query.hint'),
        'aria-label': t('plugins.catalog.query'), spellcheck: 'false', autocomplete: 'off',
        onInput: (event: Event) => handlers.editCatalogQuery((event.target as HTMLInputElement).value),
      })),
    h('div', { class: 'settings-actions' },
      h('button', { class: 'btn btn-outline btn-small', type: 'submit', disabled: catalog.searching, text: catalog.searching ? t('plugins.catalog.searching') : t('plugins.catalog.search') }))),
    catalog.problem ? h('p', { class: 'form-error', role: 'alert', text: catalog.problem }) : null,
    empty ? h('p', { class: 'help', role: 'status', text: t('plugins.catalog.empty') }) : null,
    entries.length ? h('ul', { class: 'cap-candidates cap-catalog-list', 'aria-label': title }, ...entries.map((entry) => entryItem(entry, plugins, handlers, entry.name === picked))) : null)
}

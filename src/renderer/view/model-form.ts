import { t } from '../../shared/i18n/translate.ts'
import type { ProviderForm } from '../model-actions.ts'
import { shownDiscovered, type Discovery, type ModelDraft, type ModelRow } from '../model-state.ts'
import { h, label } from './dom.ts'
import { icon } from './icons.ts'

/**
 * The form that adds a model provider or changes one (my-agent-workspace#9): where it is, its key, and a row per
 * model with its context window, its longest answer and whether it reads pictures; 获取可用模型 asks the endpoint
 * for its models to pick from. Rows live in the state; what is typed stays in their fields (dom.ts keepingInput).
 */

type Models = State['models']
/** A provider as the form edits it (model-providers.ts providerView). */
export type ProviderView = Readonly<{ id: string, name: string, api: string, baseURL: string, keyHint?: string }>

/** More of a listing than this is not drawn at once; a search narrows it. */
const MAX_SHOWN = 100

type Field = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
const valueOf = (form: HTMLFormElement, name: string): string => (form.elements.namedItem(name) as Field | null)?.value ?? ''
const checkedOf = (form: HTMLFormElement, name: string): boolean => (form.elements.namedItem(name) as HTMLInputElement | null)?.checked ?? false
const fieldName = (row: Pick<ModelRow, 'key'>, part: 'id' | 'ctx' | 'out' | 'image') => `model-${part}-${row.key}`

/** A positive whole number as typed, or undefined. */
function countOf(text: string): number | undefined {
  const count = Number(text.trim())
  return text.trim() && Number.isInteger(count) && count > 0 ? count : undefined
}

/** What the form holds, as model-providers.ts parseProviderInput takes it. */
function formValues(form: HTMLFormElement, draft: ModelDraft): ProviderForm {
  return {
    name: valueOf(form, 'model-name'), api: valueOf(form, 'model-api'), baseURL: valueOf(form, 'model-url'), key: valueOf(form, 'model-key'),
    models: draft.rows.map((row) => ({
      id: valueOf(form, fieldName(row, 'id')), contextWindow: valueOf(form, fieldName(row, 'ctx')),
      maxTokens: valueOf(form, fieldName(row, 'out')), image: checkedOf(form, fieldName(row, 'image')),
    })),
  }
}

/** The rows as typed now, for picked models to join. */
function typedRows(form: HTMLFormElement, draft: ModelDraft): ModelRow[] {
  return draft.rows.map((row) => {
    const contextWindow = countOf(valueOf(form, fieldName(row, 'ctx')))
    const maxTokens = countOf(valueOf(form, fieldName(row, 'out')))
    return {
      key: row.key, id: valueOf(form, fieldName(row, 'id')).trim(),
      ...(contextWindow ? { contextWindow } : {}), ...(maxTokens ? { maxTokens } : {}), ...(checkedOf(form, fieldName(row, 'image')) ? { image: true } : {}),
    }
  })
}

function textField(name: string, title: string, hint: string, version: string, { value = '', secret = false } = {}) {
  return h('label', { class: 'intro-item' }, label(title), h('input', {
    class: 'field', name, value, placeholder: hint, 'aria-label': title, spellcheck: 'false', autocomplete: 'off', 'data-version': version,
    type: secret ? 'password' : 'text',
  }))
}

function modelRow(row: ModelRow, models: Models, version: string, handlers: Handlers) {
  const count = (part: 'ctx' | 'out', value: number | undefined, title: string, hint: number) => h('input', {
    class: 'field mono', name: fieldName(row, part), value: value ? String(value) : '', placeholder: hint ? String(hint) : '',
    inputmode: 'numeric', autocomplete: 'off', spellcheck: 'false', 'aria-label': title, 'data-version': version,
  })
  return h('div', { class: 'model-row' },
    h('input', {
      class: 'field mono', name: fieldName(row, 'id'), value: row.id, placeholder: 'kimi-k2.6', autocomplete: 'off', spellcheck: 'false',
      'aria-label': t('models.model.id'), 'data-version': version,
    }),
    count('ctx', row.contextWindow, t('models.context.window'), models.defaults.contextWindow),
    count('out', row.maxTokens, t('models.max.output'), models.defaults.maxTokens),
    h('label', { class: 'intro-check model-image' },
      h('input', { type: 'checkbox', name: fieldName(row, 'image'), checked: row.image === true, 'data-version': version }),
      h('span', { text: t('models.reads.images') })),
    h('button', {
      class: 'secret-del', type: 'button', title: t('models.remove.model'), 'aria-label': t('models.remove.model.named', { model: row.id || '—' }),
      onClick: () => handlers.removeModelRow(row.key),
    }, icon('close', 14)))
}

/** What the endpoint listed, to search and pick from. */
function discoveredPanel(discovery: Discovery, version: string, handlers: Handlers, adopt: () => void) {
  const found = discovery.found ?? []
  if (found.length === 0) return h('p', { class: 'help', role: 'status', text: t('models.discovery.none') })
  const shown = shownDiscovered(discovery)
  const picked = new Set(discovery.picked)
  return h('div', { class: 'model-pick', role: 'group', 'aria-label': t('models.discovery.found', { count: found.length }) },
    h('div', { class: 'model-pick-head' },
      h('span', { class: 'label', text: t('models.discovery.found', { count: found.length }) }),
      h('input', {
        class: 'field', name: 'model-discover-query', type: 'search', value: discovery.query, placeholder: t('models.discovery.search'),
        'aria-label': t('models.discovery.search'), autocomplete: 'off', spellcheck: 'false', 'data-version': version,
        onInput: (event: Event) => handlers.searchDiscovered((event.currentTarget as HTMLInputElement).value),
      })),
    h('ul', { class: 'model-pick-list' }, shown.slice(0, MAX_SHOWN).map((model) => h('li', null,
      h('label', { class: 'model-pick-item' },
        h('input', {
          type: 'checkbox', name: `model-pick-${model.id}`, checked: picked.has(model.id), 'data-version': version,
          onChange: () => handlers.pickDiscovered(model.id),
        }),
        h('span', { class: 'mono ellipsis', title: model.id, text: model.id }),
        model.name !== model.id ? h('span', { class: 'ext-detail ellipsis', text: model.name }) : null,
        model.contextWindow ? h('span', { class: 'ext-detail', text: t('models.discovery.context', { count: model.contextWindow }) }) : null)))),
    shown.length > MAX_SHOWN ? h('p', { class: 'help', text: t('models.discovery.more', { count: shown.length - MAX_SHOWN }) }) : null,
    shown.length === 0 ? h('p', { class: 'help', text: t('models.discovery.no.match') }) : null,
    h('div', { class: 'settings-actions' },
      h('button', {
        class: 'btn btn-accent btn-small', type: 'button', disabled: picked.size === 0,
        text: t('models.discovery.add.picked', { count: picked.size }), onClick: adopt,
      }),
      h('button', { class: 'btn btn-outline btn-small', type: 'button', text: t('models.discovery.close'), onClick: () => handlers.closeDiscovered() })))
}

/** The models of the form: 获取可用模型, the picker it opens, then a row per model. */
function modelsPart(form: HTMLFormElement, models: Models, draft: ModelDraft, version: string, handlers: Handlers) {
  const { discovery } = draft
  return h('div', { class: 'intro-item' },
    h('div', { class: 'row-between' },
      label(t('models.models.title')),
      h('button', {
        class: 'btn btn-outline btn-small', type: 'button', disabled: discovery.busy,
        text: discovery.busy ? t('models.discovery.busy') : t('models.discovery.fetch'),
        onClick: () => handlers.discoverModels({ api: valueOf(form, 'model-api'), baseURL: valueOf(form, 'model-url'), key: valueOf(form, 'model-key') }),
      })),
    discovery.error ? h('p', { class: 'form-error', role: 'alert', text: discovery.error }) : null,
    discovery.found ? discoveredPanel(discovery, version, handlers, () => handlers.adoptDiscovered(typedRows(form, draft))) : null,
    draft.rows.length ? h('div', { class: 'model-rows' },
      h('div', { class: 'model-row model-row-head', 'aria-hidden': 'true' },
        label(t('models.model.id')), label(t('models.context.window')), label(t('models.max.output')), h('span'), h('span')),
      draft.rows.map((row) => modelRow(row, models, version, handlers))) : null,
    h('button', { class: 'link-btn ext-add-key', type: 'button', text: t('models.add.model.row'), onClick: () => handlers.addModelRow() }),
    h('p', { class: 'help', text: t('models.rows.help', { context: models.defaults.contextWindow, output: models.defaults.maxTokens }) }))
}

/** The form for a new provider (`provider` null) or for changing `provider`; a key left blank keeps its key. */
export function providerForm(models: Models, draft: ModelDraft, provider: ProviderView | null, handlers: Handlers) {
  const version = String(draft.version)
  const form = h('form', {
    class: provider ? 'ext-edit' : 'ext-form',
    'aria-label': provider ? t('models.edit.provider', { name: provider.name }) : t('models.add.provider'),
    onSubmit: (event: SubmitEvent) => {
      event.preventDefault()
      handlers.saveProvider(formValues(form, draft))
    },
  })
  const protocols = Object.entries(models.protocols as Readonly<Record<string, string>>)
  form.append(
    provider ? h('div', { class: 'ext-edit-head' }, h('span', { class: 'ext-name', text: t('models.edit.provider', { name: provider.name }) })) : '',
    h('div', { class: 'intro-pair' },
      textField('model-name', t("extensions.name"), t("models.for.example.kimi.or.company.gateway"), version, { value: provider?.name ?? '' }),
      h('label', { class: 'intro-item' }, label(t("models.api.protocol")), h('select', {
        class: 'field', name: 'model-api', 'aria-label': t("models.api.protocol"), 'data-version': version,
      }, protocols.map(([value, text]) => h('option', { value, text, selected: provider?.api === value }))))),
    textField('model-url', t("models.api.address.baseurl"), 'https://api.example.com/v1', version, { value: provider?.baseURL ?? '' }),
    textField('model-key', t("models.api.key.optional.for.local.models"), provider?.keyHint ? t('models.key.leave.blank.to.keep', { keyHint: provider.keyHint }) : 'sk-…', version, { secret: true }),
    modelsPart(form, models, draft, version, handlers),
    h('p', { class: 'help', text: t("models.your.key.is.encrypted.only.the.last") }),
    h('div', { class: 'settings-actions' },
      h('button', {
        class: 'btn btn-accent btn-small', type: 'submit', disabled: models.busy,
        text: models.busy ? t("selectors.connecting") : provider ? t('models.save.and.connect') : t("models.add.and.connect"),
      }),
      h('button', { class: 'btn btn-outline btn-small', type: 'button', text: t("extensions.cancel"), onClick: () => handlers.closeProviderForm() })))
  return form
}

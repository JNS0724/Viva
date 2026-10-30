import { t } from '../../shared/i18n/translate.ts'
import { h, label } from './dom.ts'

/** The 模型 part of the state (state.ts). */
type Models = State['models']
/** A provider the user added (model-providers.ts), its key known only by its end. */
type Provider = { id: string, name: string, api: string, baseURL: string, models: readonly string[], keyHint?: string }

function providerItem(provider: Provider, models: Models, handlers: Handlers) {
  return h('li', { class: 'ext-item', 'data-name': provider.name },
    h('div', { class: 'ext-copy' },
      h('div', { class: 'ext-title' },
        h('span', { class: 'ext-name', text: provider.name }),
        h('span', { class: 'badge', text: models.protocols[provider.api] ?? provider.api })),
      h('span', { class: 'ext-detail mono ellipsis', title: provider.baseURL, text: provider.baseURL }),
      h('span', { class: 'ext-detail', text: t("models.models", { value1: provider.models.join('、') }) }),
      h('span', { class: 'ext-detail', text: provider.keyHint ? t("models.key.encrypted.and.saved", { keyHint: provider.keyHint }) : t("models.no.key") })),
    h('button', {
      class: 'btn btn-outline btn-small', type: 'button', disabled: models.busy, text: t("extensions.delete"),
      'aria-label': t("models.delete.model.provider", { name: provider.name }), onClick: () => handlers.removeProvider(provider),
    }))
}

function textField(name: string, title: string, hint: string, { multiline = false, secret = false } = {}) {
  const props = { class: 'field', name, placeholder: hint, 'aria-label': title, spellcheck: 'false', autocomplete: 'off' }
  const input = multiline ? h('textarea', { ...props, rows: 2 }) : h('input', { ...props, type: secret ? 'password' : 'text' })
  return h('label', { class: 'intro-item' }, label(title), input)
}

function providerForm(models: Models, handlers: Handlers) {
  const form = h('form', {
    class: 'ext-form',
    onSubmit: (event: SubmitEvent) => {
      event.preventDefault()
      const value = (name: string) => (form.elements.namedItem(name) as HTMLInputElement | null)?.value ?? ''
      handlers.addProvider({
        name: value('model-name'), api: value('model-api'), baseURL: value('model-url'), models: value('model-ids'), key: value('model-key'),
      })
    },
  },
  h('div', { class: 'intro-pair' },
    textField('model-name', t("extensions.name"), t("models.for.example.kimi.or.company.gateway")),
    h('label', { class: 'intro-item' }, label(t("models.api.protocol")), h('select', { class: 'field', name: 'model-api', 'aria-label': t("models.api.protocol") },
      Object.entries(models.protocols as Readonly<Record<string, string>>).map(([value, text]) => h('option', { value, text }))))),
  textField('model-url', t("models.api.address.baseurl"), 'https://api.example.com/v1'),
  textField('model-ids', t("models.model.ids.one.per.line"), 'kimi-k2.6\nkimi-k2.7-code', { multiline: true }),
  textField('model-key', t("models.api.key.optional.for.local.models"), 'sk-…', { secret: true }),
  h('p', { class: 'help', text: t("models.your.key.is.encrypted.only.the.last") }),
  h('div', { class: 'settings-actions' },
    h('button', { class: 'btn btn-accent btn-small', type: 'submit', disabled: models.busy, text: models.busy ? t("selectors.connecting") : t("models.add.and.connect") }),
    h('button', { class: 'btn btn-outline btn-small', type: 'button', text: t("extensions.cancel"), onClick: () => handlers.toggleAddProvider(false) })))
  return form
}

/** The 模型 part of settings: providers besides DeepSeek, each speaking one of the protocols dsh supports. */
export function modelsSection(models: Models, handlers: Handlers) {
  if (!models.loaded) return h('section', { class: 'ext' }, label(t("models.model")), h('p', { class: 'help', text: t("extensions.loading") }))
  return h('section', { class: 'ext', 'aria-label': t("models.model") },
    label(t("models.model")),
    h('div', { class: 'ext-group' },
      h('div', { class: 'row-between' },
        h('h3', { class: 'profile-heading', text: t("models.other.models") }),
        models.adding ? null : h('button', {
          class: 'btn btn-outline btn-small', type: 'button', id: 'add-model', text: t("models.add"), onClick: () => handlers.toggleAddProvider(true),
        })),
      models.providers.length
        ? h('ul', { class: 'ext-list' }, models.providers.map((provider: Provider) => providerItem(provider, models, handlers)))
        : h('p', { class: 'help', text: t("models.connect.openai.compatible.or.anthropic.compatible.models") }),
      models.adding ? providerForm(models, handlers) : null),
    models.error ? h('p', { class: 'form-error', role: 'alert', text: models.error }) : null,
    models.notice ? h('p', { class: 'form-notice', role: 'status', text: models.notice }) : null)
}

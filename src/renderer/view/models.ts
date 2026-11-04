import { t } from '../../shared/i18n/translate.ts'
import type { ModelDraft, ModelEntry } from '../model-state.ts'
import { h, label } from './dom.ts'
import { providerForm } from './model-form.ts'

/** The 模型 part of the state (state.ts). */
type Models = State['models']
/** A provider the user added (model-providers.ts), its key known only by its end. */
type Provider = { id: string, name: string, api: string, baseURL: string, models: readonly ModelEntry[], keyHint?: string }

function providerItem(provider: Provider, models: Models, handlers: Handlers) {
  return h('li', { class: 'ext-item', 'data-name': provider.name },
    h('div', { class: 'ext-copy' },
      h('div', { class: 'ext-title' },
        h('span', { class: 'ext-name', text: provider.name }),
        h('span', { class: 'badge', text: models.protocols[provider.api] ?? provider.api })),
      h('span', { class: 'ext-detail mono ellipsis', title: provider.baseURL, text: provider.baseURL }),
      h('span', { class: 'ext-detail', text: t("models.models", { value1: provider.models.map((model) => model.id).join('、') }) }),
      h('span', { class: 'ext-detail', text: provider.keyHint ? t("models.key.encrypted.and.saved", { keyHint: provider.keyHint }) : t("models.no.key") })),
    h('div', { class: 'ext-actions' },
      h('button', {
        class: 'btn btn-outline btn-small', type: 'button', disabled: models.busy || Boolean(models.draft), text: t("extensions.edit"),
        'aria-label': t("models.edit.provider", { name: provider.name }), onClick: () => handlers.openProviderForm(provider),
      }),
      h('button', {
        class: 'btn btn-outline btn-small', type: 'button', disabled: models.busy, text: t("extensions.delete"),
        'aria-label': t("models.delete.model.provider", { name: provider.name }), onClick: () => handlers.removeProvider(provider),
      })))
}

/** A provider being changed, as its form in place. */
const editedItem = (provider: Provider, models: Models, draft: ModelDraft, handlers: Handlers) =>
  h('li', { class: 'ext-item', 'data-name': provider.name, 'data-editing': 'true' }, providerForm(models, draft, provider, handlers))

/** The 模型 part of settings: providers besides DeepSeek, each speaking one of the protocols dsh supports. */
export function modelsSection(models: Models, handlers: Handlers) {
  const { draft } = models
  if (!models.loaded) return h('section', { class: 'ext' }, label(t("models.model")), h('p', { class: 'help', text: t("extensions.loading") }))
  return h('section', { class: 'ext', 'aria-label': t("models.model") },
    label(t("models.model")),
    h('div', { class: 'ext-group' },
      h('div', { class: 'row-between' },
        h('h3', { class: 'profile-heading', text: t("models.other.models") }),
        draft ? null : h('button', {
          class: 'btn btn-outline btn-small', type: 'button', id: 'add-model', text: t("models.add"), onClick: () => handlers.openProviderForm(),
        })),
      models.providers.length
        ? h('ul', { class: 'ext-list' }, models.providers.map((provider: Provider) => (draft?.editing === provider.id
          ? editedItem(provider, models, draft, handlers)
          : providerItem(provider, models, handlers))))
        : h('p', { class: 'help', text: t("models.connect.openai.compatible.or.anthropic.compatible.models") }),
      draft && !draft.editing ? providerForm(models, draft, null, handlers) : null),
    models.error ? h('p', { class: 'form-error', role: 'alert', text: models.error }) : null,
    models.notice ? h('p', { class: 'form-notice', role: 'status', text: models.notice }) : null)
}

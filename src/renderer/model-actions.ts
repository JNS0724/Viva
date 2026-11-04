import { t } from '../shared/i18n/translate.ts'
import type { ModelRow } from './model-state.ts'
import { isBusy } from './state.ts'

/** The form as typed: the provider's fields, and its model rows (counts as typed, blank for unset). */
export type ProviderForm = Readonly<{
  name: string, api: string, baseURL: string, key: string,
  models: ReadonlyArray<Readonly<{ id: string, contextWindow: string, maxTokens: string, image: boolean }>>,
}>
/** Where to ask for models: the form's protocol, address and key. */
type Endpoint = Readonly<{ api: string, baseURL: string, key: string }>

/**
 * The 模型 section of settings. Adding, editing or removing a provider restarts the agent, which resumes the
 * conversation on screen; the main process sends the new model list as a `ready` event.
 */
export function createModelActions({ api, getState, dispatch, errorMessage }: Pick<ActionDeps, 'api' | 'getState' | 'dispatch' | 'errorMessage'>) {
  const fail = (err: unknown) => dispatch({ type: 'models_failed', message: errorMessage(err) })

  /** What the main process answers a change with: the section as it is now, and the provider added or changed. */
  type ModelsView = { added?: string, updated?: string, [field: string]: unknown }

  async function change(request: () => Promise<ModelsView>, noticeFor: (view: ModelsView) => string) {
    if (getState().models.busy) return
    if (isBusy(getState())) {
      dispatch({ type: 'models_failed', message: t("model-actions.stop.the.current.task.before.changing.models") })
      return
    }
    dispatch({ type: 'models_busy' })
    try {
      const view = await request()
      dispatch({ type: 'models_saved', view, notice: noticeFor(view) })
    } catch (err) {
      fail(err)
    }
  }

  return {
    async loadModels() {
      try {
        dispatch({ type: 'models_loaded', view: await api.getModels() })
      } catch (err) {
        fail(err)
      }
    },
    /** The form, for a new provider or (given one) for changing it. */
    openProviderForm: (provider?: { id: string, models: readonly unknown[] }) => dispatch({ type: 'models_draft_open', provider: provider ?? null }),
    closeProviderForm: () => dispatch({ type: 'models_draft_close' }),
    addModelRow: () => dispatch({ type: 'models_row_add' }),
    removeModelRow: (key: number) => dispatch({ type: 'models_row_remove', key }),
    /** The form's provider saved: added, or the one edited changed. */
    saveProvider(form: ProviderForm) {
      const editing = getState().models.draft?.editing ?? null
      if (editing) return change(() => api.updateModelProvider(editing, form), (view) => t("model-actions.saved", { name: view.updated ?? '' }))
      return change(() => api.addModelProvider(form), (view) => t("model-actions.added.choose.its.models.from.the.model", { added: view.added ?? '' }))
    },
    removeProvider: (provider: { id: string, name: string }) => change(() => api.removeModelProvider(provider.id), () => t("model-actions.deleted", { name: provider.name })),
    /** 获取可用模型 at the form's endpoint; an answer for a form since closed or reopened is dropped. */
    async discoverModels(endpoint: Endpoint) {
      const draft = getState().models.draft
      if (!draft || draft.discovery.busy) return
      const current = () => getState().models.draft?.version === draft.version
      dispatch({ type: 'models_discovering' })
      try {
        const { models } = await api.discoverModels(endpoint, draft.editing ?? undefined)
        if (current()) dispatch({ type: 'models_discovered', models })
      } catch (err) {
        if (current()) dispatch({ type: 'models_discovery_failed', message: errorMessage(err) })
      }
    },
    searchDiscovered: (query: string) => dispatch({ type: 'models_discovery_query', query }),
    pickDiscovered: (id: string) => dispatch({ type: 'models_discovery_pick', id }),
    closeDiscovered: () => dispatch({ type: 'models_discovery_close' }),
    /** The picked models join the rows as they are typed now. */
    adoptDiscovered: (rows: readonly ModelRow[]) => dispatch({ type: 'models_adopt', rows }),
  }
}

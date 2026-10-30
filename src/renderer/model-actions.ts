import { t } from '../shared/i18n/translate.ts'
import { isBusy } from './state.ts'

/**
 * The 模型 section of settings. Adding or removing a provider restarts the agent, which resumes the
 * conversation on screen; the main process sends the new model list as a `ready` event.
 */
export function createModelActions({ api, getState, dispatch, errorMessage }: Pick<ActionDeps, 'api' | 'getState' | 'dispatch' | 'errorMessage'>) {
  const fail = (err: unknown) => dispatch({ type: 'models_failed', message: errorMessage(err) })

  /** What the main process answers a change with: the section as it is now, and the provider added. */
  type ModelsView = { added?: string, [field: string]: any }

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
    toggleAddProvider: (adding: boolean) => dispatch({ type: 'models_adding', adding }),
    addProvider: (values: Args<'models:add'>[0]) => change(() => api.addModelProvider(values), (view) => t("model-actions.added.choose.its.models.from.the.model", { added: view.added ?? '' })),
    removeProvider: (provider: { id: string, name: string }) => change(() => api.removeModelProvider(provider.id), () => t("model-actions.deleted", { name: provider.name })),
  }
}

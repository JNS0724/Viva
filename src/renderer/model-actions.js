import { isBusy } from './state.js'

/**
 * The 模型 section of settings. Adding or removing a provider restarts the agent, which resumes the
 * conversation on screen; the main process sends the new model list as a `ready` event.
 * @param {{
 *   api: typeof window.agent, getState: () => object, dispatch: (action: object) => void,
 *   errorMessage: (err: unknown) => string,
 * }} deps
 */
export function createModelActions({ api, getState, dispatch, errorMessage }) {
  const fail = (err) => dispatch({ type: 'models_failed', message: errorMessage(err) })

  async function change(request, noticeFor) {
    if (getState().models.busy) return
    if (isBusy(getState())) {
      dispatch({ type: 'models_failed', message: '先停止当前任务，再修改模型' })
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
    toggleAddProvider: (adding) => dispatch({ type: 'models_adding', adding }),
    addProvider: (values) => change(() => api.addModelProvider(values), (view) => `已添加「${view.added}」，可以在模型菜单里选择它的模型`),
    removeProvider: (provider) => change(() => api.removeModelProvider(provider.id), () => `已删除「${provider.name}」`),
  }
}

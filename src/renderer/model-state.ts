/** The 模型 section of settings: providers the user added besides DeepSeek. */
export const initialModels = Object.freeze({
  loaded: false,
  providers: [],
  /** Protocol id → what the form calls it. */
  protocols: {},
  /** The add-provider form is open. */
  adding: false,
  busy: false,
  error: null,
  notice: null,
})

const withModels = (state, changes) => ({ ...state, models: { ...state.models, ...changes } })

export const MODEL_ACTIONS: Record<string, Reducer> = {
  models_loaded: (state, { view }) => withModels(state, { ...view, loaded: true, busy: false }),
  models_busy: (state) => withModels(state, { busy: true, error: null, notice: null }),
  models_failed: (state, { message }) => withModels(state, { busy: false, error: message }),
  models_saved: (state, { view, notice }) => withModels(state, { ...view, loaded: true, busy: false, error: null, notice, adding: false }),
  models_adding: (state, { adding }) => withModels(state, { adding, error: null, notice: null }),
}

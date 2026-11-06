import type { ModelEntry, DiscoveredModel, ModelRow, Discovery, ModelDraft } from './model-types.ts'
export type { ModelEntry, DiscoveredModel, ModelRow, Discovery, ModelDraft } from './model-types.ts'
import type { ActionHandlers } from './action-types.ts'

const NO_DISCOVERY: Discovery = Object.freeze({ busy: false, error: null, found: null, query: '', picked: Object.freeze([]) })

/** The 模型 section of settings: providers the user added besides DeepSeek. */
export const initialModels = Object.freeze({
  loaded: false,
  providers: [],
  /** Protocol id → what the form calls it. */
  protocols: {},
  /** What dsh assumes of a model left unsized: the placeholders of its fields. */
  defaults: Object.freeze({ contextWindow: 0, maxTokens: 0 }),
  /** The add or edit form, null while closed. */
  draft: null as ModelDraft | null,
  /** How many times a form has opened: the next one's version. */
  drafts: 0,
  busy: false,
  error: null,
  notice: null,
})

type Models = State['models']
type Provider = Readonly<{ id: string, models: readonly ModelEntry[] }>

const withModels = (state: State, changes: Partial<Models>): State => ({ ...state, models: { ...state.models, ...changes } })

/** The form changed by `change`, or the state as it is while no form is open. */
function withDraft(state: State, change: (draft: ModelDraft) => Partial<ModelDraft>): State {
  const draft = state.models.draft
  return draft ? withModels(state, { draft: { ...draft, ...change(draft) } }) : state
}

const withDiscovery = (state: State, changes: Partial<Discovery>): State =>
  withDraft(state, (draft) => ({ discovery: { ...draft.discovery, ...changes } }))

/** The form, as opened the `version`th time, for `provider`'s models or for a new provider with one empty row. */
export function openDraft(version: number, provider: Provider | null): ModelDraft {
  const models: readonly ModelEntry[] = provider?.models.length ? provider.models : [{ id: '' }]
  return {
    editing: provider?.id ?? null,
    version,
    rows: models.map((model, key) => ({ ...model, key })),
    nextKey: models.length,
    discovery: NO_DISCOVERY,
  }
}

/** What the endpoint listed, matching the search by id or name. */
export function shownDiscovered(discovery: Discovery): readonly DiscoveredModel[] {
  const query = discovery.query.trim().toLowerCase()
  const found = discovery.found ?? []
  return query ? found.filter((model) => model.id.toLowerCase().includes(query) || model.name.toLowerCase().includes(query)) : found
}

/**
 * The picked models join the rows as typed so far (`current`, read from the form): a row left empty gives way,
 * a model already there is not added again, and what the endpoint says of a model's size fills its fields.
 */
export function adoptPicked(draft: ModelDraft, current: readonly ModelRow[]): Pick<ModelDraft, 'rows' | 'nextKey' | 'discovery'> {
  const kept = current.filter((row) => row.id.trim())
  const have = new Set(kept.map((row) => row.id.trim()))
  const picked = new Set(draft.discovery.picked)
  const adding = (draft.discovery.found ?? []).filter((model) => picked.has(model.id) && !have.has(model.id))
  const rows = [...kept, ...adding.map(({ id, contextWindow, maxTokens }, index) => ({
    key: draft.nextKey + index, id, ...(contextWindow ? { contextWindow } : {}), ...(maxTokens ? { maxTokens } : {}),
  }))]
  return { rows, nextKey: draft.nextKey + adding.length, discovery: NO_DISCOVERY }
}

export const MODEL_ACTIONS= {
  models_loaded: (state, { view }) => withModels(state, { ...view, loaded: true, busy: false }),
  models_busy: (state) => withModels(state, { busy: true, error: null, notice: null }),
  models_failed: (state, { message }) => withModels(state, { busy: false, error: message }),
  models_saved: (state, { view, notice }) => withModels(state, { ...view, loaded: true, busy: false, error: null, notice, draft: null }),
  models_draft_open: (state, { provider }) => {
    const drafts = state.models.drafts + 1
    return withModels(state, { drafts, draft: openDraft(drafts, provider ?? null), error: null, notice: null })
  },
  models_draft_close: (state) => withModels(state, { draft: null, error: null, notice: null }),
  models_row_add: (state) => withDraft(state, (draft) => ({ rows: [...draft.rows, { key: draft.nextKey, id: '' }], nextKey: draft.nextKey + 1 })),
  models_row_remove: (state, { key }) => withDraft(state, (draft) => ({ rows: draft.rows.filter((row) => row.key !== key) })),
  models_discovering: (state) => withDiscovery(state, { busy: true, error: null }),
  models_discovered: (state, { models }) => withDiscovery(state, { busy: false, error: null, found: models, query: '', picked: [] }),
  models_discovery_failed: (state, { message }) => withDiscovery(state, { busy: false, error: message }),
  models_discovery_query: (state, { query }) => withDiscovery(state, { query }),
  models_discovery_pick: (state, { id }) => withDraft(state, (draft) => {
    const { picked } = draft.discovery
    return { discovery: { ...draft.discovery, picked: picked.includes(id) ? picked.filter((one) => one !== id) : [...picked, id] } }
  }),
  models_discovery_close: (state) => withDiscovery(state, NO_DISCOVERY),
  models_adopt: (state, { rows }) => withDraft(state, (draft) => adoptPicked(draft, rows)),
} satisfies ActionHandlers

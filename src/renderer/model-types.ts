
/** A model of a provider, as the main process shows it (model-providers.ts ModelEntry). */
export type ModelEntry = Readonly<{ id: string, contextWindow?: number, maxTokens?: number, image?: boolean }>

/** A model the endpoint listed (model-discovery.ts). */
export type DiscoveredModel = Readonly<{ id: string, name: string, contextWindow?: number, maxTokens?: number }>

/** A row of the form: a key that names its fields, and what they start with; what is typed stays in them. */
export type ModelRow = Readonly<{ key: number } & ModelEntry>


/** 获取可用模型: what the endpoint listed, what the user searches and picks among it. */
export type Discovery = Readonly<{
  busy: boolean, error: string | null, found: readonly DiscoveredModel[] | null, query: string, picked: readonly string[],
}>


/** The add or edit form while open. */
export type ModelDraft = Readonly<{
  /** The provider edited, or null for a new one. */
  editing: string | null
  /**
   * Another each time the form opens, never one used before (models.drafts): its fields start fresh (dom.ts
   * keepingInput data-version), and an answer for a form since closed or opened again is told apart.
   */
  version: number
  rows: readonly ModelRow[]
  nextKey: number
  discovery: Discovery
}>

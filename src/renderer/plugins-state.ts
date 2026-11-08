import type { ActionHandlers, PayloadFor } from './action-types.ts'
import type { CatalogEntry } from './capability-types.ts'
import { t } from '../shared/i18n/translate.ts'
/**
 * The 插件 section of settings (plugins-ipc.ts): the dsh plugins the user installed, and an install in two steps:
 * what the spec names (`inspection`), then 安装; a first attempt may ask to allow dependency build scripts
 * (`pendingBuilds`), and 允许并安装 tries again with them. The company's own plugin source (plugin-source.ts) is its
 * address and whether it has a token; the token never comes to the window. What that source has is searched there
 * (`catalog`, plugin-catalog.ts); one picked is looked at and installed as one typed.
 */
const initialCatalog = Object.freeze({
  /** What the search field says. */
  query: '',
  searching: false,
  /** A search answered since the source last changed. */
  searched: false,
  entries: [] as readonly CatalogEntry[],
  /** Why the last search found nothing it could show, in words; null when it did. */
  problem: null as string | null,
})

export const initialPlugins = Object.freeze({
  loaded: false,
  /** dsh is running: its plugin manager answers. */
  connected: true,
  plugins: [] as Untyped[],
  /** The company's registry plugins install from; null until read. */
  source: null as { registry: string | null, hasToken: boolean } | null,
  /** Saves of the source that went through; each one empties its form's token field (view/plugin-source.ts). */
  sourceSaves: 0,
  /** What the install field says. */
  spec: '',
  /** Each time the field is filled or emptied for the user rather than typed in: its `data-version` (view/plugins.ts). */
  specVersion: 0,
  /** What the spec names, shown before anything is installed; null when nothing was looked up. */
  inspection: null as Untyped,
  /** Build scripts an install asked to allow. */
  pendingBuilds: [] as string[],
  busy: false,
  error: null as string | null,
  notice: null as string | null,
  catalog: initialCatalog,
})

const withPlugins = (state: State, changes: Partial<State['plugins']>): State => ({ ...state, plugins: { ...state.plugins, ...changes } })
const withCatalog = (state: State, changes: Partial<State['plugins']['catalog']>): State => withPlugins(state, { catalog: { ...state.plugins.catalog, ...changes } })

/** After an install, removal or switch: the list as it is now; an install that asks for build scripts stays open. */
const changed = (state: State, { view, notice = null, pendingBuilds = [] }: PayloadFor<'plugins_changed'>) => withPlugins(state, {
  ...view, loaded: true, busy: false, notice, error: null, pendingBuilds,
  ...(pendingBuilds.length ? {} : { spec: '', specVersion: state.plugins.specVersion + 1, inspection: null }),
})

export const PLUGIN_ACTIONS= {
  plugins_loaded: (state, { view }) => withPlugins(state, { ...view, loaded: true, busy: false }),
  plugins_busy: (state) => withPlugins(state, { busy: true, error: null, notice: null }),
  plugins_failed: (state, { message }) => withPlugins(state, { busy: false, error: message }),
  /** Typed, the field already says it; `filled` (a pick from the source) puts it there. */
  plugins_spec: (state, { spec, filled = false }) => withPlugins(state, {
    spec, inspection: null, pendingBuilds: [], error: null, notice: null, specVersion: state.plugins.specVersion + (filled ? 1 : 0),
  }),
  plugins_inspected: (state, { inspection }) => withPlugins(state, { busy: false, inspection }),
  plugins_changed: (state, change) => changed(state, change),
  /** The source saved or taken away: as any change, its token field starts empty again, and what the last one listed goes. */
  plugins_source_saved: (state, { view, notice }) => withPlugins(changed(state, { view, notice }), {
    sourceSaves: state.plugins.sourceSaves + 1, catalog: { ...initialCatalog, query: state.plugins.catalog.query },
  }),
  plugins_catalog_query: (state, { query }) => withCatalog(state, { query }),
  plugins_catalog_searching: (state) => withCatalog(state, { searching: true, problem: null }),
  plugins_catalog_found: (state, { entries }) => withCatalog(state, { searching: false, searched: true, entries, problem: null }),
  plugins_catalog_failed: (state, { problem }) => withCatalog(state, { searching: false, searched: true, entries: [], problem }),
  plugins_dismiss: (state) => withPlugins(state, { inspection: null, pendingBuilds: [], error: null }),
} satisfies ActionHandlers

/**
 * The entry the source listed that the lookup under way is of (picked there, so the spec is its name@version): its
 * card goes under it (view/plugin-catalog.ts), where it was asked for; null when the spec was typed, or nothing is
 * looked up.
 */
export function catalogPick(plugins: State['plugins']): string | null {
  if (!plugins.inspection && !plugins.pendingBuilds.length) return null
  const spec = plugins.spec.trim()
  return plugins.catalog.entries.find((entry) => `${entry.name}@${entry.version}` === spec)?.name ?? null
}

/** dsh's codes for a refusal (dsh-plugin-manager), in the user's words. */
const PROBLEMS: Readonly<Record<string, () => string>> = Object.freeze({
  'invalid-spec': () => t('plugins.problem.invalid-spec'),
  'already-installed': () => t('plugins.problem.already-installed'),
  'not-found': () => t('plugins.problem.not-found'),
  'not-a-package': () => t('plugins.problem.not-a-package'),
  'not-a-bundle': () => t('plugins.problem.not-a-bundle'),
  network: () => t('plugins.problem.network'),
  'incompatible-version': () => t('plugins.problem.incompatible-version'),
})

/** dsh's code for a refusal, in the user's words; the manager's own words for anything else. */
export function problemText(code: string, detail: string | null = null): string {
  return PROBLEMS[code]?.() ?? t('plugins.problem.unknown', { detail: detail ?? code })
}

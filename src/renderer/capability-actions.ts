import type { CapabilityTab } from './capabilities-state.ts'

/**
 * 能力 (capabilities-state.ts): opening it reads the skills, servers and plugins afresh (`load`: extension-actions.ts
 * and plugin-actions.ts, which own those reads); the tab, the one picked and the search are the page's own.
 */
export function createCapabilityActions({ dispatch, load }: Pick<ActionDeps, 'dispatch'> & { load: () => unknown }) {
  return {
    openCapabilities(tab?: CapabilityTab, id?: string | null) {
      dispatch({ type: 'capabilities_open', tab, id })
      load()
    },
    /** The hub opening: what is wrong is counted on the way in before the page is opened. */
    refreshCapabilities: () => { load() },
    capabilityTab: (tab: CapabilityTab) => dispatch({ type: 'capabilities_tab', tab }),
    selectCapability: (id: string | null) => dispatch({ type: 'capabilities_select', id }),
    searchSkills: (query: string) => dispatch({ type: 'capabilities_query', query }),
  }
}

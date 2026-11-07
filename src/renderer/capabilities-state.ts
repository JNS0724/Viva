import type { ActionHandlers } from './action-types.ts'
import { initialSkillImport } from './skill-import-state.ts'
import type { CapabilityTab, ExtensionStatus, PluginView, ServerView, SkillView } from './capability-types.ts'
export type { CapabilityTab } from './capability-types.ts'

/**
 * 能力: the skills, MCP servers and dsh plugins the agent has, a page of the hub beside 关于你 and 设置. The data stay
 * in their own slices (extensions in personal-state.ts, plugins in plugins-state.ts) with their own actions; this keeps
 * which tab is open, the one picked and what is searched, and works out what is shown and what is wrong.
 */
export const CAPABILITY_TABS: readonly CapabilityTab[] = Object.freeze(['skills', 'mcp', 'plugins'])

export const initialCapabilities = Object.freeze({
  open: false,
  tab: 'skills' as CapabilityTab,
  /** The id (a skill's) or name (a server's, a plugin's) picked; null shows the first that needs looking at. */
  selected: null as string | null,
  /** Narrows the skills listed. */
  query: '',
})

/** The tab open; the state's types widen it to text, so it is read back through the known tabs. */
export const openTab = (state: State): CapabilityTab => CAPABILITY_TABS.find((tab) => tab === state.capabilities.tab) ?? 'skills'

const withCapabilities = (state: State, changes: Partial<State['capabilities']>): State => ({ ...state, capabilities: { ...state.capabilities, ...changes } })

export const CAPABILITY_ACTIONS = {
  capabilities_open: (state, { tab, id }) => withCapabilities(
    { ...state, island: false },
    { open: true, tab: tab ?? state.capabilities.tab, selected: id ?? null, query: '' },
  ),
  capabilities_close: (state) => withCapabilities(state, { open: false }),
  /** Another tab, or a skill picked, leaves an import begun. */
  capabilities_tab: (state, { tab }) => withCapabilities({ ...state, skillImport: initialSkillImport }, { tab, selected: null, query: '' }),
  capabilities_select: (state, { id }) => withCapabilities({ ...state, skillImport: initialSkillImport }, { selected: id }),
  capabilities_query: (state, { query }) => withCapabilities(state, { query }),
} satisfies ActionHandlers

const skillsOf = (state: State): readonly SkillView[] => state.extensions.skills as readonly SkillView[]
const serversOf = (state: State): readonly ServerView[] => state.extensions.servers as readonly ServerView[]
const statusOf = (state: State): ExtensionStatus => state.extensions.status as ExtensionStatus
const pluginsOf = (state: State): readonly PluginView[] => state.plugins.plugins as readonly PluginView[]

/** How a server stands: a key it needs has no value, the agent connected it, dropped it (and why), or has not tried. */
export type ServerStanding = { kind: 'missing', names: readonly string[] } | { kind: 'connected' } | { kind: 'dropped', reason: string } | { kind: 'idle' }

export function serverStanding(server: ServerView, status: ExtensionStatus): ServerStanding {
  if (server.missingNames?.length) return { kind: 'missing', names: server.missingNames }
  if (status.active.includes(server.name)) return { kind: 'connected' }
  const dropped = status.dropped.find((item) => item.name === server.name)
  return dropped ? { kind: 'dropped', reason: dropped.reason } : { kind: 'idle' }
}

/** How a plugin stands: dsh says what is wrong with it, rows switched on that do not run, switched off, or on. */
export type PluginStanding = { kind: 'error', code: string, detail: string | null } | { kind: 'stalled', rows: readonly string[] } | { kind: 'off' } | { kind: 'on' }

export function pluginStanding(plugin: PluginView): PluginStanding {
  if (plugin.error) return { kind: 'error', code: plugin.error.code, detail: plugin.error.detail }
  if (!plugin.enabled) return { kind: 'off' }
  // A row waiting for a service only dsh's Web client has, or that failed to load.
  const stalled = plugin.rows.filter((row) => row.entryId && row.phase !== 'active').map((row) => row.id)
  return stalled.length ? { kind: 'stalled', rows: stalled } : { kind: 'on' }
}

const skillWrong = (skill: SkillView) => Boolean(skill.issues?.length)
const serverWrong = (server: ServerView, status: ExtensionStatus) => {
  const kind = serverStanding(server, status).kind
  return kind === 'missing' || kind === 'dropped'
}
const pluginWrong = (plugin: PluginView) => {
  const kind = pluginStanding(plugin).kind
  return kind === 'error' || kind === 'stalled'
}

/** The skills searched for, grouped by where they are, in the order the main process lists them. */
export function skillGroups(state: State): Array<{ root: string, label: string, skills: SkillView[] }> {
  const query = state.capabilities.query.trim().toLowerCase()
  const found = skillsOf(state).filter((skill) => !query || `${skill.name}\n${skill.description ?? ''}`.toLowerCase().includes(query))
  const roots = [...new Set(found.map((skill) => skill.root))]
  return roots.map((root) => {
    const skills = found.filter((skill) => skill.root === root)
    return { root, label: skills[0].rootLabel, skills }
  })
}

/** The one picked while it is listed, else the first that needs looking at, else the first. */
function shown<T>(items: readonly T[], idOf: (item: T) => string, wrong: (item: T) => boolean, selected: string | null): T | null {
  return items.find((item) => idOf(item) === selected) ?? items.find(wrong) ?? items[0] ?? null
}

export const shownSkill = (state: State): SkillView | null =>
  shown(skillGroups(state).flatMap((group) => group.skills), (skill) => skill.id, skillWrong, state.capabilities.selected)
export const shownServer = (state: State): ServerView | null =>
  shown(serversOf(state), (server) => server.name, (server) => serverWrong(server, statusOf(state)), state.capabilities.selected)
export const shownPlugin = (state: State): PluginView | null =>
  shown(pluginsOf(state), (plugin) => plugin.name, pluginWrong, state.capabilities.selected)

/**
 * What the last change on the open tab came to (a failure and why, or what was done), said whatever is listed or
 * picked: a first import that fails leaves nothing to pick, and removing the last one leaves nothing either.
 */
export function capabilityFeedback(state: State): { error: string | null, notice: string | null } {
  const slice = openTab(state) === 'plugins' ? state.plugins : state.extensions
  return { error: slice.error ?? null, notice: slice.notice ?? null }
}

/** How many each tab lists. */
export const capabilityCounts = (state: State): Record<CapabilityTab, number> =>
  ({ skills: skillsOf(state).length, mcp: serversOf(state).length, plugins: pluginsOf(state).length })

/** How many need looking at: a skill dsh skips, a server not working, a plugin broken or not running. */
export function capabilityProblems(state: State): number {
  const status = statusOf(state)
  return skillsOf(state).filter(skillWrong).length
    + serversOf(state).filter((server) => serverWrong(server, status)).length
    + pluginsOf(state).filter(pluginWrong).length
}

/**
 * What the 能力 page shows, as the main process sends it: skills (skills.ts listSkills), MCP servers
 * (mcp-config.ts serverView) with how the agent took them this time (session-info.ts), and dsh plugins
 * (plugins-ipc.ts pluginsView).
 */

/** The page's tabs (capabilities-state.ts CAPABILITY_TABS). */
export type CapabilityTab = 'skills' | 'mcp' | 'plugins'

/** Why dsh skips a skill (skill-spec.ts SkillIssue). */
export type SkillIssueCode = 'frontmatter' | 'fields' | 'name-format' | 'invocation'

/** A skill dsh found, where, whether it can be removed here, and why dsh would skip it or another hides it. */
export interface SkillView {
  id: string
  name: string
  description?: string
  root: string
  rootLabel: string
  managed?: boolean
  issues?: readonly SkillIssueCode[]
  /** The first issue in words; empty when there is none. */
  problem?: string
  /** The root whose skill of the same name dsh loads instead. */
  shadowedBy?: string | null
}

/** An MCP server as the user set it up, its secrets known only by name. */
export interface ServerView {
  name: string
  type: string
  url?: string
  command?: string
  args: readonly string[]
  envNames: readonly string[]
  headerNames: readonly string[]
  missingNames?: readonly string[]
}

/** What the agent loaded this time: servers connected or dropped, the memory plugin, the app's own plugins left out. */
export interface ExtensionStatus {
  active: readonly string[]
  dropped: ReadonlyArray<{ name: string, reason: string }>
  memory?: boolean
  plugins?: ReadonlyArray<{ contract: string, problem?: string }>
}

/** One row a plugin adds, and how it runs now. */
export interface PluginRow { id: string, entryId: string | null, enabled: boolean, phase: string | null }

/** An installed dsh plugin. */
export interface PluginView {
  name: string
  version: string | null
  description: string | null
  enabled: boolean
  removable: boolean
  error: { code: string, detail: string | null } | null
  /** It brings a part for dsh's Web client, which Viva does not run. */
  webUi: boolean
  rows: readonly PluginRow[]
  overrides: readonly string[]
}

/** A folder skills can be brought in from (skill-import.ts SkillSource), as the window sees it: where, not the path. */
export interface SkillSourceView { id: string, label: string, count: number, where: string }

/** A skill found in a folder being imported from, and whether and under what name it goes in. */
export interface SkillCandidateView {
  entry: string
  name: string
  description: string
  status: 'ready' | 'fixable' | 'blocked'
  issues: readonly SkillIssueCode[]
  fix: 'name-format' | 'taken' | null
  picked: boolean
}

/** A folder scanned for skills: its id for the import, what it is called, what it holds. */
export interface SkillScanView { scanId: string, label: string, candidates: readonly SkillCandidateView[] }

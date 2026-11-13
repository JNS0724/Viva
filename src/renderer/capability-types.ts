/**
 * What the 能力 page shows, as the main process sends it: skills (skills.ts listSkills), MCP servers
 * (mcp-config.ts serverView) with how the agent took them this time (session-info.ts), and dsh plugins
 * (plugins-ipc.ts pluginsView).
 */

/** The page's tabs (capabilities-state.ts CAPABILITY_TABS). */
export type CapabilityTab = 'skills' | 'mcp' | 'plugins' | 'sources'

/** How a message source stands since the app started (sources-desk.ts SourceStatus). */
export interface SourceStatus { checkedAt: number | null, nextAt: number | null, fresh: number, pushed: number, error: string }

/** A message source (sources-desk.ts SourceView): what it reads and how often, and how it stands. */
export interface SourceView {
  id: string
  name: string
  tool: string
  judge: string
  everyMinutes: number
  paused: boolean
  createdAt: number
  lastCheckedAt: number | null
  status: SourceStatus
}

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
  /** Trying to connect: the first time, or again after a failure (with it). dsh's MCP manager keeps at it. */
  connecting?: ReadonlyArray<{ name: string, reason: string }>
  dropped: ReadonlyArray<{ name: string, reason: string }>
  memory?: boolean
  plugins?: ReadonlyArray<{ contract: string, problem?: string }>
}

/** One row a plugin adds, and how it runs now. */
export interface PluginRow { id: string, entryId: string | null, enabled: boolean, phase: string | null }

export type PluginFit = { kind: 'declared' } | { kind: 'no-conflict' } | { kind: 'web-part' } | { kind: 'needs-web', needs: readonly string[] } | { kind: 'unknown' }

/** A dsh plugin the company source has (plugin-catalog.ts CatalogEntry), with whether it works in Viva. */
export interface CatalogEntry { name: string, version: string, description: string | null, fit: PluginFit }

/** An installed dsh plugin. */
export interface PluginView {
  name: string
  version: string | null
  description: string | null
  enabled: boolean
  removable: boolean
  error: { code: string, detail: string | null } | null
  /** What its package.json says of it in Viva (plugin-fit.ts): its author says it supports Viva, nothing known against it, its part for dsh's Web client not shown, it needs dsh's browser host, or nothing can be told. Whether it runs is its standing. */
  fit: PluginFit
  rows: readonly PluginRow[]
  overrides: readonly string[]
}

/** What 导入 brings in: skills (skill-import-ipc.ts) or MCP servers (mcp-import-ipc.ts). */
export type ImportKind = 'skills' | 'mcp'

/** Where things can be brought in from, as the window sees it: where, not the path. */
export interface ImportSourceView { id: string, label: string, count: number, where: string }

/**
 * One found there, and whether and under what name it goes in: `why` is one word, the kind's own (ready, name,
 * taken, missing, sse, command, no-kebab, the skill issue…), `detail` what goes with it (keys to fill in, a command).
 */
export interface ImportCandidateView {
  entry: string
  name: string
  status: 'ready' | 'fixable' | 'blocked'
  picked: boolean
  why: string
  detail: string | null
}

/** A place scanned: its id for the import, what it is called, what it holds. */
export interface ImportScanView { scanId: string, label: string, candidates: readonly ImportCandidateView[] }

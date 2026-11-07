import type { ConversationPayloads } from './conversation-types.ts'
import type { KeptTask } from '../shared/ipc-results.ts'
import type { FeedItemView, ScheduleView, FeedPick } from './feed-types.ts'
import type { ModelDraft, ModelEntry, ModelRow, DiscoveredModel } from './model-types.ts'
import type { ProposalCard } from './proposal-types.ts'
import type { CapabilityTab, ImportKind, ImportScanView, ImportSourceView } from './capability-types.ts'

type Info = AgentInfo
type SavedMessage = Pick<ThreadMessage, 'role' | 'text' | 'receipt' | 'images'>
type ReadConversation = { id: string, messages: readonly SavedMessage[], records?: readonly unknown[], updatedAt?: number, parentId?: string | null, createdAt?: number | null }
type Settings = Partial<State['settings']>
type Review = State['review']
/** Closed payload table: adding a UI operation requires naming its payload, never an open action dictionary. */
export interface ActionPayloads extends ConversationPayloads {
  ready: { info: Info }
  config_applied: { info: Partial<Info> }
  history_loaded: { conversationId?: string | null, messages: readonly SavedMessage[], records?: readonly unknown[], savedAt?: number, folds?: State['folds'], parentId?: string | null, createdAt?: number | null }
  conversation_saved: { id: string }
  session_switching: {}
  session_switch_failed: {}
  new_session_pending: { at: number }
  new_session_ready: { info: Info }
  new_session_failed: { message: string }
  new_session: { info?: Info | null, at?: number | null }
  workdir_switched: { info: Info }
  topic_resumed: { info: Info, parentId: string, at?: number | null, carried?: number | null }
  topic_menu: { open: boolean }
  trace_restored: { conversationId: string, available: boolean, trace: null | Pick<ConversationView, 'thoughts' | 'tools' | 'timeline'> }
  reveal_tick: { dt: number }
  picker_toggle: {}
  picker_close: {}
  settings_open: {}
  settings_close: {}
  settings_loaded: { view: Settings }
  settings_busy: {}
  settings_failed: { message: string }
  settings_saved: { view: Settings, notice: string | null }
  permission_menu: { open: boolean }
  permission_busy: {}
  permission_done: { level?: string | null }
  images_confirm: { open: boolean }
  images_busy: {}
  images_done: { usage?: State['settings']['images'] }
  open_drawer: { tab: string }
  close_drawer: {}
  toggle_drawer: {}
  toggle_island: {}
  close_island: {}
  hub_close: {}
  archived_conversation_saved: { sessionId: string, id: string }
  earlier_loading: {}
  earlier_loaded: { segments: readonly Segment[], hasMore: boolean }
  earlier_failed: {}
  history_open: {}
  history_close: {}
  history_toggle: {}
  history_query: { query: string }
  history_results: { query: string, results: State['history']['results'] }
  toast_show: { toast: NonNullable<State['toast']> }
  toast_hide: { key: number }
  feed_open: { kind?: FeedPick['kind'], id?: string }
  feed_close: {}
  feed_select: FeedPick
  feed_loaded: { items?: readonly FeedItemView[], schedules?: readonly ScheduleView[] }
  feed_busy: {}
  feed_failed: { message: string | null }
  files_listed: { path: string, entries: State['files']['folders'][string] }
  files_toggled: { path: string }
  files_selected: { path: string }
  files_previewed: { preview: State['files']['preview'] }
  files_more: {}
  files_apps: { path: string, apps: State['files']['apps'][string] }
  files_menu: { open: boolean }
  files_view: { mode: string }
  files_failed: { message: string }
  files_stale: {}
  models_loaded: { view: Partial<State['models']> }
  models_busy: {}
  models_failed: { message: string }
  models_saved: { view: Partial<State['models']>, notice: string }
  models_draft_open: { provider?: { id: string, models: readonly ModelEntry[] } | null }
  models_draft_close: {}
  models_row_add: {}
  models_row_remove: { key: number }
  models_discovering: {}
  models_discovered: { models: readonly DiscoveredModel[] }
  models_discovery_failed: { message: string }
  models_discovery_query: { query: string }
  models_discovery_pick: { id: string }
  models_discovery_close: {}
  models_adopt: { rows: readonly ModelRow[] }
  memory_loaded: { data: Partial<State['memory']> }
  memory_open: { view?: string }
  memory_close: {}
  memory_edit: { key: string | null }
  memory_busy: {}
  memory_failed: { message: string }
  memory_profile_saved: { profile: State['memory']['profile'] }
  memory_query: { query: string }
  memory_listed: { query: string, items: State['memory']['items'], total: number }
  memory_added: { memory: State['memory']['items'][number] }
  memory_removed: { id: string | number }
  memory_invalid_listed: { items: State['memory']['invalidItems'] }
  memory_invalid_closed: {}
  memory_revived: { memory: State['memory']['items'][number] }
  memory_onboarding: { status: State['memory']['onboarding'] }
  memory_docs_added: { docs: State['memory']['docs'] }
  extensions_loaded: { view: Partial<State['extensions']> }
  extensions_busy: {}
  extensions_failed: { message: string }
  extensions_saved: { view: Partial<State['extensions']>, notice: string | null, importNote?: string | null }
  extensions_import_menu: { open?: boolean }
  extensions_edit: { server: { name: string, type: string, envNames: string[], headerNames: string[], missingNames?: string[] } | null }
  extensions_edit_type: { kind: string }
  extensions_edit_key_add: {}
  extensions_edit_key_remove: { id: string | number }
  plugins_loaded: { view: Partial<State['plugins']> }
  plugins_busy: {}
  plugins_failed: { message: string }
  plugins_spec: { spec: State['plugins']['spec'] }
  plugins_inspected: { inspection: State['plugins']['inspection'] }
  plugins_changed: { view: Partial<State['plugins']>, notice?: string | null, pendingBuilds?: State['plugins']['pendingBuilds'] }
  plugins_dismiss: {}
  capabilities_open: { tab?: CapabilityTab, id?: string | null }
  capabilities_close: {}
  capabilities_tab: { tab: CapabilityTab }
  capabilities_select: { id: string | null }
  capabilities_query: { query: string }
  import_open: { kind: ImportKind, sources: readonly ImportSourceView[] }
  import_busy: {}
  import_scanned: { scan: ImportScanView }
  import_back: {}
  import_pick: { entry: string, on: boolean }
  import_failed: { message: string | null }
  import_close: {}
  schedule_proposed: { proposal: ProposalCard['proposal'] }
  proposal_busy: { id: string }
  proposal_settled: { id: string, status: ProposalCard['status'], accepted?: ProposalCard['accepted'] }
  proposal_failed: { id: string, message: string }
  resume_ask: { stage: string, segmentId: string, cwd?: string | null }
  resume_dismiss: {}
  review_loading: {}
  review_loaded: { topics: Review['topics'], hasMore: boolean, fresh?: boolean }
  review_failed: {}
  review_filter: { filter: string }
  review_open: { key: string }
  review_focus: { key: string, title: string, at?: number | null, head?: string | null, found?: string | null, notice?: string | null }
  review_unfocus: {}
  review_read: { key: string, read?: number, whole?: boolean, messages: readonly import('./review-types.ts').ReaderMessage[], from?: number, total?: number }
  review_read_loading: { read: number, edge: import('./review-types.ts').ReaderEdge }
  review_read_more: { read: number, edge: import('./review-types.ts').ReaderEdge, part: null | { messages: readonly import('./review-types.ts').ReaderMessage[], from: number, total: number } }
  review_starred: { items: Review['starred'] }
  stars_loaded: { places: readonly { segmentId: string, seq: number }[] }
  star_changed: { segmentId: string, seq: number, starred: boolean, changed?: boolean }
  rewind_edit: { id: string }
  rewind_cancel: {}
  rewind_busy: {}
  rewind_confirm: { id: string, text: string, effects: unknown }
  rewind_confirm_cancel: {}
  rewind_failed: {}
  fold_opened: { id: string, messages: readonly SegmentMessage[], records?: readonly unknown[] }
  fold_closed: { id: string }
  rewound: { conversation: ReadConversation, info: Info, folds: State['folds'] }
  workdir_loaded: { view: Partial<State['workDir']> & { current: string, defaultDir: string, isDefault: boolean } }
  workdir_menu: { open: boolean }
  workdir_confirm: { dir: string | null }
  workdir_switching: {}
  workdir_failed: { message: string | null }
  tasks_list_folded: { folded: boolean }
  task_submitting: { submission: State['tasks']['submissions'][number] }
  task_submit_failed: { id: string, problem: string }
  task_submit_dismissed: { id: string }
  task_started: { submissionId: string, origin?: string | null, task?: import('../shared/ipc-results.ts').TaskSummary, text?: string, at?: number, hostSession?: string | null }
  task_asked: { taskId: string, text: string, at: number }
  tasks_restored: { list: readonly KeptTask[] }
  tasks_page_open: { taskId?: string | null }
  tasks_page_close: {}
  tasks_page_select: { taskId: string }
  tasks_seen_restored: { ids: readonly string[] }
  tasks_page_steps: {}
  tasks_page_all_steps: {}
  task_closed: { taskId: string }
}

export interface TaskStream { taskId: string, runId: string, seq: number, at: number }
export interface TaskPayloads {
  task_update: TaskStream & ConversationPayloads['acp_update']
  task_permission_request: TaskStream & ConversationPayloads['permission_request']
  task_permission_closed: TaskStream & ConversationPayloads['permission_closed']
  task_question: TaskStream & ConversationPayloads['question_request']
  task_question_closed: TaskStream & ConversationPayloads['question_closed']
  task_steer: TaskStream & ConversationPayloads['user_steer']
  task_end: TaskStream & ConversationPayloads['turn_end'] & { message?: string | null }
  task_question_pick: { taskId: string } & ConversationPayloads['question_pick']
  task_question_answered: { taskId: string } & ConversationPayloads['question_answered']
  task_snapshot: { snapshot: import('../shared/ipc-results.ts').WindowSnapshot }
}
export type AllPayloads = ActionPayloads & TaskPayloads
export type AppAction = { [K in keyof AllPayloads]: { type: K } & AllPayloads[K] }[keyof AllPayloads]
export type PayloadFor<K extends keyof AllPayloads> = AllPayloads[K] & { type?: K }
export type ActionHandlers = { [K in keyof AllPayloads]?: (state: State, action: PayloadFor<K>) => State }
/** Dynamic lookup retains a checked key/payload pair; the assertion is only function variance. */
export function handleAction(state: State, action: AppAction, handlers: ActionHandlers): State {
  const handler = handlers[action.type] as ((state: State, action: AppAction) => State) | undefined
  return handler ? handler(state, action) : state
}

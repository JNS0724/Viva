import { createDshLifecycle, type DshLifetime } from './dsh-lifecycle.ts'
import { createConversationSession } from './conversation-session.ts'
import { sameContext } from '../shared/conversation-context.ts'
import { createConfigActions } from './config-actions.ts'
import { createSchedules, type Schedules } from './schedules.ts'
import { createScheduleRuns, type ScheduleRuns } from './schedule-runs.ts'
import { createUnattendedRuns, type RunResult, type TaskEvent } from './unattended-runs.ts'
import { FEED_WRITES, openFeedStore, type FeedItem, type FeedStore } from './feed-store.ts'
import { continueText, matchesFeedContinuation } from '../shared/feed-continuation.ts'
import { onLocaleChange } from '../shared/i18n/locale.ts'
import { t } from '../shared/i18n/translate.ts'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MAX_MESSAGE_CHARS as MAX_PROMPT_CHARS } from '../shared/text-limits.ts'
import { createHash, randomUUID } from 'node:crypto'
import { openMemoryStore } from './memory-store.ts'
import type { MemoryScope } from '../shared/memory-contract.ts'
import { createMemoryRuntime } from './memory-runtime.ts'
import { createMemoryEmbedder } from './memory-embedder.ts'
import { createMemoryWithdrawal } from './memory-withdrawal.ts'
import { createMemoryDispatch, MemoryDispatchConflict, needsMemoryTransport, type MemoryProvenance } from './memory-dispatch.ts'
import { registerRuntimeMemoryIpc } from './memory-ipc.ts'
import { carriedRecords } from './history-carry.ts'
import { activeHours } from './habits.ts'
import { openTraceDb } from '../../plugins/trace/lib/store.ts'
import { registerLanguageIpc } from './language-ipc.ts'
import { DEFAULT_PERMISSION, installedDshVersion, PERMISSION_LEVELS, PERSONA, resolvePlugins } from './app-plugins.ts'
import { APP_ROOT, CODE_ROOT } from '../shared/node/app-roots.ts'
import { DSH_PROFILE, resolveConfig } from './config.ts'
import { createAcpBridge, switchingMessage } from './acp-bridge.ts'
import { importDshServers, userDshHome } from './dsh-mcp-import.ts'
import { ensureDshProfile, vivaLayerFile } from './dsh-profile.ts'
import { pnpmLauncher, refusingLauncher } from './pnpm-launcher.ts'
import { dshEnv } from './dsh-runtime.ts'
import { registerExtensionsIpc } from './extensions-ipc.ts'
import { registerSkillImportIpc } from './skill-import-ipc.ts'
import { skillSources } from './skill-import.ts'
import { registerMcpImportIpc } from './mcp-import-ipc.ts'
import { clientPlaces, loginShellTools, mcpSources } from './mcp-import.ts'
import { registerPluginsIpc } from './plugins-ipc.ts'
import { registerFilesIpc } from './files-ipc.ts'
import { openHistoryDb } from './history-db.ts'
import { imagesForPrompt, registerImageIpc } from './image-ipc.ts'
import type { IpcRegistry } from '../shared/ipc-contract.ts'
import { createImageStore } from './image-store.ts'
import { registerHistoryIpc } from './history-ipc.ts'
import { registerRewindIpc } from './rewind-ipc.ts'
import { registerTaskIpc } from './task-ipc.ts'
import { createTaskReports, REPORT, type ReportPayload } from './task-reports.ts'
import { createReportRecords } from './report-records.ts'
import { createEffects, type Effect, type Effects } from './effects.ts'
import { createTaskRuntime, type TaskRuntime } from './task-runtime.ts'
import type { ScheduleAction, TaskAction } from './tasks-channel.ts'
import { createTaskStore } from './task-store.ts'
import { registerWorkDirIpc } from './work-dir-ipc.ts'
import { externalUrl } from './links.ts'
import { createMcpConfigStore } from './mcp-config.ts'
import { createModelStore, defaultModel, modelValue, parseModelValue, piAiProviders, providerEnv } from './model-providers.ts'
import { registerModelsIpc } from './models-ipc.ts'
import { createPersonal } from './personal.ts'
import { createPreferences } from './preferences.ts'
import { CONFIG_IDS } from './session-info.ts'
import { createSettingsStore, keyHint } from './settings-store.ts'
import { createPluginSourceStore } from './plugin-source.ts'
import { launchMessage } from './dsh-launch.ts'
import { authVariable, pinArgs, pnpmScopes } from './plugin-registry.ts'
import { pnpmRunner, searchCatalog, specFit, type PnpmCall } from './plugin-catalog.ts'
import { skillRoots } from './skills.ts'
import { historyRecall } from './history-recall.ts'
import type { HistoryEvidence } from './history-recall.ts'
import { openAppDb, type AppDb } from './app-db.ts'
import { createEventCore, type EventCore, type Signal } from './event-core.ts'
import { createTaskSignals, taskEventOf } from './task-signals.ts'
import { type Apply, journaled } from './journal.ts'
import { commandIpc } from './commands.ts'
import type { HostCapabilities, HostEvent, Notice } from './host.ts'

/**
 * The backend: everything of the app that is not the desktop (docs/system-design.md §2): the stores and
 * databases, dsh and its lifecycle, the conversation on screen, background tasks, memory, follow-ups and
 * preparation, models, extensions and plugins, and the channels the pages use for them. It reaches the desktop
 * only through HostCapabilities (host.ts); the shell (src/shell/main.ts) owns the windows, the tray, the desk
 * island, the shortcut and the app's lifecycle.
 */
const MAX_KEY_CHARS = 1_000
/** dsh's stock ACP profile: used, without memory, when the app's own profile can't be written. */
const FALLBACK_PROFILE = 'acp'
/** How much of a 动态 item a notification shows. */
const NOTICE_BODY_CHARS = 200
/** The effects queue's kind for a new 动态 item's notification. */
const FEED_NOTICE = 'feed-notice'
/** How many 动态 items the window is given, the latest first. */
const FEED_LISTED = 100

type HistoryDb = ReturnType<typeof openHistoryDb>
type Bridge = ReturnType<typeof createAcpBridge>
type AgentInfo = import('../shared/agent-info.ts').AgentInfo

/** The writes of the stores on the app database, each recorded with its event (journal.ts). */
const HISTORY_WRITES = Object.freeze(['save', 'addRecord', 'moveRecords', 'rename', 'setPinned', 'softDelete', 'restore', 'purgeDeleted', 'fold', 'unfold', 'setStar'] as const)

const isFolder = (dir: string) => {
  try {
    return fs.statSync(dir).isDirectory()
  } catch {
    return false
  }
}

function assertText(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > maxLength) throw new Error(`invalid ${name}`)
  return value
}

export function createBackend({ host, ipc }: { host: HostCapabilities, ipc: IpcRegistry }) {
  const userData = host.paths.userData
  // What the user does in a page is a signal first (commands.ts); every channel below is registered through this.
  const commands = commandIpc(ipc, (input) => signal(input))
  const ipcMain = commands.ipc
  // The stores and databases are opened once at launch (open, openHistory, openPersonal), before any window or
  // handler can reach them: `!` says so. What may be absent at any time says `| null`.
  /** The backend's database and its event core (app-db.ts, event-core.ts), opened first. */
  let appDb!: AppDb
  let core: EventCore | null = null
  /** One change of the backend's state and its event (event-core.ts apply), for the stores' writes. */
  const applyChange: Apply = (kind, data, write) => {
    if (!core) throw new Error(`${kind} before the event core was opened`)
    return core.apply(kind, data, write)
  }
  let settingsStore!: ReturnType<typeof createSettingsStore>
  let pluginSource!: ReturnType<typeof createPluginSourceStore>
  /** Switches from settings, such as the desktop island (preferences.ts). */
  let preferences!: ReturnType<typeof createPreferences>
  /** Model providers the user added besides DeepSeek; see model-providers.ts. */
  let modelStore!: ReturnType<typeof createModelStore>
  let historyDb!: HistoryDb
  /** Pictures pasted into questions, and dsh's copies of them, in a folder the user may move (image-store.ts). */
  let imageStore!: ReturnType<typeof createImageStore>
  /** The user's MCP servers, encrypted where they hold keys (mcp-config.ts). */
  let mcpStore!: ReturnType<typeof createMcpConfigStore>
  /** An MCP server was added or removed from the conversation: reattach the session once the turn is over. */
  let mcpReloadDue = false
  let memory!: ReturnType<typeof createMemoryRuntime>
  let memoryDispatch: ReturnType<typeof createMemoryDispatch> | undefined
  let memoryTransition = false
  const blockedMemoryDispatch = new Set<string>()
  /** What the trace plugin recorded, for the 过程 of reopened conversations; null if it can't be opened. */
  let traceDb: ReturnType<typeof openTraceDb> | null = null
  /** Background tasks still going or ended lately (task-store.ts); follow-ups look at it to not prepare what a task does. */
  let taskStore: ReturnType<typeof createTaskStore> | null = null
  /** The background tasks, their one writer (task-runtime.ts); set once the history is open. */
  let taskRuntime: TaskRuntime | null = null
  /** 动态's items (feed-store.ts): what schedules brought; set once the personal stores are open. */
  let feed: FeedStore | null = null
  let schedules: Schedules | null = null
  /** Schedules run when due, their answers into 动态 (schedule-runs.ts). */
  let scheduleRuns: ScheduleRuns | null = null
  /** Plugins left out of the profile at the last launch, and why; shown in settings. */
  let pluginProblems: Array<{ name: string, contract: string, problem: string }> = []
  /**
   * The pnpm dsh's plugin manager installs with, as this start prepared it (prepareProfile), for looking at what the
   * source has (plugin-catalog.ts); null before a start, and when a company source is set but its scopes could not be
   * pinned, where nothing is installed either.
   */
  let pluginPnpm: { call: PnpmCall, registry: string | null } | null = null
  const runPnpm = pnpmRunner()
  /** The user's MCP servers. */
  let personal!: ReturnType<typeof createPersonal>
  /** The foreground turn in progress. */
  let turn = { active: false, startedAt: 0 }
  /** What the window is told of the agent (session-info.ts, acp-bridge.ts): mode, model, session, what it remembers. */
  let lastInfo: AgentInfo = { mode: 'connecting', model: '', cwd: '', reason: '' }
  const sessions = createConversationSession({
    history: () => historyDb,
    agent: () => dsh.current,
    info: () => lastInfo,
    setInfo: (info) => { lastInfo = info },
    isBusy: () => turn.active,
    folderExists: isFolder,
    selectedModel: () => { const last = modelStore.lastModel(); return last ? modelValue(last) : null },
    changed: () => wakeEffects(),
  })

  /** A push for the window, numbered by the event core (a transient one: what changes state goes through apply). */
  function emitToRenderer(event: HostEvent) {
    if (event.type === 'ready') lastInfo = event.info
    if (event.type === 'config') lastInfo = { ...lastInfo, ...event.info }
    if (core) core.transient(event)
    else host.window.send({ ...event, seq: 0, transient: true })
  }

  /** What dsh reports of tasks: to the task runtime first, then its signal recorded (task-signals.ts). */
  const taskSignals = createTaskSignals({
    signal: (input) => signal(input),
    receive: (event) => taskRuntime?.dsh.receive(event),
    onError: (err) => console.error('[tasks] could not record what a task reported; it goes on all the same:', err instanceof Error ? err.message : String(err)),
  })

  /** Prompts run where nobody watches, read-only (a schedule's): their sessions' events are theirs, not 后台's. */
  const unattended = createUnattendedRuns({ agent: () => dsh.current, provenance: taskId => memoryDispatch?.snapshot(taskId) })

  /** One input to the backend (event-core.ts): recorded, then routed. */
  const signal = (input: Signal) => {
    if (!core) throw new Error(`signal ${input.kind} before the backend opened`)
    return core.signal(input)
  }

  const currentConfig = () => resolveConfig(process.env, fs.existsSync, settingsStore.getApiKey(), modelStore.list().length > 0, {
    userData, execPath: process.execPath, packaged: host.packaged,
  })
  /** The app's launch settings as resolved now (config.ts resolveConfig). */
  type Config = ReturnType<typeof currentConfig>

  /** dsh's home, which resolveConfig always sets when given the app's data folder (as currentConfig does). */
  function dshHomeOf(config: Config): string {
    if (!config.dshHome) throw new Error('dsh has no home folder')
    return config.dshHome
  }

  /** The pictures folder: where the user moved it, or in the app's data. */
  const imagesDir = () => preferences.get().imagesDir || path.join(userData, 'images')
  const workDirNow = sessions.cwd

  type DshContext = { config: Config, cwd: string, resumeSessionId: string | null }
  const dsh = createDshLifecycle({
    create: ({ config, cwd }: DshContext, lifetime) => {
      return createBridge(config, cwd, lifetime)
    },
    connect: (instance: Bridge, context: DshContext) => instance.start({ resumeSessionId: context.resumeSessionId }),
    onReady: (started, context) => {
      const old = sessions.current()
      const rebuild = staleMemorySession(old.sessionId)
      const info = sessions.ready(started, context.cwd)
      if (started.sessionId) memory?.recordSession(started.sessionId)
      if (rebuild || (!started.resumed && memory?.epoch() > 0 && historyDb.get(old.id))) storeSessionCarry(old.id)
      emitToRenderer({ type: 'ready', info })
      wakeEffects()
      void memory?.wake()
      scheduleRuns?.wake()
    },
    onGone: () => {
      taskRuntime?.dsh.gone(); unattended.gone()
      memory?.resetLive()
      memoryDispatch?.resetLive()
      // Retired generations cannot deliver a final error/turn_end. Settle the foreground here too,
      // including deliberate model/key restarts, before publishing the replacement's readiness.
      if (turn.active) {
        emitToRenderer({ type: 'turn_end', stopReason: 'cancelled', context: sessions.context() })
        finishForegroundTurn()
      }
    },
    onCrash: ({ message }, delay) => {
      turn = { active: false, startedAt: 0 }
      console.error('[dsh] exited unexpectedly:', message)
      emitToRenderer({ type: 'error', message: delay === null
        ? t("main.main.the.assistant.exited.repeatedly.retrying.has.stopped", { message })
        : t("main.main.the.assistant.exited.unexpectedly.reconnecting.in.seconds", { value1: Math.round(delay / 1000) }) })
    },
    restart: async (): Promise<unknown> => startBridge(),
    onRestartError: error => {
      console.error('[dsh] could not restart:', error)
      emitToRenderer({ type: 'error', message: t("main.main.could.not.connect.the.assistant", { message: error instanceof Error ? error.message : String(error) }) })
    },
  })

  function finishForegroundTurn(completed = false) {
    if (!turn.active) return
    turn = { ...turn, active: false }
    const sessionId = sessions.current().sessionId
    if (sessionId) memoryDispatch?.endTurn(sessionId)
    memory?.finishTurn(sessionId, completed)
  }

  const conversationMemoryScope = (): MemoryScope => ({ kind: 'conversation', id: sessions.topicId() })
  const memoryBusy = () => memoryTransition || Boolean(memory?.busy())
  const staleMemorySession = (id: string | null | undefined) =>
    Boolean(id && (memory?.staleSession(id) || memoryDispatch?.stale(id) || !memory?.provisionalReadsCurrent(id)))
  const allowMemorySession = (id: string) => !memoryBusy() && !staleMemorySession(id)
  const canTransferMemoryToModel = (id: string): boolean => Boolean(dsh.current?.memory.ready()) || !needsMemoryTransport(memoryDispatch?.snapshot(id))
  const allowedModelHistory = (row: HistoryEvidence) =>
    memory.allowedHistory(row) && (!row.sourceId || memory.sourceCurrent(row.sourceId))
    && ((row.role === 'user' && Boolean(row.sourceId)) || !staleMemorySession(row.sessionId))
  function usedHistory(session: string | undefined, row: HistoryEvidence) {
    if (!session || !memoryDispatch) return
    if (row.sourceId) memoryDispatch.recordSource(session, row.sourceId)
    if (row.role !== 'user' && row.sessionId) memoryDispatch.inherit(row.sessionId, session)
  }
  function trackCarry(session: string | null, evidence: readonly HistoryEvidence[]) {
    if (session) for (const row of evidence) usedHistory(session, row)
  }
  function storeSessionCarry(id: string) {
    const carry = filteredCarry(id, true)
    trackCarry(sessions.current().sessionId, carry.evidence)
    sessions.carryNext(id, carry.turns ? carry.text : '')
  }
  async function reopenMemorySession() {
    const started = await sessions.withSelection(async ({ switchAgent, select }) => {
      const previous = sessions.current()
      const started = await switchAgent(null, previous.cwd)
      select({ ...previous, sessionId: started.sessionId, cwd: started.cwd ?? previous.cwd })
      storeSessionCarry(previous.id)
      return started
    })
    emitToRenderer({ type: 'ready', info: { ...started, conversationId: sessions.current().id, topicId: sessions.topicId(), remembersHistory: false } })
  }
  function filteredCarry(conversationId: string, userOnly = false) {
    const topic = historyDb.topicOf(conversationId)
    const part = historyDb.read(userOnly || !topic ? `s:${conversationId}` : `t:${topic}`, { from: Number.MAX_SAFE_INTEGER, count: 40 })
    const rows = (part?.messages ?? []).filter(row => (!userOnly || row.role === 'user') && allowedModelHistory(row))
    return { ...carriedRecords(rows), evidence: rows }
  }

  async function changingMemory<T>(work: () => T | Promise<T>, { duringSelection = false } = {}): Promise<T> {
    if (memoryBusy() || (!duringSelection && sessions.isChanging())) throw new Error(t('main.memory.change.pending'))
    const connected = Boolean(dsh.current)
    memoryTransition = true
    try {
      // The stock profile can run without the adapter. Settle that process before a write can retire its history.
      if (dsh.current && !dsh.current.memory.ready()) {
        if (duringSelection) throw new Error(t('main.memory.context.stale'))
        await dsh.stop()
      }
      for (;;) {
        try { return await work() }
        catch (error) {
          if (!(error instanceof MemoryDispatchConflict)) throw error
          // A rolled-back write names the in-flight requests that used its affected facts.
          for (const session of memoryDispatch?.sessionsOf(error.requests) ?? []) blockedMemoryDispatch.add(session)
          await memoryDispatch?.whenIdle(error.requests)
        }
      }
    }
    finally {
      blockedMemoryDispatch.clear()
      memoryTransition = false
      dsh.current?.refreshMemoryQuestions()
      void memory.wake()
      scheduleRuns?.wake()
      if (connected && !dsh.current && !dsh.isQuitting()) await startBridge()
    }
  }

  function recordDeliveredSource(sourceId: string, origin = sessions.context(), { derived = false } = {}) {
    if (!origin.conversationId || !origin.sessionId || !memoryDispatch) throw new Error(t('main.memory.receipt.failed'))
    memory.recordDeliveredSource(sourceId, origin.conversationId, derived)
    memoryDispatch.recordSource(origin.sessionId, sourceId)
  }

  function acceptMemory(text: string, operation: string, origin = sessions.context(), question?: { question: string, requestId: string, questionId: string, custom?: true }, scope?: MemoryScope) {
    recordDeliveredSource(operation, origin)
    if (!text.trim()) return operation
    try {
      const context = origin.conversationId === sessions.current().id ? conversationMemoryScope() : scope
      const result = memory.accept(text, { conversation: origin.conversationId, session: origin.sessionId, scope, context }, operation, question)
      memory.bindSource(result.sourceId, origin.sessionId)
      return result.sourceId
    } catch {
      console.error('[memory] source receipt failed')
      emitToRenderer({ type: 'memory_changed', failure: t('main.memory.receipt.failed') })
      return operation
    }
  }

  /** The permission level picked; one no longer offered (an older or edited file) reads as the default. */
  const permissionNow = () => (PERMISSION_LEVELS.includes(preferences.get().permission) ? preferences.get().permission : DEFAULT_PERMISSION)

  /**
   * Writes the app's dsh profile: the persona and the plugins that pass the compatibility check, in the app's layer
   * given to dsh over the profile (dsh-profile.ts). Without it dsh still runs on its stock profile, with no memory,
   * trace or policy, and without the app's layer.
   */
  function prepareProfile(config: Config): { profile: string, overlay: string | null, launch: object } {
    // dsh takes the pnpm and the registry token over IPC (dsh-launch.ts), never in its environment.
    let pnpmCommand: string | null = null
    let scopes: string[] = []
    const registry = pluginSource.registry()
    const launch = () => launchMessage({ pnpmCommand, registry, registryToken: pluginSource.token(), scopes })
    // With a company registry plugins cannot be kept to, dsh gets a pnpm that installs nothing (pnpm-launcher.ts).
    const refuse = () => { pnpmCommand = refusingLauncher({ dir: path.join(userData, 'bin'), message: t('main.plugin-source.unpinned') }) }
    try {
      const { plugins, problems } = resolvePlugins({ codeRoot: CODE_ROOT, userData, dshVersion: installedDshVersion(APP_ROOT), permission: permissionNow() })
      pluginProblems = problems
      problems.forEach(({ name, problem }) => console.error(`[plugins] ${name} left out: ${problem}`))
      pnpmCommand = pnpmLauncher({ dir: path.join(userData, 'bin'), appRoot: APP_ROOT, runtime: config.runtime })
      const dir = ensureDshProfile({
        dshHome: dshHomeOf(config), profile: DSH_PROFILE, plugins, persona: PERSONA, models: profileModels(config), imagesDir: imagesDir(), pnpmCommand, registry,
      })
      const found = registry ? scopesOf(dir, pnpmCommand) : []
      if (found) scopes = found
      else refuse()
      pluginPnpm = found ? { call: pnpmCallFor(pnpmCommand, dir, registry, found), registry } : null
      return { profile: DSH_PROFILE, overlay: vivaLayerFile(dshHomeOf(config)), launch: launch() }
    } catch (err: any) {
      console.error('[plugins] could not prepare the dsh profile, starting without the app plugins:', err.message)
      pluginPnpm = null
      // dsh's stock profile knows no company registry: its plugin manager would install from the public ones.
      if (registry) refuse()
      return { profile: FALLBACK_PROFILE, overlay: null, launch: launch() }
    }
  }

  /** The plugin manager's pnpm, run here: the company source with its token and every scope pinned to it, as dsh-launch.ts. */
  function pnpmCallFor(command: string | null, cwd: string, registry: string | null, scopes: readonly string[]): PnpmCall {
    if (!registry) return { command: command ?? 'pnpm', cwd, args: [], env: process.env }
    const token = pluginSource.token()
    return {
      command: command ?? 'pnpm', cwd, args: [...pinArgs(registry, scopes), `--registry=${registry}`],
      env: { ...process.env, ...(token ? { [authVariable(registry)]: token } : {}) },
    }
  }

  /**
   * The scopes the plugin manager's pnpm finds where it installs, each to be sent to the company registry too
   * (plugin-registry.ts); null when pnpm cannot say, which is not none.
   */
  function scopesOf(dir: string, pnpmCommand: string | null): string[] | null {
    try {
      return pnpmScopes({ command: pnpmCommand ?? 'pnpm', cwd: dir, env: process.env })
    } catch (err: any) {
      console.error('[plugins] could not read the scoped registries pnpm knows, so no plugin is installed until it can:', err.message)
      return null
    }
  }

  /** The models dsh offers: DeepSeek with a key, the user's providers, and the one new sessions start with. */
  function profileModels(config: Config) {
    const providers = modelStore.list()
    const hasDeepSeek = Boolean(config.apiKey)
    return { providers: piAiProviders(providers), deepseek: hasDeepSeek, defaultModel: defaultModel({ lastModel: modelStore.lastModel(), providers, hasDeepSeek }) }
  }

  const takenServerNames = () => mcpStore.list().map((server) => server.name)

  /** Takes the MCP servers of a dsh home over, keys and all (dsh-mcp-import.ts); names already in use are skipped. */
  const importDsh = (dir: string) => importDshServers({ dir, store: mcpStore, takenNames: takenServerNames })

  /**
   * What the model may change from the conversation (viva-config plugin, config-channel.ts), each after the
   * user approved it on the card: MCP servers through the encrypted store, skills in the app's own folder.
   */
  function configActions(config: Config) {
    return createConfigActions({
      store: mcpStore,
      roots: () => skillRoots({ dshHome: dshHomeOf(config), cwd: workDirNow() ?? config.cwd }),
      onMcpChange: () => { mcpReloadDue = true }, importDsh,
      rememberDshDir: (dir) => preferences.set('dshImportDir', dir), trash: (file) => host.shell.trash(file),
    })
  }

  function reloadMcpAfterTurn() {
    mcpReloadDue = false
    applyMcpChange()
      .catch((err) => console.error('[mcp] could not reattach the session after a change:', err.message))
      // A task's result held back while the session was reattached comes back now.
      .finally(wakeEffects)
  }

  /** Events from a replaced bridge are dropped so a restart can't leak into the new conversation. */
  function createBridge(config: Config, cwd: string, lifetime: DshLifetime): Bridge {
    return createAcpBridge({
      prewarmSessions: true,
      dshBin: config.dshBin,
      nodeBin: config.nodeBin,
      ...prepareProfile(config),
      cwd,
      env: dshEnv({ base: process.env, dshHome: dshHomeOf(config), runtime: config.runtime, settings: dshSettings(config) }),
      mcpServers: () => personal.mcpServers(),
      configActions: configActions(config),
      allowSession: (id, transportReady, isTask) => {
        if (!allowMemorySession(id)) return false
        if (transportReady) return true
        const evidence = memoryDispatch?.snapshot(id)
        if (isTask) return !needsMemoryTransport(evidence)
        const admission = memoryDispatch?.admission(id)
        return !evidence?.turnOnly && !evidence?.dependencies.length && (!admission || admission.allowed && admission.deadline === null)
      },
      onSessionCreated: (id, parent) => {
        memory.recordSession(id)
        if (parent) memoryDispatch?.inherit(parent, id)
      },
      readyMemory: () => { void memory.wake(); scheduleRuns?.wake() },
      beginMemoryDispatch: async (id, session) => {
        const at = Date.now()
        if (blockedMemoryDispatch.has(session) || memory.staleSession(session) || !memory.provisionalReadsCurrent(session, at)) return false
        const admission = memoryDispatch?.admission(session)
        if (!admission?.allowed) return false
        const provisional = memory.provisionalDeadline(session, at)
        memoryDispatch?.acquireSession(id, session, admission, () => !memory.staleSession(session) && memory.provisionalReadsCurrent(session, at))
        return { allowed: true, deadline: provisional === undefined ? admission.deadline : Math.min(provisional, admission.deadline ?? Infinity) }
      },
      beginMemoryJobDispatch: async (id, jobId) => {
        if (memoryBusy()) return false
        const job = memory.computeAdmission(jobId)
        if (!job) return false
        memoryDispatch?.acquire(id, job.current)
        return { allowed: true, deadline: job.deadline }
      },
      endMemoryDispatch: id => {
        memoryDispatch?.release(id)
        void memory.wake()
      },
      memoryRequest: (request, foregroundTurn, operation, stillCurrent, signal) => memory.handleModelRequest(request, {
        conversation: request.session === sessions.current().sessionId ? sessions.current().id : null,
        session: request.session,
        context: request.session === sessions.current().sessionId
          ? conversationMemoryScope() : { kind: 'task', id: request.session },
        foregroundTurn,
        turn: operation,
      }, stillCurrent, signal),
      memoryClarificationQuestion: (session, turn, id, phase) => memory.clarificationQuestion(session, turn, id, phase),
      allowGeneralQuestion: (session, turn, cards, stillWaiting) => turn ? memory.authorizeGeneralQuestion({
        session, turn, conversation: session === sessions.current().sessionId ? sessions.current().id : null,
        context: session === sessions.current().sessionId ? conversationMemoryScope() : { kind: 'task', id: session },
      }, cards, stillWaiting) : false,
      onQuestionAnswer: (entry, answers, operation) => {
        if (memoryBusy()) throw new Error(t('main.memory.change.pending'))
        if (!entry.taskId && entry.kind === 'memory') {
          memoryDispatch?.recordTurnOnly(entry.sessionId)
        }
        // Options come from the assistant. Intake gets only the user's own text.
        if (entry.taskId || !entry.context) return
        let sourceId: string | undefined
        for (const answer of answers) {
          const text = answer.custom?.trim()
          const question = entry.question.questions.find(item => item.id === answer.id)
          if (!text || !question) continue
          const digest = createHash('sha256').update(JSON.stringify([entry.question.id, answer.id])).digest('hex')
          const derived = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`
          const accepted = acceptMemory(text, sourceId ? derived : operation ?? derived, entry.context,
            { question: question.question, requestId: entry.question.id, questionId: answer.id, custom: true })
          sourceId ??= accepted
        }
        return sourceId
      },
      historySearch: (query, range, session) => (!memoryBusy() && dsh.current?.memory.ready() && historyDb
        ? historyRecall(historyDb, allowedModelHistory, row => usedHistory(session, row)).search(query, range) : []),
      historyRead: (ref, around, session) => (!memoryBusy() && dsh.current?.memory.ready() && historyDb
        ? historyRecall(historyDb, allowedModelHistory, row => usedHistory(session, row)).read(ref, around) : { status: 'deleted' as const }),
      taskRead: (request, sessionId) => {
        if (memoryBusy() || (request.op === 'get' && staleMemorySession(request.taskId))) throw new Error(t('main.memory.context.stale'))
        const result = requireTasks().agent.query(request, sessionId === lastInfo.sessionId ? { cwd: workDirNow() ?? '' } : { taskId: sessionId })
        if (request.op === 'get' && request.taskId) {
          if (!canTransferMemoryToModel(request.taskId)) throw new Error(t('main.memory.context.stale'))
          memoryDispatch?.inherit(request.taskId, sessionId)
        }
        if ('tasks' in result && result.tasks) {
          const tasks = result.tasks.filter(task => !staleMemorySession(task.taskId) && (!task.taskId || canTransferMemoryToModel(task.taskId)))
          for (const task of tasks) if (task.taskId) memoryDispatch?.inherit(task.taskId, sessionId)
          return { ...result, tasks }
        }
        return result
      },
      taskAct: (request, sessionId) => actOnTask(request, sessionId),
      conversationContext: sessionId => {
        const context = sessions.context()
        return context.sessionId === sessionId ? context : { conversationId: null, sessionId }
      },
      emit: (event) => {
        if (!lifetime.isCurrent()) return
        // A task's result written (shown where it came), read (kept, then done) or lost (sent again), as said by the
        // session it was delivered to; said of another session, it is not this report's. Read but its record not kept
        // (the database busy): a pass now, which puts it off to try again.
        if (event.type === 'report_written' || event.type === 'report_read' || event.type === 'report_dropped') {
          const reportId = String(event.reportId)
          const queued = effects?.get(REPORT, reportId) as Effect<ReportPayload> | null | undefined
          if (!queued || queued.payload.deliveredTo !== event.sessionId) return undefined
          if (event.type === 'report_dropped') return wakeEffects()
          try {
            return event.type === 'report_written' ? records.written(queued) : records.read(queued)
          } catch (err) {
            console.error('[reports]', err instanceof Error ? err.message : String(err))
            return wakeEffects()
          }
        }
        // A task's turn ending, or its waiting on the user beginning or ending, is a signal; what it says streams. Each
        // reaches the window from the task runtime, in order with the task's snapshots (task-runtime.ts), not from here.
        const { taskId } = event
        if (typeof taskId === 'string' && unattended.owns(taskId)) return unattended.receive({ ...event, taskId } satisfies TaskEvent)
        const task = taskEventOf(event)
        if (task) return taskSignals.report(task)
        emitToRenderer(event)
        if (event.type === 'turn_end') return signal({ kind: 'agent.turn_ended', stopReason: typeof event.stopReason === 'string' ? event.stopReason : undefined })
        if (event.type === 'error') finishForegroundTurn()
        return undefined
      },
      onExit: lifetime.onExit,
    })
  }

  /**
   * The agent of the conversation on screen starting, stopping or messaging a task (viva-tasks). A task's own session
   * may not; and only a task the conversation could list (its working folder) can be stopped or messaged.
   */
  async function actOnTask(request: TaskAction, sessionId: string) {
    if (sessionId !== lastInfo.sessionId) throw new Error(t('main.tasks-channel.not.from.a.task'))
    if (!allowMemorySession(sessionId)) throw new Error(t('main.memory.context.stale'))
    const evidence = memoryDispatch?.snapshot(sessionId)
    const admit = (taskId: string) => {
      if (!allowMemorySession(sessionId) || !allowMemorySession(taskId) || !canTransferMemoryToModel(taskId)
        || (needsMemoryTransport(evidence) && !dsh.current?.memory.ready()) || (evidence && !memoryDispatch?.transferable(evidence))) return false
      if (evidence) memoryDispatch?.attach(taskId, evidence)
      return true
    }
    if (request.op.startsWith('schedule_')) {
      if (!schedules) throw new Error(t('main.tasks-channel.task.queries.are.not.enabled.in.this'))
      const memoryReady = dsh.current?.memory.ready()
      if (request.op === 'schedule_list') {
        const modelSchedules = schedules.store.list().filter(schedule => !schedule.memory
          || (!needsMemoryTransport(schedule.memory) || memoryReady) && memoryDispatch?.transferable(schedule.memory))
        if (memoryDispatch) for (const schedule of modelSchedules) if (schedule.memory) memoryDispatch.attach(sessionId, schedule.memory)
        const visible = new Set(modelSchedules.map(schedule => schedule.id))
        return schedules.list().filter(schedule => visible.has(schedule.id))
      }
      if (!memoryReady && (request.op === 'schedule_create' || request.op === 'schedule_update')) {
        throw new Error(t('main.memory.context.stale'))
      }
      if (request.op === 'schedule_update') {
        const old = schedules.store.get(request.id)?.memory
        if (old && !memoryDispatch?.transferable(old) && (request.prompt === undefined || request.title === undefined)) {
          throw new Error(t('main.schedule-runs.memory.stale'))
        }
        if (old && memoryDispatch?.transferable(old)) memoryDispatch.attach(sessionId, old)
      }
      return schedules.act(request as ScheduleAction, sessions.current().id, workDirNow() ?? '', evidence)
    }
    const tasks = requireTasks().agent
    if (request.op !== 'start' && request.op !== 'stop' && request.op !== 'message') throw new Error(t('main.task-registry.unknown.task.query.operation'))
    if (request.op === 'start') return tasks.start(request.brief, admit)
    tasks.query({ op: 'get', taskId: request.taskId }, { cwd: workDirNow() ?? '' })
    if (request.op === 'stop') return tasks.stop(request.taskId)
    return tasks.message(request.taskId, request.text, admit)
  }

  function requireSchedules(): Schedules {
    if (!schedules) throw new Error(t('main.tasks-channel.task.queries.are.not.enabled.in.this'))
    return schedules
  }

  function requireFeed(): FeedStore {
    if (!feed) throw new Error('动态 is not open yet')
    return feed
  }

  function requireTasks(): TaskRuntime {
    if (!taskRuntime) throw new Error(t('main.tasks-channel.task.queries.are.not.enabled.in.this'))
    return taskRuntime
  }

  /**
   * Results of background tasks, back in the conversation on screen (task-reports.ts): into the turn running there,
   * or as a turn of their own once nothing runs. The window is told such a turn began, as it is told nothing else of
   * it: no words of the user's.
   */
  const taskReports = createTaskReports({
    conversation: () => (!dsh.current || memoryBusy() || staleMemorySession(dsh.current.currentSession())
      || sessions.isChanging() || dsh.current.isSwitching() || dsh.isQuitting() ? 'away' : turn.active ? 'busy' : 'idle'),
    session: () => dsh.current?.currentSession() ?? null,
    holds: (effect) => effects?.holds(effect) ?? false,
    status: (session, reportId, token) => dsh.current?.reportStatus(session, reportId, token) ?? Promise.resolve('unavailable'),
    deliver: (session, reportId, token, text, taskId) => {
      if (!allowMemorySession(session) || staleMemorySession(taskId) || !canTransferMemoryToModel(taskId)) return Promise.resolve('unavailable')
      memoryDispatch?.inherit(taskId, session)
      return dsh.current?.deliverReport(session, reportId, token, text) ?? Promise.resolve('unavailable')
    },
    // Where a report went is kept with it (task-reports.ts): only that session's word on it counts.
    amend: (effect, payload) => effects?.amend(effect, payload) ?? false,
    onRead: (effect) => {
      try {
        records.read(effect)
      } catch (err) {
        console.error('[reports] could not keep a report\'s record:', err instanceof Error ? err.message : String(err))
        throw err
      }
    },
    currentConversation: () => sessions.current().id,
    superseded: (taskId, runId) => staleMemorySession(taskId) || (taskRuntime?.reports.superseded(taskId, runId) ?? false),
    report: (note, taskIds) => {
      const agent = dsh.current
      if (!agent || memoryBusy()) return false
      const context = sessions.context()
      if (!context.sessionId || !allowMemorySession(context.sessionId)
        || taskIds.some(id => staleMemorySession(id) || !canTransferMemoryToModel(id))) return false
      for (const taskId of taskIds) memoryDispatch?.inherit(taskId, context.sessionId)
      turn = { active: true, startedAt: Date.now() }
      emitToRenderer({ type: 'turn_started', by: 'task', context })
      agent.prompt(note).catch((err: Error) => {
        if (dsh.current !== agent || !sameContext(context, sessions.context())) return
        turn = { ...turn, active: false }
        emitToRenderer({ type: 'error', message: err.message, context })
      })
      return true
    },
  })
  /** What is still to be done outside (effects.ts): results of tasks to report, after a restart too. */
  let effects: Effects | null = null

  /** Where a report read is kept: in the conversation of the session it went to (report-records.ts). */
  const records = createReportRecords({
    history: () => historyDb ?? null,
    effects: () => effects,
    apply: applyChange,
    current: sessions.current,
    show: emitToRenderer,
  })
  /** Runs the effects due: after a change that queued one, and whenever the conversation may be free for them. */
  const wakeEffects = () => { void effects?.wake() }

  /** Only the app's selected provider credentials reach dsh; inherited endpoints remain isolated. */
  function dshSettings(config: Config) {
    return { DEEPSEEK_API_KEY: config.apiKey, ...providerEnv(modelStore.list()) }
  }

  const stopBridge = dsh.stop

  /** Nothing to start yet (no key, or dsh not installed): the window shows how to fix it. */
  const setupInfo = (config: Config) => ({ mode: 'setup', problem: config.problem ?? undefined, cwd: config.cwd, model: '', models: [], efforts: [], reason: '', conversationId: sessions.current().id, topicId: sessions.topicId() })
  const setupMessages = (): Readonly<Record<string, string>> => ({ 'no-key': t("main.main.enter.a.deepseek.api.key.or.add"), 'no-dsh': t("main.main.deepseek.harness.not.found.run.npm.install") })
  let SETUP_MESSAGES = setupMessages()

  function requireBridge() {
    if (!dsh.current) throw new Error(SETUP_MESSAGES[lastInfo.problem ?? ''] ?? t("main.main.the.assistant.is.not.connected.yet"))
    return dsh.current
  }

  async function startBridge(): Promise<AgentInfo | null> {
    if (dsh.isQuitting() || memoryBusy()) return null
    const config = currentConfig()
    if (config.problem) {
      const info = setupInfo(config)
      emitToRenderer({ type: 'ready', info })
      return info
    }
    fs.mkdirSync(config.cwd, { recursive: true })
    memoryWithdrawal.recover()
    const context = sessions.startingIn(config.cwd)
    if (staleMemorySession(context.resumeSessionId)) context.resumeSessionId = null
    try {
      const started = await dsh.start({ config, ...context })
      return started ? lastInfo : null
    } catch (err) {
      console.error('[main] failed to start agent bridge:', err)
      emitToRenderer({ type: 'error', message: t("main.main.could.not.connect.the.assistant", { message: err instanceof Error ? err.message : String(err) }) })
      return null
    }
  }

  /** New models for the same conversation: dsh restarts and resumes the session on screen. */
  async function restartKeepingConversation() {
    await stopBridge()
    return startBridge()
  }

  /** A new key (or none) means a different agent, so the conversation starts over. */
  async function restartWithNewConversation() {
    await stopBridge()
    sessions.reset()
    return startBridge()
  }

  /** Only the installed app may start with the computer: in development it would register Electron itself. */
  const canOpenAtLogin = () => host.packaged && !host.automation

  function settingsView() {
    const saved = settingsStore.getApiKey()
    const envKey = process.env.DEEPSEEK_API_KEY ?? ''
    const shellSettings = host.shellSettings()
    return {
      hasKey: Boolean(saved || envKey),
      keyHint: keyHint(saved || envKey),
      source: saved ? 'saved' : envKey ? 'env' : null,
      encryptionAvailable: host.secrets.isEncryptionAvailable(),
      deskIsland: preferences.get().deskIsland,
      shortcut: shellSettings.shortcut,
      images: imageStore.usage(),
      permission: permissionNow(),
      openAtLogin: { on: preferences.get().openAtLogin, available: canOpenAtLogin() && shellSettings.openAtLogin.available },
    }
  }

  /** 开机启动: off unless the user turns it on; started so, Viva stays in the tray. */
  function setOpenAtLogin(on: boolean) {
    if (!canOpenAtLogin()) throw new Error(t("main.main.start.at.login.is.available.only.in"))
    host.loginItem.set(on)
    preferences.set('openAtLogin', on)
  }

  /**
   * Another permission level: dsh starts again with it (viva-permission applies it to every session), on the
   * conversation on screen. Not while a turn runs, which the restart would cut short.
   */
  async function setPermission(level: string) {
    if (!PERMISSION_LEVELS.includes(level)) throw new Error(`invalid permission level: ${level}`)
    if (turn.active) throw new Error(t("main.main.wait.for.this.turn.to.finish.before"))
    preferences.set('permission', level)
    return { settings: settingsView(), info: await restartKeepingConversation() }
  }

  function registerAgentIpc() {
    ipcMain.handle('agent:info', () => lastInfo)
    // What the conversation on screen waits on the user for, for a window that opens on a dsh at work (a reload): said
    // on the live channel, so it comes in its place among the pushes (renderer waits-state.ts), not in the answer.
    ipcMain.handle('agent:waits', () => {
      if (sessions.isChanging()) return true
      const context = sessions.context()
      emitToRenderer({ type: 'waits', ...(dsh.current?.sessionWaits() ?? { permissions: [], questions: [], secrets: [] }), context })
      return true
    })
    ipcMain.handle('agent:prompt', (_event, text, images = [], operation, feedItemId) => {
      if (memoryBusy() || sessions.isChanging()) throw new Error(t("main.main.preparing.a.new.topic.please.wait"))
      // With pictures the words may be left out.
      const question = images?.length && text === '' ? '' : assertText(text, 'prompt', MAX_PROMPT_CHARS)
      const pictures = imagesForPrompt(imageStore, images)
      const agent = requireBridge()
      // Mid-switch a question would go to the session being left, and be cut off when that one closes. The window
      // keeps sending off while it switches; this holds for every other way in (the desktop island) too.
      if (agent.isSwitching()) throw new Error(switchingMessage())
      if (turn.active) throw new Error(t('main.main.wait.for.this.turn.to.finish.before'))
      return signal({ kind: 'chat.said', text: question, images: pictures, operation, feedItemId })
    })
    /** Words said while a turn runs go to that turn; 'idle' when it has just ended, so the window asks them anew. */
    ipcMain.handle('agent:steer', (_event, text, operation) => {
      const words = assertText(text, 'steer', MAX_PROMPT_CHARS)
      if (memoryBusy()) return { ok: false, reason: 'unavailable' }
      if (memory.forgetIntent(words, conversationMemoryScope()) !== null || memory.correctionIntent(words, conversationMemoryScope()) !== null) return { ok: false, reason: 'idle' }
      acceptMemory(words, operation ?? randomUUID())
      if (!turn.active) return { ok: false, reason: 'idle' }
      return requireBridge().steer(words)
    })
    ipcMain.handle('agent:cancel', () => dsh.current?.cancel())
    ipcMain.handle('agent:new-session', async () => {
      if (memoryBusy()) throw new Error(t('main.memory.change.pending'))
      const info = await sessions.newTopic()
      if (info.sessionId) memory.recordSession(info.sessionId)
      return info
    })
    ipcMain.handle('agent:set-config', async (_event, configId, value) => {
      if (!CONFIG_IDS.includes(configId)) throw new Error(`invalid config option: ${configId}`)
      const info = await requireBridge().setConfig(configId, assertText(value, 'config value', 200))
      lastInfo = { ...lastInfo, ...info }
      const picked = configId === 'model' ? parseModelValue(value) : null
      if (picked) modelStore.setLastModel(picked)
      return info
    })
    ipcMain.handle('agent:permission', (_event, requestId, optionId) => {
      const id = assertText(requestId, 'requestId', 200)
      const option = optionId === null ? null : assertText(optionId, 'optionId', 200)
      return dsh.current?.respondPermission(id, option) ?? false
    })
    ipcMain.handle('agent:answer', (_event, questionId, answers, operation) => {
      if (memoryBusy()) return false
      const id = assertText(questionId, 'questionId', 200)
      // Held first: dsh closes the question while it takes the answer, and what was asked goes with it.
      const keep = taskRuntime?.dsh.holdQuestion(id) ?? null
      const accepted = dsh.current?.answerQuestion(id, answers, operation) ?? false
      if (accepted) keep?.(answers)
      return accepted
    })
    // Keys the user typed for a server the model set up: straight to the encrypted store, never to dsh.
    ipcMain.handle('agent:secrets', (_event, requestId, values) => {
      const id = assertText(requestId, 'requestId', 200)
      if (values !== null && (typeof values !== 'object' || Array.isArray(values))) throw new Error('invalid secrets')
      return dsh.current?.provideSecrets(id, values) ?? false
    })
  }

  /** chat.said's route: the question goes to the conversation on screen. */
  async function sayInChat(question: string, pictures: ReturnType<typeof imagesForPrompt>, operation: string | string[] = randomUUID(), feedItemId?: string) {
    const agent = requireBridge()
    if (memoryBusy()) throw new Error(t('main.memory.change.pending'))
    const replay = Array.isArray(operation)
    const forget = feedItemId ? null : memory.forgetIntent(question, conversationMemoryScope())
    const correction = feedItemId ? null : memory.correctionIntent(question, conversationMemoryScope())
    if (forget !== null || correction !== null) {
      const key = typeof operation === 'string' ? operation : operation[0] ?? randomUUID()
      const context = sessions.context()
      if (forget) {
        await changingMemory(() => memory.forget(forget.id, forget.revision, 'forget', key))
        if (staleMemorySession(dsh.current?.currentSession())) await reopenMemorySession()
      }
      if (correction) await changingMemory(() => memory.editMemory(correction.entry.id, correction.text, correction.entry.revision, key))
      const text = t(forget ? 'main.memory.forgot' : correction ? 'main.memory.corrected' : 'main.memory.ambiguous')
      emitToRenderer({ type: 'update', context: sessions.context(), update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } })
      emitToRenderer({ type: 'turn_end', stopReason: 'end_turn', context: sessions.context() })
      memory.finishTurn(context.sessionId)
      return
    }
    if (replay && !memory.replaySources(operation, question)) throw new Error(t('main.memory.context.stale'))
    const id = agent.currentSession()
    if (staleMemorySession(id)) await reopenMemorySession()
    if (feedItemId) {
      if (replay) throw new Error(t('main.memory.context.stale'))
      const { item, memory: evidence } = feedContinuation(feedItemId)
      if (!matchesFeedContinuation(item, question)) throw new Error(t('main.feed.edit.continuation'))
      const origin = sessions.context()
      if (!origin.sessionId || (needsMemoryTransport(evidence) && !agent.memory.ready())) throw new Error(t('main.feed.memory.unavailable'))
      recordDeliveredSource(operation, origin, { derived: true })
      if (evidence) memoryDispatch?.attach(origin.sessionId, evidence)
    } else if (!replay) acceptMemory(question, operation)
    else for (const sourceId of operation) {
      const sessionId = agent.currentSession()
      memory.bindSource(sourceId, sessionId)
      if (sessionId) memoryDispatch?.recordSource(sessionId, sourceId)
    }
    turn = { active: true, startedAt: Date.now() }
    const carried = sessions.takeCarried()
    const words = carried ? `${carried}

${question}` : question
    const failed = (error: unknown) => {
      finishForegroundTurn()
      if (id !== agent.currentSession()) {
        emitToRenderer({ type: 'error', message: error instanceof Error ? error.message : String(error), context: sessions.context() })
        return
      }
      throw error
    }
    if (!feedItemId) return await agent.prompt(words, pictures, { userTurn: true }).catch(failed)
    return await new Promise<void>((resolve, reject) => {
      void agent.prompt(words, pictures, { userTurn: true, onStart: resolve }).then(() => {
        reject(new Error(t('main.memory.context.stale')))
      }, error => { finishForegroundTurn(); reject(error) })
    })
  }

  /** Where each kind of signal goes (event-core.ts Routes): a route for every kind, or the type check fails. */
  function routeSignals(events: EventCore) {
    events.route({
      'chat.said': ({ text, images, operation, feedItemId }) => sayInChat(text, images as ReturnType<typeof imagesForPrompt>, operation, feedItemId),
      // A turn of the user's just ended: clear the turn's source bindings.
      'agent.turn_ended': ({ stopReason }) => {
        finishForegroundTurn(stopReason === 'end_turn')
        if (mcpReloadDue) reloadMcpAfterTurn()
        // A task that ended while this turn ran comes back now that the conversation is free.
        wakeEffects()
      },
      // How a task's turn ended is kept (task-runtime.ts); its result goes back to the conversation; a gap follows.
      // How it ended is kept by the task runtime, tried again until it is; then onEnd (openHistory) reports it.
      // Recorded only: dsh's word went to the task runtime already (task-signals.ts), which keeps it.
      'agent.task_ended': () => undefined,
      'agent.task_waits': () => undefined,
      'system.woke': () => woke(),
      // Recorded only (and not even that: event-core.ts UNRECORDED).
      'window.foreground': () => undefined,
      // What the user did in a page: the channel's own listener (commands.ts), its answer the page's.
      'user.command': (input) => commands.route(input),
    })
  }

  function registerSettingsIpc() {
    ipcMain.handle('shell:open-link', (_event, url) => host.shell.openExternal(externalUrl(url)))
    ipcMain.handle('settings:get', () => settingsView())
    ipcMain.handle('settings:save-key', async (_event, key) => {
      settingsStore.saveApiKey(assertText(key, 'API key', MAX_KEY_CHARS))
      return { settings: settingsView(), info: await restartWithNewConversation() }
    })
    ipcMain.handle('settings:set-permission', (_event, level) => setPermission(level))
    ipcMain.handle('settings:set-open-at-login', (_event, on) => {
      setOpenAtLogin(on)
      return settingsView()
    })
    ipcMain.handle('settings:clear-key', async () => {
      settingsStore.clearApiKey()
      return { settings: settingsView(), info: await restartWithNewConversation() }
    })
  }

  /**
   * The user picked another working directory: the conversation goes on there, everything said so far with it
   * (a fork of the session into that directory), as a new segment of the timeline after the current one.
   */
  async function switchWorkDir(dir: string) {
    if (memoryBusy()) throw new Error(t('main.memory.change.pending'))
    const info = staleMemorySession(sessions.current().sessionId)
      ? await sessions.withSelection(async ({ switchAgent, select }) => {
        const previous = sessions.current(), topicId = sessions.topicId()
        const carried = filteredCarry(previous.id, true)
        const started = await switchAgent(null, dir)
        const next = historyDb.create({ sessionId: started.sessionId, mode: started.mode, model: started.model, cwd: started.cwd,
          parentId: historyDb.get(previous.id) ? previous.id : null, topicId })
        select(next)
        trackCarry(started.sessionId, carried.evidence)
        sessions.carryNext(next.id, carried.text)
        return { ...started, conversationId: next.id, topicId, remembersHistory: false }
      })
      : await sessions.switchDirectory(dir)
    if (info.sessionId) memory.recordSession(info.sessionId)
    emitToRenderer({ type: 'workdir', cwd: dir, info })
    return info
  }

  const chooseWorkFolder = () => host.dialogs.chooseFolder({ title: t("main.main.choose.working.directory"), createDirectory: true })
  const chooseExportPath = (defaultName: string) => host.dialogs.saveFile({
    title: t("main.main.export.conversation"), defaultPath: path.join(host.paths.documents, defaultName), filters: [{ name: 'Markdown', extensions: ['md'] }],
  })
  const chooseDshDir = () => host.dialogs.chooseFolder({ title: t("main.main.choose.the.dsh.folder.usually.named.dsh"), defaultPath: os.homedir(), showHidden: true })

  /** Reattaches the session with the current MCP servers; not while a turn runs (it would be cancelled). */
  async function applyMcpChange() {
    if (!dsh.current || turn.active) return null
    return sessions.withSelection(async selection => {
      const info = await selection.reloadAgent()
      // Publish the new runtime identity before the transition releases waiting reports.
      emitToRenderer({ type: 'config', info })
      return info
    })
  }

  /** 动态 changed: the window shows it, the tray counts what is new. */
  function feedChanged() {
    host.window.setPending(feed?.list().filter((item) => item.seenAt === null).length ?? 0)
    emitToRenderer({ type: 'feed_changed' })
  }

  function feedContinuation(id: string) {
    const continuation = requireFeed().continuation(id)
    if (!continuation || (continuation.memory && !memoryDispatch?.transferable(continuation.memory))) {
      throw new Error(t('main.feed.memory.stale'))
    }
    return continuation
  }

  /** A new item in 动态: its notification queued in the change that made it, so a quit before it goes loses nothing. */
  function queueFeedNotice(item: FeedItem) {
    if (!effects) throw new Error('the effects queue is not open yet')
    effects.queue(FEED_NOTICE, item.id, { title: item.title, body: item.body.slice(0, NOTICE_BODY_CHARS) })
  }

  /** A schedule's prompt run in its own folder; one whose folder is gone fails, saying so. */
  function runSchedule(prompt: string, cwd: string, evidence: MemoryProvenance | null): Promise<RunResult> {
    if (!isFolder(cwd)) return Promise.resolve({ ok: false, problem: t('main.schedule-runs.folder.gone', { cwd }) })
    if (memoryBusy()) return Promise.resolve({ ok: false, unavailable: true, problem: t('main.memory.change.pending') })
    const ready = () => dsh.current?.memory.ready() === true
    if (needsMemoryTransport(evidence) && !ready()) {
      return Promise.resolve({ ok: false, unavailable: true, memoryUnavailable: true, problem: t('main.feed.memory.unavailable') })
    }
    return unattended.run(prompt, cwd, (session, bridge) => {
      if (bridge !== dsh.current || (needsMemoryTransport(evidence) && !ready())) return 'memory-unavailable'
      if (evidence && !memoryDispatch?.transferable(evidence)) return 'stale'
      if (evidence) memoryDispatch?.attach(session, evidence)
    })
  }

  function registerPersonalIpc(config: Config) {
    registerRuntimeMemoryIpc(ipcMain, {
      runtime: memory, changingMemory,
      sourceLink: historyDb.sourceLink,
      habits: () => activeHours(historyDb.questionTimes()),
      cwd: () => config.cwd,
      chooseDocs: () => host.dialogs.chooseFiles({ title: t("main.main.choose.reference.documents"), multiple: true }),
    })
    registerModelsIpc(ipcMain, { store: modelStore, restart: restartKeepingConversation })
    // The 插件 section: dsh's plugin manager, inside the running dsh (viva-plugins); nothing to ask while it is down.
    registerPluginsIpc(ipcMain, {
      call: (op, args) => (dsh.current ? dsh.current.plugins(op, args) : Promise.resolve({ ok: false as const, problem: 'disconnected' })),
      profileDir: () => path.join(dshHomeOf(config), 'profiles', DSH_PROFILE),
      source: pluginSource,
      busy: () => turn.active,
      restart: restartKeepingConversation,
      specFit: (spec) => specFit({ spec, pnpm: pluginPnpm?.call ?? null, run: runPnpm }),
      // Only a company source is searched: the public registries are not a catalog of dsh plugins.
      catalog: (query) => searchCatalog({ query, pnpm: pluginPnpm?.registry ? pluginPnpm.call : null, run: runPnpm }),
    })
    const roots = () => skillRoots({ dshHome: dshHomeOf(config), cwd: workDirNow() ?? config.cwd })
    registerExtensionsIpc(ipcMain, {
      store: mcpStore,
      roots,
      mcpStatus: () => ({ ...personal.mcpStatus(lastInfo), memory: Boolean(dsh.current?.memory.ready()), plugins: pluginProblems }),
      applyMcp: applyMcpChange,
      trash: (file) => host.shell.trash(file),
      reveal: (file) => host.shell.showItemInFolder(file),
      dshDirs: () => ({ defaultDir: userDshHome(), lastDir: preferences.get().dshImportDir }),
      chooseDshDir,
      importDsh,
      rememberDshDir: (dir) => preferences.set('dshImportDir', dir),
    })
    registerSkillImportIpc(ipcMain, {
      roots,
      sources: () => skillSources({ home: os.homedir(), dshHome: userDshHome() }),
      chooseDir: () => host.dialogs.chooseFolder({ title: t('main.skill-import.choose'), defaultPath: os.homedir(), showHidden: true }),
    })
    registerMcpImportIpc(ipcMain, {
      store: mcpStore,
      sources: async () => mcpSources(await clientPlaces()),
      shell: loginShellTools,
      applyMcp: applyMcpChange,
    })
  }

  const memoryWithdrawal = createMemoryWithdrawal({
    history: () => historyDb, effects: () => effects!, memory: () => memory, apply: applyChange, changing: changingMemory,
  })

  function openPersonal(config: Config) {
    const store = openMemoryStore(path.join(userData, 'memory.db'))
    memoryDispatch = createMemoryDispatch(store, (items, at) => memory.dependenciesCurrent(items, at),
      (id, at) => memory.dispatchSourceCurrent(id, at), (items, sources, at) => memory.dispatchDeadline(items, sources, at))
    const embeddingRoot = path.extname(APP_ROOT) === '.asar'
      ? path.join(path.dirname(APP_ROOT), 'memory-embedding')
      : path.join(APP_ROOT, 'build', 'memory-embedding', 'prepared')
    memory = createMemoryRuntime({
      store,
      compute: (request, signal) => dsh.current?.memory.compute(request, signal) ?? null,
      route: () => parseModelValue(lastInfo.modelValue ?? '') ?? profileModels(currentConfig()).defaultModel,
      maintainSemanticIndex: true,
      embedder: createMemoryEmbedder({ modelRoot: path.join(embeddingRoot, 'model'), runtimeRoot: path.join(embeddingRoot, 'runtime') }),
      quiesce: () => dsh.stop(),
      canCommit: source => !memoryBusy()
        && (!turn.active || !source.session || source.session !== sessions.current().sessionId),
      validateDispatch: memoryDispatch.validateCommit,
      dependencies: memoryDispatch.record,
      provisionalRead: session => memoryDispatch?.recordTurnOnly(session),
      injected: (id, _turn, pushed) => {
        if (id === sessions.current().sessionId && pushed.length) emitToRenderer({
          type: 'memory_context', injected: [{ at: Date.now(), pushed }], context: sessions.context(),
        })
      },
      changed: ({ revision, ids, learned }) => {
        if (!memoryBusy()) dsh.current?.refreshMemoryQuestions()
        try { applyChange('memory.changed', { revision, ids }, () => undefined) }
        finally { emitToRenderer({ type: 'memory_changed', memories: learned ?? [] }) }
      },
    })
    memoryWithdrawal.recover()
    try {
      traceDb = openTraceDb({ file: path.join(userData, 'trace.db') })
    } catch (err: any) {
      console.error('[trace] could not open trace.db; reopened conversations fall back to dsh logs:', err.message)
    }
    mcpStore = createMcpConfigStore({ file: path.join(userData, 'mcp-servers.json'), crypto: host.secrets, onError: (err) => console.error('[mcp]', err.message) })
    personal = createPersonal({ historyDb, mcpStore })
    registerPersonalIpc(config)
    const schedulesChanged = () => emitToRenderer({ type: 'schedules_changed' })
    const scheduleMemoryCurrent = (evidence: MemoryProvenance) => Boolean(memoryDispatch?.transferable(evidence))
    schedules = createSchedules({ db: appDb.db, apply: applyChange, emit: event => emitToRenderer({ ...event, context: sessions.context() }),
      changed: () => { scheduleRuns?.wake(); schedulesChanged() }, memoryCurrent: scheduleMemoryCurrent })
    // A schedule's run adds its item inside its own change (schedule.ran); the window's writes are events of their own.
    const items = openFeedStore({ db: appDb.db })
    feed = journaled(items, 'feed', FEED_WRITES, applyChange)
    scheduleRuns = createScheduleRuns({
      db: appDb.db,
      apply: applyChange,
      store: schedules.store,
      feed: items,
      run: runSchedule,
      memoryCurrent: scheduleMemoryCurrent,
      keep: queueFeedNotice,
      // Kept: its notice goes (a notification, clicked, opens 动态), and the window shows it.
      delivered: () => {
        wakeEffects()
        feedChanged()
      },
      changed: schedulesChanged,
      onError: (err) => console.error('[schedules]', err instanceof Error ? err.message : String(err)),
    })
    ipcMain.handle('schedules:list', () => schedules?.list() ?? [])
    ipcMain.handle('schedules:accept', (_event, proposalId) => requireSchedules().accept(String(proposalId)))
    ipcMain.handle('schedules:decline', (_event, proposalId) => { requireSchedules().decline(String(proposalId)) })
    // 动态's 接下来: pause, resume and delete by hand too (the conversation does the rest).
    ipcMain.handle('schedules:pause', (_event, id, paused) => requireSchedules().update(String(id), { paused: Boolean(paused) }))
    ipcMain.handle('schedules:delete', (_event, id) => requireSchedules().remove(String(id)))
    ipcMain.handle('feed:list', () => items.list(FEED_LISTED))
    ipcMain.handle('feed:continue', (_event, id) => continueText(feedContinuation(id).item))
    ipcMain.handle('feed:seen', (_event, id) => {
      requireFeed().markSeen(String(id))
      feedChanged()
      return items.list(FEED_LISTED)
    })
    feedChanged()
  }

  /** The agent's side of background tasks. */
  const taskAgent = {
    closeTask: (taskId: string) => dsh.current?.closeTask(taskId),
    cancelTask: (taskId: string) => dsh.current?.cancelTask(taskId),
    steerTask: (taskId: string, text: string) => requireBridge().steerTask(taskId, text),
    resumeTask: (request: Parameters<Bridge['resumeTask']>[0]) => (dsh.current ? dsh.current.resumeTask(request) : { ok: false, reason: 'unavailable' }),
    async startTask() {
      const agent = dsh.current
      const source = agent?.currentSession()
      if (!agent || !source || sessions.isChanging() || !allowMemorySession(source)) return { ok: false, reason: 'unavailable' }
      return agent.startTask()
    },
    promptTask: (taskId: string, text: string) => dsh.current?.promptTask(taskId, text),
  }

  /** Opens the database and drops conversations whose undo window has passed. */
  function openHistory(config: Config) {
    historyDb = journaled(openHistoryDb({ db: appDb.db }), 'history', HISTORY_WRITES, applyChange)
    historyDb.purgeDeleted({ olderThanMs: 0 })
    sessions.open(config.cwd)
    registerHistoryIpc(ipcMain, {
      db: historyDb,
      dshHome: dshHomeOf(config),
      traceDb: () => traceDb,
      current: sessions.current,
      // A report waiting for this conversation (task-reports.ts) may go now.
      setCurrent: sessions.select,
      agentInfo: () => lastInfo,
      selectSession: sessions.withSelection,
      chooseExportPath,
      isBusy: () => turn.active || memoryBusy(),
      staleSession: staleMemorySession,
      filteredCarry,
      onCarry: trackCarry,
      recordSession: id => { if (id) memory?.recordSession(id) },
      deleteHistory: memoryWithdrawal.deleteHistory,
      folderExists: (dir) => isFolder(dir),
      workDir: () => workDirNow() ?? null,
      carryNext: sessions.carryNext,
    })
    registerRewindIpc(ipcMain, {
      db: historyDb,
      current: sessions.current,
      isBusy: () => turn.active || memoryBusy(),
      agentInfo: () => lastInfo,
      selectSession: sessions.withSelection,
      traceDb: () => traceDb,
      replaySource: (id, text) => memory.replaySource(id, text),
      derivedSource: id => memory.isDerivedDelivery(id),
      canEditSource: () => !dsh.current || dsh.current.memory.ready(),
      commitEdit: memoryWithdrawal.commitEdit,
      rebuild: (previous, kept, force) => {
        if (!force && !staleMemorySession(previous.sessionId) && memory.epoch() === 0) return null
        const evidence = kept.map(row => ({ ...row, segmentId: previous.id }))
          .filter(row => row.role === 'user' && Boolean(row.sourceId) && allowedModelHistory(row))
        return { ...carriedRecords(evidence), evidence }
      },
      onCarry: trackCarry,
      carryNext: sessions.carryNext,
      onContinuation: (previous, started) => {
        if (started.sessionId && staleMemorySession(previous.sessionId)) storeSessionCarry(previous.id)
      },
    })
    // Tasks still going, kept so the next launch can offer to take them up (dsh ends with the app). Only the task
    // runtime writes them, each change with its event (task.started, task.ended, …).
    taskStore = createTaskStore({ db: appDb.db, onError: (err) => console.error('[tasks]', err.message) })
    effects = createEffects({ db: appDb.db, apply: applyChange, onError: (err) => console.error('[effects]', err instanceof Error ? err.message : String(err)) })
    memoryWithdrawal.register()
    effects.runs(REPORT, taskReports)
    // A new item's notification (schedule-runs.ts): handed to the desktop, done.
    effects.runs(FEED_NOTICE, async (queued) => {
      for (const { payload } of queued) host.notify(payload as Notice)
      return new Map(queued.map((effect) => [effect.key, 'done' as const]))
    })
    taskRuntime = createTaskRuntime({
      db: historyDb,
      store: taskStore,
      current: sessions.current,
      agentInfo: () => lastInfo,
      agent: taskAgent,
      waitsOf: (taskId) => dsh.current?.taskWaits(taskId) ?? { permissions: [], questions: [] },
      apply: applyChange,
      publish: emitToRenderer,
      // Once a task's end is kept: its result back to the conversation.
      onEnd: () => wakeEffects(),
      effects,
    })
    registerTaskIpc(ipcMain, taskRuntime.window)
  }

  /** Opens the stores and registers the backend's channels, before the window loads. */
  function open() {
    appDb = openAppDb({ file: path.join(userData, 'app.db') })
    core = createEventCore({ app: appDb, publish: host.window.send })
    settingsStore = createSettingsStore({
      file: path.join(userData, 'settings.json'), crypto: host.secrets,
      onError: (err) => console.error('[settings] could not read saved settings:', err.message),
    })
    pluginSource = createPluginSourceStore({
      file: path.join(userData, 'plugin-source.json'), crypto: host.secrets,
      onError: (err) => console.error('[plugins] could not read the plugin source:', err.message),
    })
    preferences = createPreferences({
      file: path.join(userData, 'preferences.json'),
      onError: (err) => console.error('[preferences] could not read them, using the defaults:', err.message),
    })
    registerLanguageIpc(ipcMain, {
      getLanguage: () => preferences.get().language,
      saveLanguage: (language) => { preferences.set('language', language) },
      systemLocale: host.locale,
      refreshNative: host.window.refreshNative,
      broadcast: host.window.broadcastLanguage,
    })
    modelStore = createModelStore({
      file: path.join(userData, 'models.json'), crypto: host.secrets,
      onError: (err) => console.error('[models] could not read the model providers:', err.message),
    })
    imageStore = createImageStore({ dir: imagesDir })
    registerImageIpc(ipcMain, {
      store: imageStore,
      setDir: (dir) => preferences.set('imagesDir', dir),
      chooseFolder: () => host.dialogs.chooseFolder({ title: t("main.main.where.should.images.be.stored"), createDirectory: true }),
      reveal: (dir) => host.shell.openPath(dir),
      isBusy: () => turn.active,
      restart: restartKeepingConversation,
    })
    registerAgentIpc()
    registerSettingsIpc()
    const config = currentConfig()
    // Set just above, so the folder in use is always one from here on.
    const workDirInUse = () => workDirNow() ?? config.cwd
    registerFilesIpc(ipcMain, { root: workDirInUse, shell: host.shell, notify: emitToRenderer })
    registerWorkDirIpc(ipcMain, {
      current: workDirInUse,
      defaultDir: config.cwd,
      preferences,
      chooseFolder: chooseWorkFolder,
      isBusy: () => turn.active,
      switchTo: switchWorkDir,
      reveal: (dir) => host.shell.openPath(dir),
    })
    openHistory(config)
    openPersonal(config)
    routeSignals(core)
  }

  /** The computer back from sleep, or unlocked: schedules due meanwhile run. */
  function woke() {
    scheduleRuns?.wake()
  }

  function close() {
    scheduleRuns?.close()
    historyDb?.close()
    appDb?.close()
    memory?.close()
    effects?.close()
    traceDb?.close()
  }

  onLocaleChange(() => {
    SETUP_MESSAGES = setupMessages()
  })

  return {
    open,
    startBridge,
    /** One input from the shell (the window came to the front, the computer woke): recorded, then routed. */
    signal,
    /** The stored events after `seq`, for a shell that missed them (event-core.ts). */
    since: (seq: number) => core?.since(seq) ?? [],
    settingsView,
    preferences: () => preferences,
    images: () => imageStore,
    /** An item in 动态, as if a schedule brought it (server.ts seedFeed, automation only). */
    seedFeed: ({ title, body }: { title: string, body: string }) => {
      const added = requireFeed().add({ source: 'automation', key: crypto.randomUUID(), title, body, origin: { label: t('main.schedule-runs.origin') } })
      if (added.made) feedChanged()
    },
    agentPid: () => dsh.current?.pid() ?? null,
    hasBridge: () => Boolean(dsh.current),
    isQuitting: dsh.isQuitting,
    /** Quitting has begun (or the session ends): dsh must not be started again. */
    markQuitting: dsh.markQuitting,
    /** Stops dsh, waiting at most a few seconds; the real release remains a barrier. */
    stop: dsh.stopWithin,
    close,
  }
}

export type Backend = ReturnType<typeof createBackend>

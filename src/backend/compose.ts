import { createDshLifecycle, type DshLifetime } from './dsh-lifecycle.ts'
import { createConversationSession } from './conversation-session.ts'
import { createForegroundRequests, ForegroundRequestRetired } from './foreground-requests.ts'
import { sameContext } from '../shared/conversation-context.ts'
import { objectOf } from '../shared/unknown-value.ts'
import type { IpcResults } from '../shared/ipc-results.ts'
import { createConfigActions } from './config-actions.ts'
import { createSchedules, type Schedules } from './schedules.ts'
import { createScheduleRuns, type ScheduleRuns } from './schedule-runs.ts'
import { createUnattendedRuns, type RunResult, type TaskEvent } from './unattended-runs.ts'
import { FEED_WRITES, openFeedStore, type FeedItem, type FeedStore } from './feed-store.ts'
import { continueText } from '../shared/feed-continuation.ts'
import { admitFeedContinuation } from './feed-continuation.ts'
import { onLocaleChange } from '../shared/i18n/locale.ts'
import { t } from '../shared/i18n/translate.ts'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MAX_MESSAGE_CHARS as MAX_PROMPT_CHARS } from '../shared/text-limits.ts'
import { createHash, randomUUID } from 'node:crypto'
import { createMemoryHostClient } from './memory-host-client.ts'
import { MemoryOwnerUnavailable } from './remote-memory-channel.ts'
import type { MemoryScope } from '../memory/contracts/memory-contract.ts'
import { foregroundMemoryScope, memoryProjectScope } from './memory-project.ts'
import { createMemoryHostRecovery } from './memory-host-recovery.ts'
import { affectedTraceSessions, createMemoryHostEffects } from './memory-host-effects.ts'
import { createMemoryWithdrawal } from './memory-withdrawal.ts'
import type { MemoryProvenance } from '../memory/contracts/records.ts'
import { intersectsMemoryErasure, memoryErasureEvidence, type MemoryErasureEvidence } from '../memory/contracts/provenance.ts'
import type { CommittedOutput } from './assistant-stream.ts'
import { registerRuntimeMemoryIpc } from './memory-ipc.ts'
import { verifiedHistoryCarry, publishHistoryCarry, type HistoryCarry } from './history-carry.ts'
import { activeHours } from './habits.ts'
import { openTraceDb, traceStepDigest } from '../../plugins/trace/lib/store.ts'
import { stepsFrom } from '../../plugins/trace/lib/steps.ts'
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
import { openHistoryDb, type Conversation } from './history-db.ts'
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
import type { ScheduleAction } from './tasks-channel.ts'
import { createRequestStore } from './request-store.ts'
import { createRequestRuntime, type RequestPlace, type RequestRuntime } from './request-runtime.ts'
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
import { historyRecallAsync } from './history-recall.ts'
import type { HistoryEvidence } from './history-recall.ts'
import { openAppDb, type AppDb } from './app-db.ts'
import { createEventCore, type EventCore, type Signal } from './event-core.ts'
import { createRendererStream } from './renderer-stream.ts'
import type { RendererSnapshot } from '../shared/renderer-sync.ts'
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
const HISTORY_WRITES = Object.freeze(['save', 'addRecord', 'moveRecords', 'rename', 'setPinned', 'softDelete', 'restore', 'purgeDeleted', 'fold', 'unfold', 'setStar', 'reservePromptDelivery', 'settlePromptDelivery'] as const)

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

export function createBackend({ host, ipc, dailyNotes = process.env.VIVA_DAILY_MEMORY !== '0' }: {
  host: HostCapabilities, ipc: IpcRegistry, dailyNotes?: boolean
}) {
  const userData = host.paths.userData
  // What the user does in a page is a signal first (commands.ts); every channel below is registered through this.
  const commands = commandIpc(ipc, (input) => signal(input))
  const ipcMain = commands.ipc
  // The stores and databases are opened once at launch (open, openHistory, openPersonal), before any window or
  // handler can reach them: `!` says so. What may be absent at any time says `| null`.
  /** The backend's database and its event core (app-db.ts, event-core.ts), opened first. */
  let appDb!: AppDb
  let core: EventCore | null = null
  const rendererStream = createRendererStream(host.window.send)
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
  /** Authenticated client of the plugin owner; Viva owns no memory storage or domain runtime. */
  const memory = createMemoryHostClient((method, input) => {
    const bridge = dsh.current
    if (!bridge) return Promise.reject(new MemoryOwnerUnavailable())
    return bridge.memory.call(method, input)
  }, () => dsh.current?.memory.state(), (work, options) => {
    const bridge = dsh.current
    if (!bridge) return Promise.reject(new MemoryOwnerUnavailable())
    return bridge.memory.readBatch(work, options)
  })
  const memoryCoordination = memory
  /** What the trace plugin recorded, for the 过程 of reopened conversations; null if it can't be opened. */
  let traceDb: ReturnType<typeof openTraceDb> | null = null
  /** Background tasks still going or ended lately (task-store.ts); follow-ups look at it to not prepare what a task does. */
  let taskStore: ReturnType<typeof createTaskStore> | null = null
  /** The background tasks, their one writer (task-runtime.ts); set once the history is open. */
  let taskRuntime: TaskRuntime | null = null
  const taskAnswerSources = new Map<string, Record<string, string>>()
  const historyPurgeTimers = new Set<ReturnType<typeof setTimeout>>()
  /** The main conversation's requests and their decisions (request-runtime.ts); set once the history is open. */
  let requests!: RequestRuntime
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
  const foregroundRequests = createForegroundRequests()
  const pendingHumanPrompts = new Map<string, { fingerprint: string, sources: readonly string[], started(): boolean, promise: Promise<IpcResults['agent:prompt']> }>()
  let closed = false
  const knownUnsentPrompts = new Set<string>()
  let humanAdmission: { started: boolean, completed: Promise<void>[], delivered(): void, current(): boolean, recovered(): void } | null = null
  function retireForegroundRequests() {
    try {
      if (!closed) knownUnsentPrompts.clear()
      if (!closed) for (const pending of pendingHumanPrompts.values()) if (!pending.started()) {
        historyDb?.settlePromptDelivery(pending.sources, false)
        for (const id of historyDb?.promptUndelivered(pending.sources) ?? []) knownUnsentPrompts.add(id)
      }
    } catch (error) {
      // A failed receipt stays pending. It cannot prevent cancellation or release.
      console.error('[prompts] could not persist delivery retirement:', error instanceof Error ? error.message : String(error))
    } finally { foregroundRequests.invalidate() }
  }
  let lastInfo: AgentInfo = { mode: 'connecting', model: '', cwd: '', reason: '' }
  const sessions = createConversationSession({
    history: () => historyDb,
    agent: () => dsh.current,
    info: () => lastInfo,
    setInfo: (info) => { lastInfo = info },
    isBusy: () => turn.active,
    carryRevision: () => historyDb.fileErasureRevision(),
    folderExists: isFolder,
    selectedModel: () => { const last = modelStore.lastModel(); return last ? modelValue(last) : null },
    changed: () => {
      wakeEffects()
      syncProjectView()
    },
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

  /** Scheduled runs have their own events, separate from background tasks. */
  const unattended = createUnattendedRuns({ agent: () => dsh.current, provenance: taskId => memory.provenance(taskId) })

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

  const currentMemoryProject = () => memoryProjectScope(workDirNow())
  async function projectOfSession(session: string | undefined) {
    const id = session ? await memory.sessionProject(session) : undefined
    return id ? { kind: 'project' as const, id } : undefined
  }
  const bindSessionProject = memoryCoordination.bindProject
  const sessionProjectChanged = memoryCoordination.projectChanged
  let displayedProject: string | undefined
  function syncProjectView() {
    if (!memory || sessions.isChanging()) return
    const project = currentMemoryProject()
    if (displayedProject !== project?.id) {
      displayedProject = project?.id
      emitToRenderer({ type: 'memory_changed' })
    }
  }
  const mayUseProjectEvidence = memoryCoordination.allowsEvidence

  type DshContext = { config: Config, cwd: string, resumeSessionId: string | null }
  const dsh = createDshLifecycle({
    beforeStart: async ({ config }: DshContext, isCold) => {
      const memoryRoot = path.join(userData, 'memory')
      if (!fs.existsSync(path.join(memoryRoot, 'memory.db'))) return
      const { eraseColdNativeCopies, PendingNativePublication } = await import('../../plugins/memory/lib/native/maintenance.ts')
      const root = dshHomeOf(config)
      try {
        await eraseColdNativeCopies({ memoryRoot, sessionsRoot: path.join(root, 'sessions'), storageRoot: path.join(root, 'storages'),
          hostNamespace: 'viva', isCold, trace: {
            key(event) {
              const step = stepsFrom([event])[0]
              return step ? traceStepDigest(step) : undefined
            },
            erase(session, positions) {
              const file = path.join(userData, 'trace.db')
              if (!traceDb && fs.existsSync(file)) traceDb = openTraceDb({ file })
              if (traceDb && !traceDb.eraseSteps(session, positions)) throw new Error('Trace erasure awaits a durable checkpoint')
            },
          } })
      }
      catch (error) {
        if (error instanceof PendingNativePublication) throw error
        console.warn('[memory] Native session cleanup remains pending')
      }
    },
    create: ({ config, cwd }: DshContext, lifetime) => {
      return createBridge(config, cwd, lifetime)
    },
    connect: (instance: Bridge, context: DshContext) => instance.start({ resumeSessionId: context.resumeSessionId }),
    onReady: async (started, context) => {
      const old = sessions.current()
      const project = memoryProjectScope(context.cwd)
      const sameProject = !await sessionProjectChanged(old.sessionId, project) && memoryProjectScope(old.cwd)?.id === project?.id
      const rebuild = sameProject && await staleMemorySession(old.sessionId)
      const info = sessions.ready(started, context.cwd)
      if (!sameProject) sessions.select(historyDb.create({ sessionId: started.sessionId, mode: started.mode, model: started.model, cwd: context.cwd }))
      if (started.sessionId) {
        await memory.recordSession(started.sessionId)
        await bindSessionProject(started.sessionId, project)
      }
      if (sameProject && (rebuild || (!started.resumed && memory?.epoch() > 0 && historyDb.get(old.id)))) await storeSessionCarry(old.id)
      emitToRenderer({ type: 'ready', info: sameProject ? info : { ...info, conversationId: sessions.current().id, topicId: sessions.topicId(), remembersHistory: false } })
      wakeEffects()
      syncProjectView()
      scheduleRuns?.wake()
    },
    onGone: () => {
      retireForegroundRequests()
      taskRuntime?.dsh.gone(); unattended.gone()
      // Retired generations cannot deliver a final error/turn_end. Settle the foreground here too,
      // including deliberate model/key restarts, before publishing the replacement's readiness.
      if (turn.active) {
        emitToRenderer({ type: 'turn_end', stopReason: 'cancelled', context: sessions.context() })
        finishForegroundTurn()
      }
      // Its requests too: the retired generation's turn_end never reaches endRequests.
      const left = sessions.context().sessionId
      if (left) endRequests({ type: 'turn_end', stopReason: 'cancelled' }, left)
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

  function finishForegroundTurn(completed = false, noteCompleted = completed) {
    if (!turn.active) return
    turn = { ...turn, active: false }
  }

  const memoryBusy = memoryCoordination.busy
  const memoryProjectFor = async (id: string | null | undefined, cwd?: string) => cwd === undefined ? await projectOfSession(id ?? undefined) : memoryProjectScope(cwd)
  const staleMemorySession = async (id: string | null | undefined, cwd?: string) => memoryCoordination.stale(id, await memoryProjectFor(id, cwd))

  function readNativeTrace<T>(sessions: readonly string[], read: (visible: readonly string[]) => T | Promise<T>) {
    return dsh.readNative(async () => {
      if (!sessions.length) return read(sessions)
      const bridge = dsh.current
      async function visible() {
        if (!bridge?.memory.ready() || bridge !== dsh.current || memoryBusy()) return []
        try {
          const effects = await memory.call('pendingHostEffects', {})
          if (bridge !== dsh.current || !bridge.memory.ready() || memoryBusy()) return []
          const hidden = new Set(effects.flatMap(affectedTraceSessions))
          return sessions.filter(session => !hidden.has(session))
        } catch { return [] }
      }
      const permitted = await visible()
      const result = await read(permitted)
      const stillPermitted = new Set(await visible())
      return permitted.every(session => stillPermitted.has(session)) ? result : read([])
    })
  }
  const allowMemorySession = async (id: string, cwd?: string) => memoryCoordination.allowsSession(id, await memoryProjectFor(id, cwd))
  const canTransferMemoryToModel = (_id: string) => Boolean(dsh.current?.memory.ready())
  function historyForProject(project: ReturnType<typeof memoryProjectScope>) {
    const bySegment = new Map<string, string | undefined>()
    return async (row: HistoryEvidence) => {
      if (!historyDb.promptDeliverable(row.sourceId)) return false
      if (!bySegment.has(row.segmentId)) {
        const location = historyDb.workspaceOf(row.segmentId)
        const saved = location?.sessionId ? await memory.sessionProject(location.sessionId) : undefined
        bySegment.set(row.segmentId, saved === undefined ? memoryProjectScope(location?.cwd)?.id : saved || undefined)
      }
      const sourceProject = bySegment.get(row.segmentId)
      const allowed = await memoryCoordination.allowsProjectHistory(row, sourceProject ? { kind: 'project', id: sourceProject } : undefined, project, await projectOfSession(row.sessionId ?? undefined))
      return allowed && historyDb.promptDeliverable(row.sourceId)
    }
  }
  const usedHistory = memoryCoordination.useHistory
  async function publishCarry(target: Conversation, carry: HistoryCarry) {
    const current = () => Boolean(target.sessionId) && carry.revision === historyDb.fileErasureRevision()
      && sessions.current().id === target.id && sessions.current().sessionId === target.sessionId
    return publishHistoryCarry(carry, current, row => usedHistory(target.sessionId ?? undefined, row),
      () => sessions.carryNext(target.id, carry.text))
  }
  async function storeSessionCarry(id: string) {
    const target = sessions.current()
    const carry = await filteredCarry(id, true, workDirNow() ?? undefined)
    await publishCarry(target, carry)
  }
  async function reopenMemorySession() {
    const started = await sessions.withSelection(async ({ switchAgent, select }) => {
      const previous = sessions.current()
      const started = await switchAgent(null, previous.cwd)
      select({ ...previous, sessionId: started.sessionId, cwd: started.cwd ?? previous.cwd })
      await storeSessionCarry(previous.id)
      return started
    })
    emitToRenderer({ type: 'ready', info: { ...started, conversationId: sessions.current().id, topicId: sessions.topicId(), remembersHistory: false } })
  }
  async function filteredCarry(conversationId: string, userOnly = false, targetCwd?: string) {
    const revision = historyDb.fileErasureRevision()
    const topic = historyDb.topicOf(conversationId)
    const part = historyDb.read(userOnly || !topic ? `s:${conversationId}` : `t:${topic}`, { from: Number.MAX_SAFE_INTEGER, count: 40 })
    const sourceProject = memoryProjectScope(historyDb.workspaceOf(conversationId)?.cwd)
    const project = targetCwd === undefined ? sourceProject : memoryProjectScope(targetCwd)
    const rows = sourceProject?.id === project?.id ? part?.messages.filter(row => !userOnly || row.role === 'user') ?? [] : []
    return verifiedHistoryCarry(rows, historyForProject(project), revision, historyDb.fileErasureRevision)
  }

  async function changingMemory<T>(work: () => T | Promise<T>, { duringSelection = false } = {}): Promise<T> {
    if (memoryBusy() || (!duringSelection && sessions.isChanging())) throw new Error(t('main.memory.change.pending'))
    try { return await work() }
    finally { dsh.current?.refreshMemoryQuestions(); scheduleRuns?.wake() }
  }

  async function recordDeliveredSource(sourceId: string, origin = sessions.context(), { derived = false } = {}) {
    if (!origin.conversationId || !origin.sessionId) throw new Error(t('main.memory.receipt.failed'))
    await memory.recordDeliveredSource(sourceId, origin.conversationId, derived, origin.sessionId)
  }

  async function aliasMemory(text: string, operation: string, origin = sessions.context()) {
    const project = await projectOfSession(origin.sessionId ?? undefined)
    if (!origin.sessionId || !origin.conversationId) throw new Error(t('main.memory.receipt.failed'))
    if (!await bindSessionProject(origin.sessionId, project)) throw new Error(t('main.memory.context.stale'))
    const context = foregroundMemoryScope(project)
    const result = await memory.call('sourceAlias', { operationId: operation, sourceId: operation,
      session: origin.sessionId, conversation: origin.conversationId, text, context, project })
    return result.sourceId
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
      const embeddingRoot = path.extname(APP_ROOT) === '.asar' ? path.join(path.dirname(APP_ROOT), 'memory-embedding') : path.join(APP_ROOT, 'build', 'memory-embedding', 'prepared')
      const { plugins, problems } = resolvePlugins({ codeRoot: CODE_ROOT, userData, dshVersion: installedDshVersion(APP_ROOT), permission: permissionNow(),
        memory: { modelRoot: path.join(embeddingRoot, 'model'), runtimeRoot: path.join(embeddingRoot, 'runtime'), dailyNotes } })
      pluginProblems = problems
      problems.forEach(({ name, problem }) => console.error(`[plugins] ${name} left out: ${problem}`))
      pnpmCommand = pnpmLauncher({ dir: path.join(userData, 'bin'), appRoot: APP_ROOT, runtime: config.runtime })
      const dir = ensureDshProfile({
        dshHome: dshHomeOf(config), profile: DSH_PROFILE, plugins, persona: PERSONA, models: profileModels(config), imagesDir: imagesDir(), pnpmCommand, registry,
        webSearch: webSearchNow(),
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
      // viva-mcp takes the change at once, even mid-turn: no session is reopened for it.
      onMcpChange: () => { void applyMcpChange() }, importDsh,
      rememberDshDir: (dir) => preferences.set('dshImportDir', dir), trash: (file) => host.shell.trash(file),
    })
  }

  let memoryHostEffects: ReturnType<typeof createMemoryHostEffects> | undefined
  const memoryHostRecovery = createMemoryHostRecovery({
    state: () => dsh.current?.memory.state(),
    recover: async () => { await memoryWithdrawal.recover(); await memoryHostEffects?.recover() },
    onError: error => console.error('[memory] recovery pending', error),
  })
  const recoverMemoryHost = () => { void memoryHostRecovery.notify() }

  /** Events from a replaced bridge are dropped so a restart can't leak into the new conversation. */
  function createBridge(config: Config, cwd: string, lifetime: DshLifetime): Bridge {
    return createAcpBridge({
      prewarmSessions: true, memoryRequired: true,
      dshBin: config.dshBin,
      nodeBin: config.nodeBin,
      ...prepareProfile(config),
      cwd,
      env: dshEnv({ base: process.env, dshHome: dshHomeOf(config), runtime: config.runtime, settings: dshSettings(config) }),
      mcpServers: () => personal.mcpServers(),
      configActions: configActions(config),
      allowSession: async (id, _transportReady, _isTask, targetCwd) => memory.allowsSession(id, await memoryProjectFor(id, targetCwd)),
      onSessionCreated: async (id, targetCwd, parent) => {
        await memory.recordSession(id)
        if (parent && !await memory.call('inheritFork', { args: [parent, id, await projectOfSession(parent), memoryProjectScope(targetCwd), true] })) throw new Error(t('main.memory.context.stale'))
        if (!await bindSessionProject(id, memoryProjectScope(targetCwd))) throw new Error(t('main.memory.context.stale'))
      },
      taskSourceAlias: async (session, text) => {
        const operationId = randomUUID()
        const source = await memory.call('sourceAlias', { operationId, sourceId: operationId, session, text, origin: 'derived',
          conversation: historyDb.bySession(session)?.id ?? session, context: { kind: 'task', id: session },
          project: await projectOfSession(session), dependencies: await memory.provenance(session) })
        return source.sourceId
      },
      recordOutputs: async (session, outputs) => {
        const candidates: Array<{ output: CommittedOutput, proof: readonly MemoryErasureEvidence[] }> = []
        try {
          for (const output of outputs) {
            if (!output.blocks.length || !lifetime.isCurrent()) continue
            const request = output.requestId ? requests.outputEvidence(output.requestId, session) : null
            const proof = output.native ? await memory.call('nativeOutputEvidence', { session, ...output.native })
              : request ? [memoryErasureEvidence(request)] : null
            if (proof) candidates.push({ output, proof })
          }
          // Owner publication can precede the host transaction that installs its local erasure ranges.
          const effects = (await memory.call('pendingHostEffects', {})).filter(effect => effect.kind === 'erase-file-copies')
          if (!lifetime.isCurrent()) return []
          const accepted = candidates.filter(({ output, proof }) =>
            !effects.some(effect => proof.some(item => intersectsMemoryErasure(item, effect.ranges)))
            && historyDb.bindGeneratedCopy(session, output.key, 'assistant',
              output.blocks.filter(block => block.type === 'text').map(block => block.text).join(''), proof))
          const kept = new Set(accepted.map(({ output }) => output.key))
          return outputs.filter(output => !output.blocks.length || kept.has(output.key))
        } catch (error) {
          console.warn('[memory] Could not authenticate generated output:', error instanceof Error ? error.message : 'unknown error')
          return []
        }
      },
      readyMemory: () => { scheduleRuns?.wake() },
      memoryStateChanged: () => { recoverMemoryHost(); emitToRenderer({ type: 'memory_changed' }) },
      memoryNotice: notice => {
        if (!memoryBusy()) void dsh.current?.refreshMemoryQuestions()
        try { applyChange('memory.changed', { revision: notice.revision }, () => undefined) }
        finally { emitToRenderer({ type: 'memory_changed' }) }
      },
      memoryProjection: () => emitToRenderer({ type: 'memory_changed' }),
      memoryContextUsed: notice => {
        const context = sessions.context()
        if (notice.session === context.sessionId && notice.conversation === context.conversationId && notice.pushed.length) {
          emitToRenderer({ type: 'memory_context', injected: [{ at: notice.at, pushed: notice.pushed }], context })
        }
      },
      memoryClarificationQuestion: (session, turn, id, phase) => memory.call('clarificationQuestion', { args: [session, turn, id, phase] }),
      cancelMemoryClarification: (session, id) => memory.call('cancelFileClarification', { args: [session, id] }),
      allowGeneralQuestion: async (session, turn, cards, _waiting, phase) => turn ? memory.call('authorizeGeneralQuestion', { args: [session, turn, cards,
        session === sessions.current().sessionId ? sessions.current().id : historyDb.bySession(session)?.id ?? session,
        session === sessions.current().sessionId ? foregroundMemoryScope(currentMemoryProject()) : { kind: 'task', id: session }, await projectOfSession(session), phase] }) : false,
      onQuestionAnswer: async (entry, answers, operation) => {
        if (memoryBusy()) throw new Error(t('main.memory.change.pending'))
        const conversation = entry.taskId ? historyDb.bySession(entry.sessionId)?.id : entry.context?.conversationId
        if (!conversation) return
        const project = await projectOfSession(entry.sessionId)
        const answerContext: MemoryScope = entry.taskId ? { kind: 'task', id: entry.sessionId } : foregroundMemoryScope(project)
        const answerSources = Object.create(null) as Record<string, string>
        const requestOperation = operation ?? randomUUID()
        for (const answer of answers) {
          const text = answer.custom?.trim(), question = entry.question.questions.find(card => card.id === answer.id)
          if (!text || !question) continue
          const digest = createHash('sha256').update(JSON.stringify([requestOperation, answer.id])).digest('hex')
          const operationId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`
          const accepted = await memory.call('acceptQuestionAnswer', { operationId, text, session: entry.sessionId,
            conversation, question: entry.sourceQuestion ?? question.question, requestId: entry.question.id, questionId: answer.id,
            context: answerContext, project })
          answerSources[answer.id] = accepted.sourceId
        }
        if (entry.taskId) taskAnswerSources.set(entry.question.id, answerSources)
        return { sourceIds: answerSources }
      },
      historySearch: async (query, range, session) => (!memoryBusy() && dsh.current?.memory.ready() && historyDb
        ? historyRecallAsync(historyDb, historyForProject(await projectOfSession(session)), row => usedHistory(session, row)).search(query, range) : []),
      historyRead: async (ref, around, session) => (!memoryBusy() && dsh.current?.memory.ready() && historyDb
        ? historyRecallAsync(historyDb, historyForProject(await projectOfSession(session)), row => usedHistory(session, row)).read(ref, around) : { status: 'deleted' as const }),
      taskRead: async (request, sessionId) => {
        if (memoryBusy() || (request.op === 'get' && await staleMemorySession(request.taskId))) throw new Error(t('main.memory.context.stale'))
        const result = requireTasks().agent.query(request, sessionId === lastInfo.sessionId ? { cwd: workDirNow() ?? '' } : { taskId: sessionId })
        if (request.op === 'get' && request.taskId) {
          if (!await memoryCoordination.inherit(request.taskId, sessionId, await projectOfSession(request.taskId), await projectOfSession(sessionId), Boolean(dsh.current?.memory.ready()))) throw new Error(t('main.memory.context.stale'))
        }
        if ('tasks' in result && result.tasks) {
          const tasks = []
          for (const task of result.tasks) if (!task.taskId || await memoryCoordination.inherit(task.taskId, sessionId, await projectOfSession(task.taskId), await projectOfSession(sessionId), Boolean(dsh.current?.memory.ready()))) tasks.push(task)
          return { ...result, tasks }
        }
        return result
      },
      taskAct: (request, sessionId) => actOnSchedule(request, sessionId),
      routing: {
        receive: request => requests.receive(request),
        async decide(decision) {
          const bridge = dsh.current
          if (bridge && decision.sessionId === sessions.current().sessionId) {
            const evidence = await bridge.memory.call('authorizedProvenance', {
              session: decision.sessionId, sourceId: requests.source(decision.requestId, decision.sessionId),
            })
            if (evidence && bridge === dsh.current && decision.sessionId === sessions.current().sessionId) {
              return requests.decide(decision, evidence)
            }
          }
          return { accepted: false, reason: t('main.memory.context.stale') }
        },
        fail: failure => requests.fail(failure), noteFast: outcome => requests.noteFast(outcome), endTurn: turn => requests.endTurn(turn),
      },
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
        // How the MCP servers stand (viva-mcp): kept with the agent's info, for the settings page and the window.
        if (event.type === 'mcp_status') {
          lastInfo = { ...lastInfo, mcp: event.mcp as AgentInfo['mcp'] }
          emitToRenderer({ type: 'mcp_status', mcp: event.mcp })
          return undefined
        }
        // A task's turn ending, or its waiting on the user beginning or ending, is a signal; what it says streams. Each
        // reaches the window from the task runtime, in order with the task's snapshots (task-runtime.ts), not from here.
        const { taskId } = event
        if (typeof taskId === 'string' && unattended.owns(taskId)) return unattended.receive({ ...event, taskId } satisfies TaskEvent)
        const task = taskEventOf(event)
        if (task) return taskSignals.report(task)
        emitToRenderer(event)
        if (event.type === 'turn_end' || event.type === 'error') endRequests(event)
        if (event.type === 'turn_end') return signal({ kind: 'agent.turn_ended', stopReason: typeof event.stopReason === 'string' ? event.stopReason : undefined })
        if (event.type === 'error') finishForegroundTurn()
        return undefined
      },
      onExit: lifetime.onExit,
    })
  }

  /** The agent of the conversation on screen changing schedules (viva-tasks); a task's own session may not. */
  async function actOnSchedule(request: ScheduleAction, sessionId: string) {
    if (sessionId !== lastInfo.sessionId) throw new Error(t('main.tasks-channel.not.from.a.task'))
    const erasureRevision = historyDb.fileErasureRevision()
    const caller = sessions.context()
    const bridge = dsh.current
    if (!await allowMemorySession(sessionId)) throw new Error(t('main.memory.context.stale'))
    const evidence = await memory.provenance(sessionId)
    if (!schedules) throw new Error(t('main.tasks-channel.task.queries.are.not.enabled.in.this'))
    const memoryReady = dsh.current?.memory.ready()
    const project = currentMemoryProject()
    const sameWorkspace = async (schedule: { cwd: string, memory: MemoryProvenance | null }) =>
      memoryProjectScope(schedule.cwd)?.id === project?.id && await mayUseProjectEvidence(schedule.memory, project)
    if (request.op === 'schedule_list') {
      const modelSchedules = []
      for (const schedule of schedules.store.list()) if (await sameWorkspace(schedule) && await memoryCoordination.transfer(sessionId, schedule.memory, project, Boolean(memoryReady))) modelSchedules.push(schedule)
      const visible = new Set(modelSchedules.map(schedule => schedule.id))
      return schedules.list().filter(schedule => visible.has(schedule.id))
    }
    if (!memoryReady && (request.op === 'schedule_create' || request.op === 'schedule_update')) {
      throw new Error(t('main.memory.context.stale'))
    }
    if (request.op === 'schedule_update' || request.op === 'schedule_delete') {
      const schedule = schedules.store.get(request.id)
      if (schedule && !await sameWorkspace(schedule)) throw new Error(t('main.schedule-runs.memory.stale'))
      const old = schedule?.memory
      if (request.op === 'schedule_update' && old) {
        if (!await memoryCoordination.transfer(sessionId, old, project, Boolean(memoryReady))
          && (request.prompt === undefined || request.title === undefined)) throw new Error(t('main.schedule-runs.memory.stale'))
      }
    }
    // The earlier owner replies may predate a host erasure that completed during the checks.
    if (historyDb.fileErasureRevision() !== erasureRevision || dsh.current !== bridge || !sameContext(caller, sessions.context())) {
      throw new Error(t('main.memory.context.stale'))
    }
    return schedules.act(request, caller.conversationId, workDirNow() ?? '', evidence)
  }

  /**
   * A turn of the main conversation ended, or ended in an error: the requests it left undecided fail, and the user is
   * told, unless they stopped it themselves.
   */
  function endRequests(event: Record<string, unknown>, sessionId = dsh.current?.currentSession()) {
    if (!sessionId) return
    const reason = event.type === 'error' ? 'turn_error' : event.stopReason === 'cancelled' ? 'cancelled' : 'unrouted'
    try {
      const failed = requests.endTurn({ sessionId, reason })
      if (failed.length && reason !== 'cancelled') emitToRenderer({ type: 'error', message: t('main.requests.not.routed'), context: sessions.context() })
    } catch (err) {
      console.error('[requests] could not end the turn\'s requests:', err instanceof Error ? err.message : String(err))
    }
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
  async function eligibleTaskReport(taskId: string, session: string, evidence?: MemoryProvenance) {
    const project = await projectOfSession(session), ready = Boolean(dsh.current?.memory.ready())
    if (evidence) return await memoryCoordination.transferStatus(evidence, project, ready) === 'ready'
    return memoryCoordination.canInherit(taskId, await projectOfSession(taskId), project, ready)
  }
  async function inheritTaskReport(taskId: string, session: string, evidence?: MemoryProvenance) {
    const project = await projectOfSession(session), ready = Boolean(dsh.current?.memory.ready())
    if (evidence) return memoryCoordination.transfer(session, evidence, project, ready)
    return memoryCoordination.inherit(taskId, session, await projectOfSession(taskId), project, ready)
  }
  const taskReports = createTaskReports({
    eligible: eligibleTaskReport,
    conversation: async () => (!dsh.current || memoryBusy() || await staleMemorySession(dsh.current.currentSession())
      || sessions.isChanging() || dsh.current.isSwitching() || dsh.isQuitting() ? 'away' : turn.active ? 'busy' : 'idle'),
    session: () => dsh.current?.currentSession() ?? null,
    holds: (effect) => effects?.holds(effect) ?? false,
    status: (session, reportId, token) => dsh.current?.reportStatus(session, reportId, token) ?? Promise.resolve('unavailable'),
    deliver: async (session, reportId, token, text, taskId, held, evidence) => {
      if (!await allowMemorySession(session) || !await eligibleTaskReport(taskId, session, evidence)) return 'unavailable'
      if (!held() || !await inheritTaskReport(taskId, session, evidence)) return 'unavailable'
      if (!held()) return 'unavailable'
      return dsh.current?.deliverReport(session, reportId, token, text, held) ?? Promise.resolve('unavailable')
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
    superseded: async (taskId, runId, evidence) => (taskRuntime?.reports.superseded(taskId, runId) ?? false)
      || (evidence ? historyDb.evidenceErased(evidence) : await staleMemorySession(taskId)),
    report: async (note, reports, held) => {
      const agent = dsh.current
      if (!agent || memoryBusy()) return false
      const context = sessions.context()
      const session = context.sessionId
      if (!session || !await allowMemorySession(session)) return false
      for (const { taskId, memory: evidence } of reports) {
        if (!held() || !await eligibleTaskReport(taskId, session, evidence) || !await inheritTaskReport(taskId, session, evidence)) return false
      }
      if (dsh.current !== agent || !sameContext(context, sessions.context()) || sessions.isChanging()
        || agent.isSwitching() || turn.active || !held()) return false
      const claim = foregroundRequests.reserveReport()
      if (!claim) return false
      turn = { active: true, startedAt: Date.now() }
      emitToRenderer({ type: 'turn_started', by: 'task', context })
      void agent.prompt(note, [], { request: false, held: () => claim.current() && held() }).catch((err: Error) => {
        if (!claim.current() || dsh.current !== agent || !sameContext(context, sessions.context())) return
        turn = { ...turn, active: false }
        emitToRenderer({ type: 'error', message: err.message, context })
      }).finally(() => { claim.finish(); wakeEffects() })
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
    if (dsh.isQuitting()) return null
    const config = currentConfig()
    if (config.problem) {
      const info = setupInfo(config)
      emitToRenderer({ type: 'ready', info })
      return info
    }
    fs.mkdirSync(config.cwd, { recursive: true })
    const context = sessions.startingIn(config.cwd)
    if (memoryProjectScope(sessions.current().cwd)?.id !== memoryProjectScope(context.cwd)?.id) context.resumeSessionId = null
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
      webSearch: webSearchNow(),
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
  /**
   * 联网搜索 as it is now: as set, or, left to 自动, off when the DeepSeek route has its own endpoint (an intranet
   * gateway, where dsh's DeepSeek Search API is not reachable) and on otherwise.
   */
  function webSearchNow(): boolean {
    const set = preferences.get().webSearch
    return set === 'on' ? true : set === 'off' ? false : !process.env.DEEPSEEK_BASE_URL
  }

  /** 联网搜索 switched: dsh starts again without (or with) web_search, on the conversation on screen. Not mid-turn. */
  async function setWebSearch(on: unknown) {
    if (typeof on !== 'boolean') throw new Error('invalid web search setting')
    if (turn.active) throw new Error(t("main.main.wait.for.this.turn.to.finish.before"))
    preferences.set('webSearch', on ? 'on' : 'off')
    return { settings: settingsView(), info: await restartKeepingConversation() }
  }

  async function setPermission(level: string) {
    if (!PERMISSION_LEVELS.includes(level)) throw new Error(`invalid permission level: ${level}`)
    if (turn.active) throw new Error(t("main.main.wait.for.this.turn.to.finish.before"))
    preferences.set('permission', level)
    return { settings: settingsView(), info: await restartKeepingConversation() }
  }

  function registerAgentIpc() {
    ipcMain.handle('agent:info', () => lastInfo)
    ipcMain.handle('agent:snapshot', (): RendererSnapshot => {
      if (sessions.isChanging()) throw new Error('Conversation selection is changing; retry initialization')
      const selected = sessions.current(), context = sessions.context()
      const found = historyDb.get(selected.id)
      // No await between the history read and publication cutoff: both share this boundary.
      const history = found ? { id: found.conversation.id, updatedAt: found.conversation.updatedAt,
        createdAt: found.conversation.createdAt, parentId: found.conversation.parentId,
        messages: found.messages, records: found.records, folds: historyDb.foldsOf(selected.id) } : null
      return { ...rendererStream.snapshot(selected.id, context), context, history,
        info: { ...lastInfo, conversationId: selected.id, sessionId: context.sessionId } }
    })
    // What the conversation on screen waits on the user for, for a window that opens on a dsh at work (a reload): said
    // on the live channel, so it comes in its place among the pushes (renderer waits-state.ts), not in the answer.
    ipcMain.handle('agent:waits', () => {
      if (sessions.isChanging()) return true
      const context = sessions.context()
      emitToRenderer({ type: 'waits', ...(dsh.current?.sessionWaits() ?? { permissions: [], questions: [], secrets: [] }), context })
      return true
    })
    ipcMain.handle('agent:prompt', (_event, text, images = [], operation, feedItemId) => {
      if (memoryBusy()) throw new Error(t('memory.read.unavailable'))
      if (sessions.isChanging()) throw new Error(t("main.main.preparing.a.new.topic.please.wait"))
      // With pictures the words may be left out.
      const question = images?.length && text === '' ? '' : assertText(text, 'prompt', MAX_PROMPT_CHARS)
      const pictures = imagesForPrompt(imageStore, images)
      const agent = requireBridge()
      // Mid-switch a question would go to the session being left, and be cut off when that one closes. The window
      // keeps sending off while it switches; this holds for every other way in (the desktop island) too.
      if (agent.isSwitching()) throw new Error(switchingMessage())
      const retrying = operation !== undefined && pendingHumanPrompts.has(JSON.stringify(operation))
      // Following questions already shown while a turn ended register together
      // in FIFO order. A first delivery needs the host's definite not-sent receipt;
      // canonical replay arrays still undergo the owner's exact source checks.
      const following = foregroundRequests.busy() && (Array.isArray(operation) || typeof operation === 'string' && historyDb.promptDelivery(operation) === 'not-sent')
      if ((turn.active || foregroundRequests.busy()) && !foregroundRequests.deferred() && !retrying && !following) throw new Error(t('main.main.wait.for.this.turn.to.finish.before'))
      return sendHumanPrompt(question, pictures, operation, feedItemId)
    })
    /** Words said while a turn runs go to that turn; 'idle' when it has just ended, so the window asks them anew. */
    ipcMain.handle('agent:steer', async (_event, text, operation) => {
      const words = assertText(text, 'steer', MAX_PROMPT_CHARS)
      const deliveryId = operation ?? randomUUID()
      if (foregroundRequests.deferred()) {
        const result = await sendHumanPrompt(words, [], deliveryId)
        return result?.accepted === false ? { ok: false, reason: 'unavailable', delivery: !closed ? historyDb.promptDelivery(deliveryId) ?? 'pending' as const
          : result.sourceIds.includes(deliveryId) ? 'not-sent' as const : 'pending' as const }
          : { ok: true, delivery: 'sent' as const }
      }
      if (historyDb.promptPending([deliveryId])) throw new Error(t('main.memory.change.pending'))
      historyDb.reservePromptDelivery([deliveryId])
      const agent = requireBridge(), origin = sessions.context(), generation = foregroundRequests.lease(), admitted = humanAdmission, originalTurn = turn
      const selected = () => generation() && dsh.current === agent
        && !sessions.isChanging() && !agent.isSwitching() && sameContext(origin, sessions.context())
      const held = () => selected() && turn === originalTurn && turn.active && (!admitted || admitted.current())
      // A normally finished turn asks the renderer to resend as a new question;
      // cancellation or a replacement selection must never do so.
      const retiredReason = (): 'idle' | 'unavailable' => selected() ? 'idle' : 'unavailable'
      if (memoryBusy()) {
        historyDb.settlePromptDelivery([deliveryId], false)
        return { ok: false, reason: 'unavailable', delivery: historyDb.promptDelivery(deliveryId) }
      }
      let sourceId: string
      try { sourceId = await aliasMemory(words, deliveryId, origin) }
      catch (error) {
        if (!closed) historyDb.settlePromptDelivery([deliveryId], false)
        return { ok: false, reason: 'unavailable', delivery: closed ? 'pending' as const : historyDb.promptDelivery(deliveryId),
          message: error instanceof Error ? error.message : String(error) }
      }
      const result = !held() ? { ok: false, reason: retiredReason(), delivery: 'not-sent' as const }
        : await agent.steer(words, sourceId, held, retiredReason)
      if (!closed && (result.ok || result.reason === 'idle' || result.delivery === 'not-sent')) historyDb.settlePromptDelivery([deliveryId], result.ok)
      return { ...result, delivery: closed ? result.delivery ?? (result.ok ? 'sent' as const : 'pending' as const) : historyDb.promptDelivery(deliveryId) }
    })
    ipcMain.handle('agent:cancel', () => { retireForegroundRequests(); return dsh.current?.cancel() })
    ipcMain.handle('agent:new-session', async () => {
      if (memoryBusy()) throw new Error(t('main.memory.change.pending'))
      // The bridge's onSessionCreated binds owner metadata before returning the acquired session.
      // Repeating it after selection commits can turn a successful switch into an unrelated recovery failure.
      return sessions.newTopic()
    })
    ipcMain.handle('agent:set-config', async (_event, configId, value) => {
      if (!CONFIG_IDS.includes(configId)) throw new Error(`invalid config option: ${configId}`)
      const info = await requireBridge().setConfig(configId, assertText(value, 'config value', 200))
      lastInfo = { ...lastInfo, ...info }
      const picked = configId === 'model' ? parseModelValue(value) : null
      if (picked) {
        modelStore.setLastModel(picked)
        emitToRenderer({ type: 'memory_changed' })
      }
      return info
    })
    ipcMain.handle('agent:permission', (_event, requestId, optionId) => {
      const id = assertText(requestId, 'requestId', 200)
      const option = optionId === null ? null : assertText(optionId, 'optionId', 200)
      return dsh.current?.respondPermission(id, option) ?? false
    })
    ipcMain.handle('agent:answer', async (_event, questionId, answers, operation) => {
      if (memoryBusy()) return false
      const id = assertText(questionId, 'questionId', 200)
      // Held first: dsh closes the question while it takes the answer, and what was asked goes with it.
      const keep = taskRuntime?.dsh.holdQuestion(id) ?? null
      try {
        const accepted = await dsh.current?.answerQuestion(id, answers, operation) ?? false
        if (accepted) keep?.(answers, taskAnswerSources.get(id))
        return accepted
      } finally { taskAnswerSources.delete(id) }
    })
    // Keys the user typed for a server the model set up: straight to the encrypted store, never to dsh.
    ipcMain.handle('agent:secrets', (_event, requestId, values) => {
      const id = assertText(requestId, 'requestId', 200)
      if (values !== null && (typeof values !== 'object' || Array.isArray(values))) throw new Error('invalid secrets')
      return dsh.current?.provideSecrets(id, values) ?? false
    })
  }

  /** A retained prompt keeps its original selection and operation through a report turn. */
  function sendHumanPrompt(question: string, pictures: ReturnType<typeof imagesForPrompt>, operation: string | string[] = randomUUID(), feedItemId?: string): Promise<IpcResults['agent:prompt']> {
    const agent = requireBridge()
    let origin = sessions.context()
    const retained = foregroundRequests.deferred()
    const key = JSON.stringify(operation)
    const fingerprint = createHash('sha256').update(JSON.stringify({ origin, question, pictures, feedItemId })).digest('hex')
    const prior = pendingHumanPrompts.get(key)
    if (prior) return prior.fingerprint === fingerprint ? prior.promise
      : Promise.reject(new Error(t('main.memory.context.stale')))
    const sources = feedItemId ? [] : typeof operation === 'string' ? [operation] : [...operation]
    if (historyDb.promptPending(sources)) return Promise.reject(new Error(t('main.memory.change.pending')))
    historyDb.reservePromptDelivery(sources)
    let nativeStarted = false, deliveryError: unknown
    let accepted = (_value: IpcResults['agent:prompt']) => {}, refused = (_error: unknown) => {}
    // Feed IPC acknowledges native admission early; the scheduling lease below
    // must still hold until that native turn actually settles.
    const admitted = feedItemId ? new Promise<IpcResults['agent:prompt']>((resolve, reject) => { accepted = resolve; refused = reject }) : null
    const selected = () => dsh.current === agent && !sessions.isChanging() && !agent.isSwitching()
      && !dsh.isQuitting() && sameContext(origin, sessions.context())
    const lifetime = foregroundRequests.human(selected, async current => {
      const own = { started: false, completed: [] as Promise<void>[], delivered() {
        own.started = true
        nativeStarted = true
        // This callback runs after connection.prompt. A failed receipt must not
        // throw out of native onStart or turn an unknown delivery into not-sent.
        try { historyDb.settlePromptDelivery(sources, true) }
        catch (error) { deliveryError = error }
      }, current, recovered() {
        const recovered = sessions.context()
        if (dsh.current !== agent || origin.conversationId !== recovered.conversationId
          || agent.currentSession() !== recovered.sessionId || sessions.isChanging()) throw new ForegroundRequestRetired()
        origin = recovered
      } }
      humanAdmission = own
      try {
        await signal({ kind: 'chat.said', text: question, images: pictures, operation, feedItemId })
        accepted(undefined)
        await Promise.all(own.completed)
        if (deliveryError) throw deliveryError
      }
      catch (error) {
        if (!own.started && !closed) historyDb.settlePromptDelivery(sources, false)
        if (retained && !feedItemId && !own.started) return { accepted: false as const,
          sourceIds: closed ? sources.filter(id => knownUnsentPrompts.has(id)) : historyDb.promptUndelivered(sources),
          message: error instanceof Error && error.message ? error.message : t('app.your.message.did.not.reach.the.assistant') }
        throw error
      }
      finally { if (humanAdmission === own) humanAdmission = null }
    }).catch((error: unknown) => {
      if (error instanceof ForegroundRequestRetired && !feedItemId && !nativeStarted) {
        if (!closed) historyDb.settlePromptDelivery(sources, false)
        return { accepted: false as const, sourceIds: closed ? sources.filter(id => knownUnsentPrompts.has(id)) : historyDb.promptUndelivered(sources),
          message: t('app.your.message.did.not.reach.the.assistant') }
      }
      throw error
    })
    const promise = admitted ?? lifetime
    if (admitted) void lifetime.then(accepted, refused)
    const pending = { fingerprint, sources, started: () => nativeStarted, promise }
    pendingHumanPrompts.set(key, pending)
    void lifetime.finally(() => {
      if (pendingHumanPrompts.get(key) === pending) pendingHumanPrompts.delete(key)
      wakeEffects()
    }).catch(() => {})
    return promise
  }

  /** chat.said's route: the question goes to the conversation on screen. */
  async function sayInChat(question: string, pictures: ReturnType<typeof imagesForPrompt>, operation: string | string[] = randomUUID(), feedItemId?: string) {
    const agent = requireBridge()
    const admission = humanAdmission
    const assertAdmitted = () => { if (admission && !admission.current()) throw new ForegroundRequestRetired() }
    assertAdmitted()
    let feedOrigin = sessions.context()
    const feedSelected = () => dsh.current === agent && !sessions.isChanging() && Boolean(feedOrigin.sessionId)
      && agent.currentSession() === feedOrigin.sessionId && sameContext(feedOrigin, sessions.context())
    const assertFeedSelected = () => { if (feedItemId && !feedSelected()) throw new Error(t('main.feed.memory.unavailable')) }
    if (memoryBusy()) throw new Error(t('main.memory.change.pending'))
    assertFeedSelected()
    const replay = Array.isArray(operation)
    if (replay && !await memory.replaySources(operation, question, currentMemoryProject())) throw new Error(t('main.memory.context.stale'))
    assertAdmitted()
    const id = agent.currentSession()
    const stale = await staleMemorySession(id)
    assertAdmitted()
    assertFeedSelected()
    const projectAllowed = stale || !id || await mayUseProjectEvidence(await memory.provenance(id), currentMemoryProject())
    assertAdmitted()
    assertFeedSelected()
    if (stale || !projectAllowed) {
      await reopenMemorySession()
      admission?.recovered()
      assertAdmitted()
      if (feedItemId) {
        const recovered = sessions.context()
        if (dsh.current !== agent || sessions.isChanging() || recovered.conversationId !== feedOrigin.conversationId
          || agent.currentSession() !== recovered.sessionId) throw new Error(t('main.feed.memory.unavailable'))
        feedOrigin = recovered
        assertFeedSelected()
      }
    }
    let feedCurrent: (() => boolean) | undefined
    if (feedItemId) {
      if (replay) throw new Error(t('main.memory.context.stale'))
      const origin = { ...feedOrigin }
      feedCurrent = await admitFeedContinuation({ text: question, read: () => feedContinuation(feedItemId),
        current: feedSelected,
        transfer: evidence => memoryCoordination.transfer(origin.sessionId!, evidence, currentMemoryProject(), agent.memory.ready()),
        record: () => recordDeliveredSource(operation, origin, { derived: true }),
      })
      if (!feedCurrent()) throw new Error(t('main.feed.memory.unavailable'))
    } else if (!replay) {
      await aliasMemory(question, operation)
    } else {
      for (const sourceId of operation) { await recordDeliveredSource(sourceId); assertAdmitted() }
    }
    assertAdmitted()
    turn = { active: true, startedAt: Date.now() }
    const carryRevision = historyDb.fileErasureRevision()
    const carried = sessions.takeCarried()
    const held = carried || feedCurrent || admission ? () => (!carried || historyDb.fileErasureRevision() === carryRevision)
      && (feedCurrent?.() ?? true) && (admission?.current() ?? true) : undefined
    const words = carried ? `${carried}

${question}` : question
    const failed = (error: unknown) => {
      if (admission && !admission.current()) throw error
      finishForegroundTurn()
      if (id !== agent.currentSession()) {
        emitToRenderer({ type: 'error', message: error instanceof Error ? error.message : String(error), context: sessions.context() })
        return
      }
      throw error
    }
    if (!feedItemId) {
      let started = false
      await agent.prompt(words, pictures, { userTurn: true, onStart: () => { started = true; admission?.delivered() },
        sourceId: typeof operation === 'string' ? operation : operation.length === 1 ? operation[0] : undefined, sourceText: question, held }).catch(failed)
      if (!started) throw new ForegroundRequestRetired()
      return
    }
    return await new Promise<void>((resolve, reject) => {
      const complete = agent.prompt(words, pictures, { userTurn: true, onStart: () => { admission?.delivered(); resolve() }, sourceId: undefined, held }).then(() => {
        reject(new Error(t('main.memory.context.stale')))
      }, error => { if (!admission || admission.current()) finishForegroundTurn(); reject(error) })
      admission?.completed.push(complete)
    })
  }

  /** Where each kind of signal goes (event-core.ts Routes): a route for every kind, or the type check fails. */
  function routeSignals(events: EventCore) {
    events.route({
      'chat.said': ({ text, images, operation, feedItemId }) => sayInChat(text, images as ReturnType<typeof imagesForPrompt>, operation, feedItemId),
      // A turn of the user's just ended: clear the turn's source bindings.
      'agent.turn_ended': ({ stopReason }) => {
        finishForegroundTurn(stopReason === 'end_turn', stopReason === 'end_turn' || stopReason === 'max_tokens')
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
    ipcMain.handle('settings:set-web-search', (_event, on) => setWebSearch(on))
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
    const projectChanged = currentMemoryProject()?.id !== memoryProjectScope(dir)?.id
    const info = projectChanged || await staleMemorySession(sessions.current().sessionId)
      ? await sessions.withSelection(async ({ switchAgent, select }) => {
        const previous = sessions.current(), topicId = sessions.topicId()
        const carried = await filteredCarry(previous.id, true, dir)
        const started = await switchAgent(null, dir)
        const next = historyDb.create({ sessionId: started.sessionId, mode: started.mode, model: started.model, cwd: started.cwd,
          parentId: !projectChanged && historyDb.get(previous.id) ? previous.id : null, topicId: projectChanged ? null : topicId })
        select(next)
        await publishCarry(next, carried)
        return { ...started, conversationId: next.id, topicId: next.topicId ?? next.id, remembersHistory: false }
      })
      : await sessions.switchDirectory(dir)
    if (info.sessionId) {
      await memory.recordSession(info.sessionId)
      await bindSessionProject(info.sessionId, currentMemoryProject())
    }
    emitToRenderer({ type: 'workdir', cwd: dir, info })
    return info
  }

  const chooseWorkFolder = () => host.dialogs.chooseFolder({ title: t("main.main.choose.working.directory"), createDirectory: true })
  const chooseExportPath = (defaultName: string) => host.dialogs.saveFile({
    title: t("main.main.export.conversation"), defaultPath: path.join(host.paths.documents, defaultName), filters: [{ name: 'Markdown', extensions: ['md'] }],
  })
  const chooseDshDir = () => host.dialogs.chooseFolder({ title: t("main.main.choose.the.dsh.folder.usually.named.dsh"), defaultPath: os.homedir(), showHidden: true })

  /**
   * The MCP servers changed: viva-mcp (dsh's MCP manager) takes the new set at once and connects it in the background;
   * no session is reopened, so this works mid-turn too. How the servers stand comes back as `mcp_status`.
   */
  async function applyMcpChange() {
    dsh.current?.applyMcp()
    return null
  }

  /** 动态 changed: the window shows it, the tray counts what is new. */
  function feedChanged() {
    host.window.setPending(feed?.list().filter((item) => item.seenAt === null).length ?? 0)
    emitToRenderer({ type: 'feed_changed' })
  }

  async function feedContinuation(id: string) {
    const store = requireFeed(), project = currentMemoryProject()
    const revision = historyDb.fileErasureRevision()
    const continuation = store.continuation(id)
    const current = () => revision === historyDb.fileErasureRevision() && project?.id === currentMemoryProject()?.id
      && Boolean(continuation && store.continuationCurrent(continuation))
    if (!continuation || await memoryCoordination.transferStatus(continuation.memory, project, true) !== 'ready'
      || !current()) {
      throw new Error(t('main.feed.memory.stale'))
    }
    return { ...continuation, current }
  }

  /** A new item in 动态: its notification queued in the change that made it, so a quit before it goes loses nothing. */
  function queueFeedNotice(item: FeedItem) {
    if (!effects) throw new Error('the effects queue is not open yet')
    effects.queue(FEED_NOTICE, item.id, { title: item.title, body: item.body.slice(0, NOTICE_BODY_CHARS) })
  }

  /** A schedule's prompt run in its own folder; one whose folder is gone fails, saying so. */
  async function runSchedule(prompt: string, cwd: string, evidence: MemoryProvenance | null): Promise<RunResult> {
    if (!await mayUseProjectEvidence(evidence, memoryProjectScope(cwd))) return Promise.resolve({ ok: false, staleMemory: true, problem: t('main.feed.memory.stale') })
    if (!isFolder(cwd)) return Promise.resolve({ ok: false, problem: t('main.schedule-runs.folder.gone', { cwd }) })
    if (memoryBusy()) return Promise.resolve({ ok: false, unavailable: true, problem: t('main.memory.change.pending') })
    const ready = () => dsh.current?.memory.ready() === true
    if (!ready()) {
      return Promise.resolve({ ok: false, unavailable: true, memoryUnavailable: true, problem: t('main.feed.memory.unavailable') })
    }
    return unattended.run(prompt, cwd, async (session, bridge) => {
      if (bridge !== dsh.current) return 'memory-unavailable'
      const project = memoryProjectScope(cwd)
      const status = await memoryCoordination.transferStatus(evidence, project, ready())
      if (status !== 'ready') return status
      if (!await bindSessionProject(session, project) || !await memoryCoordination.transfer(session, evidence, project, ready())) return 'stale'
    })
  }

  function registerPersonalIpc(config: Config) {
    registerRuntimeMemoryIpc(ipcMain, {
      client: memory, projectScope: currentMemoryProject,
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
      restartMcp: (name) => dsh.current?.restartMcp(name),
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
    try {
      traceDb = openTraceDb({ file: path.join(userData, 'trace.db') })
    } catch (err: any) {
      console.error('[trace] could not open trace.db; reopened conversations fall back to dsh logs:', err.message)
    }
    mcpStore = createMcpConfigStore({ file: path.join(userData, 'mcp-servers.json'), crypto: host.secrets, onError: (err) => console.error('[mcp]', err.message) })
    personal = createPersonal({ historyDb, mcpStore })
    registerPersonalIpc(config)
    const schedulesChanged = () => emitToRenderer({ type: 'schedules_changed' })
    const scheduleMemoryCurrent = memoryCoordination.transferable
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
    ipcMain.handle('schedules:accept', (_event, proposalId, edits) => requireSchedules().accept(String(proposalId), edits ?? undefined))
    ipcMain.handle('schedules:decline', (_event, proposalId) => { requireSchedules().decline(String(proposalId)) })
    // 动态's 接下来: pause, resume and delete by hand too (the conversation does the rest).
    ipcMain.handle('schedules:pause', (_event, id, paused) => requireSchedules().update(String(id), { paused: Boolean(paused) }))
    ipcMain.handle('schedules:delete', (_event, id) => requireSchedules().remove(String(id)))
    ipcMain.handle('feed:list', () => items.list(FEED_LISTED))
    ipcMain.handle('feed:continue', async (_event, id) => continueText((await feedContinuation(id)).item))
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
      if (!agent || !source || sessions.isChanging() || !await allowMemorySession(source)) return { ok: false, reason: 'unavailable' }
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
      schedule: (run, ms) => {
        const timer = setTimeout(() => { historyPurgeTimers.delete(timer); run() }, ms)
        historyPurgeTimers.add(timer); timer.unref()
      },
      dshHome: dshHomeOf(config),
      traceDb: () => traceDb,
      readNativeTrace,
      current: sessions.current,
      // A report waiting for this conversation (task-reports.ts) may go now.
      setCurrent: sessions.select,
      agentInfo: () => lastInfo,
      validateSave: (id, mark) => {
        if (mark && !sameContext(mark.context, sessions.context())) throw new Error('Conversation save belongs to an old selection')
        rendererStream.validateSave(id, mark)
      },
      historySaved: rendererStream.save,
      selectSession: sessions.withSelection,
      chooseExportPath,
      isBusy: () => turn.active || memoryBusy(),
      staleSession: staleMemorySession,
      filteredCarry,
      publishCarry,
      recordSession: async id => {
        if (id) {
          await memory.recordSession(id)
          await bindSessionProject(id, currentMemoryProject())
        }
      },
      deleteHistory: memoryWithdrawal.deleteHistory,
      folderExists: (dir) => isFolder(dir),
      workDir: () => workDirNow() ?? null,
    })
    registerRewindIpc(ipcMain, {
      db: historyDb,
      current: sessions.current,
      isBusy: () => turn.active || memoryBusy(),
      agentInfo: () => lastInfo,
      selectSession: sessions.withSelection,
      traceDb: () => traceDb,
      readNativeTrace,
      replaySource: (id, text) => memory.replaySources([id], text, currentMemoryProject()),
      derivedSource: id => memory.isDerivedDelivery(id),
      canEditSource: async () => !await sessionProjectChanged(sessions.current().sessionId, currentMemoryProject())
        && (!dsh.current || dsh.current.memory.ready()),
      commitEdit: memoryWithdrawal.commitEdit,
      rebuild: async (previous, kept, force) => {
        if (!force && !await staleMemorySession(previous.sessionId) && memory.epoch() === 0) return null
        const revision = historyDb.fileErasureRevision()
        const project = memoryProjectScope(previous.cwd)
        const current = historyDb.get(previous.id)?.messages.slice(0, kept.length) ?? []
        const rows = current.flatMap((row, index) => row.role === 'user' && row.sourceId && row.sourceId === kept[index]?.sourceId
          ? [{ ...row, segmentId: previous.id }] : [])
        return verifiedHistoryCarry(rows, historyForProject(project), revision, historyDb.fileErasureRevision)
      },
      publishCarry,
      onContinuation: async (previous, started) => {
        if (started.sessionId && await staleMemorySession(previous.sessionId)) await storeSessionCarry(previous.id)
      },
    })
    // Tasks still going, kept so the next launch can offer to take them up (dsh ends with the app). Only the task
    // runtime writes them, each change with its event (task.started, task.ended, …).
    taskStore = createTaskStore({ db: appDb.db, retainedReply: historyDb.retainedReply,
      onError: (err) => console.error('[tasks]', err.message) })
    effects = createEffects({ db: appDb.db, apply: applyChange, onError: (err) => console.error('[effects]', err instanceof Error ? err.message : String(err)) })
    memoryWithdrawal.register()
    memoryHostEffects = createMemoryHostEffects({ db: appDb.db, call: memory.call, apply: applyChange, eraseHistory: historyDb.eraseMemoryCopies,
      eraseFileHistory: historyDb.eraseFileRanges,
      fileCopiesDurable: async effect => {
        await memory.call('ackHostEffect', { effectId: effect.effectId, causeOperationId: effect.causeOperationId, revision: effect.revision })
      },
      invalidateFileHistory: sessions.discardStaleCarry,
      eraseTaskBodies: taskStore.eraseMemoryBodies,
      invalidateTaskBodies: async sessions => { await taskRuntime?.revokeMemorySessions(sessions) },
      generatedCopiesRemoved: copies => emitToRenderer({ type: 'memory_changed', erasedOutputs: copies.map(({ session, key }) => ({ session, key })) }),
      feedCopiesRemoved: erasedFeedIds => emitToRenderer({ type: 'memory_changed', erasedFeedIds }),
      eraseRoutedMemory: matches => requests.eraseMemory(matches),
      reportsRemoved: reportIds => emitToRenderer({ type: 'reports_removed', reportIds }),
      traceInvalidated: traceSessions => emitToRenderer({ type: 'memory_changed', traceSessions }),
      invalidateScheduled: (matches, changed) => {
        schedules?.discardMemory(matches)
        const discarded = scheduleRuns?.discardMemory(matches)
        if (changed || discarded) {
          scheduleRuns?.wake()
          feedChanged()
          emitToRenderer({ type: 'schedules_changed' })
        }
      },
      invalidate: async effect => { if (effect.kind === 'erase-copies') await taskRuntime?.revokeMemorySessions(effect.sessions ?? []); sessions.carryNext(sessions.current().id, ''); emitToRenderer({ type: 'memory_changed' }); feedChanged(); emitToRenderer({ type: 'schedules_changed' }) },
    })
    effects.runs(REPORT, taskReports)
    // A new item's notification (schedule-runs.ts): handed to the desktop, done.
    effects.runs(FEED_NOTICE, async (queued) => {
      for (const effect of queued) if (effects?.holds(effect)) host.notify(effect.payload as Notice)
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
      captureReportMemory: taskId => memory.provenance(taskId),
      effects,
    })
    registerTaskIpc(ipcMain, taskRuntime.window)
    // The main conversation's requests: each decision's task actions go to the task runtime. A task starts from the
    // conversation on screen (task-runtime.ts), so only while that is still the request's: a decision outliving its
    // turn (stopped meanwhile) must not start its remaining work in another conversation. Only tasks of the request's
    // working folder are stopped or messaged.
    const tasks = taskRuntime.agent
    const visible = (taskId: string, cwd: string | null) => { tasks.query({ op: 'get', taskId }, { cwd: cwd ?? '' }) }
    async function requestEvidence(place: RequestPlace) {
      const bridge = dsh.current
      const here = () => {
        const selected = sessions.current()
        return bridge === dsh.current && selected.id === place.conversationId && selected.sessionId === place.sessionId
      }
      if (!here()) throw new Error(t('main.requests.start.elsewhere'))
      if (!bridge || !place.memory
        || !await bridge.memory.call('authorizedProvenance', { session: place.sessionId, prior: place.memory })
        || !here() || historyDb.evidenceErased(place.memory)) throw new Error(t('main.memory.context.stale'))
      return place.memory
    }
    function admitTask(place: RequestPlace, evidence: MemoryProvenance | undefined, targetCwd?: string) {
      return async (taskId: string) => {
        if (sessions.current().sessionId !== place.sessionId || !await allowMemorySession(place.sessionId, place.cwd ?? undefined)
          || !await allowMemorySession(taskId, targetCwd) || !canTransferMemoryToModel(taskId)) return false
        const project = targetCwd === undefined ? await projectOfSession(taskId) : memoryProjectScope(targetCwd)
        if (!await memoryCoordination.transfer(taskId, evidence, project, Boolean(dsh.current?.memory.ready()))
          || sessions.current().sessionId !== place.sessionId) return false
        return evidence ?? true
      }
    }
    requests = createRequestRuntime({
      store: createRequestStore({ db: appDb.db }),
      evidenceErased: historyDb.evidenceErased,
      apply: applyChange,
      tasks: {
        start: async ({ title, brief }, place) => {
          const evidence = await requestEvidence(place)
          return tasks.start(brief, title, admitTask(place, evidence, place.cwd ?? workDirNow() ?? undefined))
        },
        message: async (taskId, text, place) => {
          const evidence = await requestEvidence(place)
          visible(taskId, place.cwd)
          return tasks.message(taskId, text, admitTask(place, evidence))
        },
        stop: async (taskId, place) => {
          await requestEvidence(place)
          visible(taskId, place.cwd)
          return tasks.stop(taskId)
        },
      },
    })
    const recovered = requests.recover()
    if (recovered.uncertain) console.error(`[requests] ${recovered.uncertain} task action(s) were left without a receipt when Viva stopped; they are not done again`)
  }

  /** Opens the stores and registers the backend's channels, before the window loads. */
  function open() {
    appDb = openAppDb({ file: path.join(userData, 'app.db') })
    core = createEventCore({ app: appDb, publish: rendererStream.send })
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
    retireForegroundRequests()
    closed = true
    for (const timer of historyPurgeTimers) clearTimeout(timer)
    historyPurgeTimers.clear()
    memoryHostRecovery.close()
    memoryHostEffects?.close()
    scheduleRuns?.close()
    taskRuntime?.dispose()
    historyDb?.close()
    appDb?.close()
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
    publishAutomation: (value: unknown) => {
      if (!host.automation) throw new Error('Only available to external automation')
      if (!value || typeof value !== 'object') throw new Error('Invalid automation event')
      const event = value as Record<string, unknown>
      if (typeof event.type !== 'string' || !['turn_started', 'turn_end', 'update'].includes(event.type)) throw new Error('Invalid automation event type')
      emitToRenderer({ ...event, type: event.type, context: sessions.context() })
    },
    hasBridge: () => Boolean(dsh.current),
    isQuitting: dsh.isQuitting,
    /** Quitting has begun (or the session ends): dsh must not be started again. */
    markQuitting() {
      dsh.markQuitting()
    },
    /** Stops dsh, waiting at most a few seconds; the real release remains a barrier. */
    stop: dsh.stopWithin,
    close,
  }
}

export type Backend = ReturnType<typeof createBackend>

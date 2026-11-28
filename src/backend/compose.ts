import { createDshLifecycle, type DshLifetime } from './dsh-lifecycle.ts'
import { emitDiagnostic, emitDiagnosticFailure } from '../diagnostics/node/context.ts'
import { createConversationSession } from './conversation-session.ts'
import { createForegroundRequests, ForegroundRequestRetired } from './foreground-requests.ts'
import { sameContext, type ConversationContext } from '../shared/conversation-context.ts'
import { objectOf } from '../shared/unknown-value.ts'
import type { IpcResults } from '../shared/ipc-results.ts'
import { createConfigActions } from './config-actions.ts'
import { createSchedules, registerSchedulesIpc, type Schedules } from './schedules.ts'
import { createScheduleRuns, type DeliveredScheduleRun, type ScheduleRuns } from './schedule-runs.ts'
import { createUnattendedRuns, type RunResult, type TaskEvent } from './unattended-runs.ts'
import { onLocaleChange } from '../shared/i18n/locale.ts'
import { t } from '../shared/i18n/translate.ts'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MAX_MESSAGE_CHARS as MAX_PROMPT_CHARS } from '../shared/text-limits.ts'
import { createHash, randomUUID } from 'node:crypto'
import { createVivaMemoryClient } from './memory-client.ts'
import { MemoryOwnerUnavailable } from './remote-memory-channel.ts'
import {
  eligibleQuestionAnswers,
  eligibleQuestionSelections,
  questionAnswerSourceId,
} from '../memory/node/question-answer-memory.ts'
import type { HostMemoryApi, HostMemoryCaller, HostMemoryMethod } from '../memory/contracts/host.ts'
import type { TaskDispatchMeta } from './acp-task-sessions.ts'
import { resolveMemoryProject } from '../memory/node/project-scope.ts'
import { registerRuntimeMemoryIpc } from './memory-ipc.ts'
import { carriedRecords, type HistoryCarry } from './history-carry.ts'
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
import { openHistoryDb, type Conversation } from './history-db.ts'
import { createForegroundHistory, type ForegroundHistory } from './foreground-history.ts'
import { checkImages, type ImageRef } from '../shared/images.ts'
import { createDroppedFileRegistry, inlineAttachedFiles } from './attached-files.ts'
import { imagesForPrompt, registerImageIpc } from './image-ipc.ts'
import type { IpcRegistry } from '../shared/ipc-contract.ts'
import { createImageStore } from './image-store.ts'
import { registerHistoryIpc } from './history-ipc.ts'
import { registerRewindIpc } from './rewind-ipc.ts'
import { registerTaskIpc } from './task-ipc.ts'
import { boundScheduleRecordOutput, createTaskReports, GATHER_MS, REPORT, reportId, REQUEST_CHARS, type ReportPayload } from './task-reports.ts'
import { isScheduleTaskId, scheduleTaskId } from '../shared/task-report.ts'
import { migrateLegacyFeed, NOTICE_BODY_CHARS, SCHEDULE_NOTICE } from './legacy-feed-migration.ts'
import { createReportRecords } from './report-records.ts'
import { createEffects, type Effect, type Effects } from './effects.ts'
import { createTaskRuntime, type TaskRuntime } from './task-runtime.ts'
import type { TaskChannelAction } from './tasks-channel.ts'
import { checkAnswers, type Question } from './question-channel.ts'
import { createRequestStore } from './request-store.ts'
import { createRequestRuntime, type RequestPlace, type RequestRuntime } from './request-runtime.ts'
import { createTaskStore } from './task-store.ts'
import { sameDir } from './work-dir.ts'
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
import { profileFitOptions } from './plugin-fit.ts'
import { skillRoots } from './skills.ts'
import { historyRecall } from './history-recall.ts'
import type { HistoryEvidence } from './history-recall.ts'
import { openAppDb, type AppDb } from './app-db.ts'
import { createEventCore, type EventCore, type Signal } from './event-core.ts'
import { createRendererStream } from './renderer-stream.ts'
import { CONVERSATION_WINDOW_MESSAGES, type RendererSnapshot } from '../shared/renderer-sync.ts'
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

type HistoryDb = ReturnType<typeof openHistoryDb>
type Bridge = ReturnType<typeof createAcpBridge>
type AgentInfo = import('../shared/agent-info.ts').AgentInfo

/** The writes of the stores on the app database, each recorded with its event (journal.ts). */
const HISTORY_WRITES = Object.freeze(['save', 'commit', 'addRecord', 'moveRecords', 'rename', 'setPinned', 'softDelete', 'restore', 'purgeDeleted', 'archiveLegacyFeed', 'fold', 'unfold', 'setStar', 'reservePromptDelivery', 'settlePromptDelivery'] as const)

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
  let rendererStream: ReturnType<typeof createRendererStream>
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
  /** Backend single-writer for the foreground conversation on screen (foreground-history.ts). */
  let foregroundHistory: ForegroundHistory | null = null
  /** Pictures pasted into questions, and dsh's copies of them, in a folder the user may move (image-store.ts). */
  let imageStore!: ReturnType<typeof createImageStore>
  /** The user's MCP servers, encrypted where they hold keys (mcp-config.ts). */
  let mcpStore!: ReturnType<typeof createMcpConfigStore>
  const embeddingRoot = path.extname(APP_ROOT) === '.asar'
    ? path.join(path.dirname(APP_ROOT), 'memory-embedding') : path.join(APP_ROOT, 'build', 'memory-embedding', 'prepared')
  const embedding = { modelRoot: path.join(embeddingRoot, 'model'), runtimeRoot: path.join(embeddingRoot, 'runtime') }
  let defaultWorkspace: string | undefined
  function historyWorkspace(cwd: string | null | undefined) {
    return cwd && defaultWorkspace && sameDir(cwd, defaultWorkspace) ? null : cwd
  }
  const memoryCall: HostMemoryCaller = <M extends HostMemoryMethod>(method: M, input: HostMemoryApi[M]['input']) => {
    const bridge = dsh.current
    if (!bridge) return Promise.reject(new MemoryOwnerUnavailable())
    return bridge.memory.call(method, input)
  }
  const memoryReadBatch = <T>(work: (read: HostMemoryCaller) => Promise<T>, options?: { budgetMs?: number, signal?: AbortSignal }) => {
    const bridge = dsh.current
    if (!bridge) return Promise.reject(new MemoryOwnerUnavailable())
    return bridge.memory.readBatch(work, options)
  }
  const memory = createVivaMemoryClient(memoryCall, memoryReadBatch)
  /** What the trace plugin recorded, for the 过程 of reopened conversations; null if it can't be opened. */
  let traceDb: ReturnType<typeof openTraceDb> | null = null
  /** Background tasks still going or ended lately (task-store.ts); follow-ups look at it to not prepare what a task does. */
  let taskStore: ReturnType<typeof createTaskStore> | null = null
  /** The background tasks, their one writer (task-runtime.ts); set once the history is open. */
  let taskRuntime: TaskRuntime | null = null
  const historyPurgeTimers = new Set<ReturnType<typeof setTimeout>>()
  /** The main conversation's requests and their decisions (request-runtime.ts); set once the history is open. */
  let requests!: RequestRuntime
  let schedules: Schedules | null = null
  /** Schedules run when due, their answers queued back into the main conversation (schedule-runs.ts). */
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
  let turn = { active: false, startedAt: 0, id: '', by: '', stopping: false }
  const foregroundRequests = createForegroundRequests()
  const pendingHumanPrompts = new Map<string, { fingerprint: string, turnId: string, context(): ConversationContext, sources: readonly string[], started(): boolean, promise: Promise<IpcResults['agent:prompt']> }>()
  let closed = false
  const knownUnsentPrompts = new Set<string>()
  let humanAdmission: { turnId: string, started: boolean, delivered(): void, current(): boolean, recovered(): void, topicId?: () => string } | null = null
  function retireForegroundRequests() {
    try {
      if (!closed) knownUnsentPrompts.clear()
      if (!closed) for (const pending of pendingHumanPrompts.values()) if (!pending.started()) {
        historyDb?.settlePromptDelivery(pending.sources, false)
        for (const id of historyDb?.promptUndelivered(pending.sources) ?? []) knownUnsentPrompts.add(id)
      }
    } catch (error) {
      // A failed receipt stays pending. It cannot prevent cancellation or release.
      emitDiagnosticFailure('conversation.send', error, { stage: 'checkpoint' })
    } finally { foregroundRequests.invalidate() }
  }
  let lastInfo: AgentInfo = { mode: 'connecting', model: '', cwd: '', reason: '' }
  // The stopped session still owns its renderer history. Its native binding is retired.
  let stoppedContext: ConversationContext | null = null
  const sessions = createConversationSession({
    history: () => historyDb,
    agent: () => dsh.current,
    info: () => lastInfo,
    setInfo: (info) => { lastInfo = info },
    isBusy: () => turn.active || stoppedContext !== null,
    folderExists: isFolder,
    selectedModel: () => { const last = modelStore.lastModel(); return last ? modelValue(last) : null },
    changed: () => {
      foregroundHistory?.retryPending()
      wakeEffects()
    },
  })

  const rendererContext = () => stoppedContext?.conversationId === sessions.current().id ? stoppedContext : sessions.context()

  /** A push for the window, numbered by the event core (a transient one: what changes state goes through apply). */
  function emitToRenderer(event: HostEvent) {
    if (event.type === 'ready') lastInfo = event.info
    if (event.type === 'config') lastInfo = { ...lastInfo, ...event.info }
    if (core) core.transient(event)
    else host.window.send({ ...event, seq: 0, transient: true })
    foregroundHistory?.receive(event)
  }

  /** What dsh reports of tasks: to the task runtime first, then its signal recorded (task-signals.ts). */
  const taskSignals = createTaskSignals({
    signal: (input) => signal(input),
    receive: (event) => taskRuntime?.dsh.receive(event),
    onError: (err) => emitDiagnosticFailure('task.report', err, { stage: 'checkpoint' }),
  })

  /** Scheduled runs have their own events, separate from background tasks. */
  const unattended = createUnattendedRuns({ agent: () => dsh.current })

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

  type DshContext = { config: Config, cwd: string, resumeSessionId: string | null, carryHistory?: boolean }
  const dsh = createDshLifecycle({
    create: ({ config, cwd }: DshContext, lifetime) => {
      return createBridge(config, cwd, lifetime)
    },
    connect: (instance: Bridge, context: DshContext) => instance.start({ resumeSessionId: context.resumeSessionId }),
    onReady: async (started, context) => {
      const old = sessions.current()
      const sameProject = (old.sessionId && historyDb.nativeProject(old.sessionId) || projectScopeKey(old.cwd)) === projectScopeKey(context.cwd)
      const info = sessions.ready(started, context.cwd)
      if (!sameProject) sessions.select(historyDb.create({ sessionId: started.sessionId, mode: started.mode, model: started.model, cwd: context.cwd }))
      if (sameProject && context.carryHistory) await storeSessionCarry(old.id)
      stoppedContext = null
      emitToRenderer({ type: 'ready', info: sameProject ? info : { ...info, conversationId: sessions.current().id, topicId: sessions.topicId(), remembersHistory: false } })
      wakeEffects()
      scheduleRuns?.wake()
    },
    onGone: () => {
      retireForegroundRequests()
      taskRuntime?.dsh.gone(); unattended.gone()
      emitToRenderer({ type: 'memory_changed' })
      // Retired generations cannot deliver a final error/turn_end. Settle the foreground here too,
      // including deliberate model/key restarts, before publishing the replacement's readiness.
      if (turn.active) {
        emitToRenderer({ type: 'turn_end', stopReason: 'cancelled', context: sessions.context() })
        finishForegroundTurn()
      }
      foregroundHistory?.flush()
      // Its requests too: the retired generation's turn_end never reaches endRequests.
      const left = sessions.context().sessionId
      if (left) endRequests({ type: 'turn_end', stopReason: 'cancelled' }, left)
    },
    onCrash: ({ message }, delay) => {
      turn = { active: false, startedAt: 0, id: '', by: '', stopping: false }
      emitDiagnosticFailure('process', message, { stage: 'closed' })
      emitToRenderer({ type: 'error', message: delay === null
        ? t("main.main.the.assistant.exited.repeatedly.retrying.has.stopped", { message })
        : t("main.main.the.assistant.exited.unexpectedly.reconnecting.in.seconds", { value1: Math.round(delay / 1000) }) })
    },
    restart: async (): Promise<unknown> => startBridge(),
    onRestartError: error => {
      emitDiagnosticFailure('process', error, { stage: 'recovering' })
      emitToRenderer({ type: 'error', message: t("main.main.could.not.connect.the.assistant", { message: error instanceof Error ? error.message : String(error) }) })
    },
  })

  function finishForegroundTurn() {
    if (!turn.active) return
    turn = { ...turn, active: false }
  }

  function workspaceOfSession(id: string | undefined) {
    if (!id) return undefined
    if (isMainSession(id)) return workDirNow()
    const conversation = historyDb.bySession(id)
    return conversation ? conversation.cwd : unattended.workspaceOf(id)
  }
  function projectScopeKey(cwd: string | null | undefined) {
    const scope = resolveMemoryProject(historyWorkspace(cwd))
    return scope.status === 'project' ? scope.project.id : scope.status
  }

  function readNativeTrace<T>(sessions: readonly string[], read: (visible: readonly string[]) => T | Promise<T>) {
    return dsh.readNative(async () => read(sessions))
  }
  const isMainSession = (sessionId: string | null | undefined) => Boolean(sessionId && sessionId === sessions.current().sessionId)
  function historyProject(conversationId: string, sessionId?: string | null) {
    const saved = historyDb.workspaceOf(conversationId)
    const source = sessionId ?? saved?.sessionId
    return (source && historyDb.nativeProject(source)) || projectScopeKey(saved?.cwd)
  }
  function historyForProject(project: string, crossProject = false) {
    return (row: HistoryEvidence) => {
      if (!historyDb.promptDeliverable(row.sourceId)) return false
      if (crossProject) return true
      return project !== 'unknown' && historyProject(row.segmentId, row.sessionId) === project
        && !row.foregroundOnly
    }
  }
  async function publishCarry(target: Conversation, carry: HistoryCarry) {
    if (!carry.turns || !target.sessionId || sessions.current().id !== target.id || sessions.current().sessionId !== target.sessionId) return false
    sessions.carryNext(target.id, carry.text)
    return true
  }
  async function storeSessionCarry(id: string) {
    const target = sessions.current()
    const carry = await filteredCarry(id, true, workDirNow() ?? undefined)
    await publishCarry(target, carry)
  }
  async function filteredCarry(conversationId: string, userOnly = false, targetCwd?: string) {
    const topic = historyDb.topicOf(conversationId)
    const part = historyDb.read(userOnly || !topic ? `s:${conversationId}` : `t:${topic}`, { from: Number.MAX_SAFE_INTEGER, count: 40 })
    const sourceProject = historyProject(conversationId)
    const project = targetCwd === undefined ? sourceProject : projectScopeKey(targetCwd)
    const rows = sourceProject === project ? part?.messages.filter(row => !userOnly || row.role === 'user') ?? [] : []
    const allowed = historyForProject(project)
    return carriedRecords(rows.filter(allowed))
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
      const { plugins, problems } = resolvePlugins({ codeRoot: CODE_ROOT, userData, dshVersion: installedDshVersion(APP_ROOT), permission: permissionNow(),
        memory: { ...embedding, dailyNotes } })
      pluginProblems = problems
      problems.forEach(({ name }) => emitDiagnostic({ event: 'operation.progress', operation: 'plugin', stage: 'unavailable', reason: 'validation_failed', identities: { resourceId: name } }))
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
      emitDiagnosticFailure('plugin', err, { stage: 'unavailable' })
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
      emitDiagnosticFailure('plugin', err, { stage: 'unavailable' })
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

  /** Events from a replaced bridge are dropped so a restart can't leak into the new conversation. */
  function createBridge(config: Config, cwd: string, lifetime: DshLifetime): Bridge {
    return createAcpBridge({
      prewarmSessions: true,
      memoryStateChanged: () => {
        if (!lifetime.isCurrent()) return
        emitToRenderer({ type: 'memory_changed' })
      },
      memoryNotice: () => {
        if (!lifetime.isCurrent()) return
        emitToRenderer({ type: 'memory_changed' })
      },
      memoryContextUsed: notice => {
        if (!lifetime.isCurrent()) return
        const context = sessions.context()
        if (notice.session === context.sessionId && notice.conversation === context.conversationId && notice.pushed.length) {
          emitToRenderer({ type: 'memory_context', injected: [{ at: notice.at, pushed: notice.pushed }], context })
        }
      },
      dshBin: config.dshBin,
      nodeBin: config.nodeBin,
      ...prepareProfile(config),
      cwd,
      env: dshEnv({ base: process.env, dshHome: dshHomeOf(config), runtime: config.runtime, settings: dshSettings(config) }),
      mcpServers: () => personal.mcpServers(),
      configActions: configActions(config),
      onSessionCreated: (id, cwd) => historyDb.recordNativeProject(id, projectScopeKey(cwd)),
      projectMatches: (id, cwd) => {
        const saved = historyDb.nativeProject(id)
        return saved === undefined || saved === projectScopeKey(cwd)
      },
      allowGeneralQuestion: (_session, turn) => Boolean(turn),
      admitTaskWaitResume: (kind, id) => {
        const slot = taskRuntime?.dsh.reserveWaitResume(kind, id)
        return !slot || !('problem' in slot)
      },
      onQuestionAnswer: (entry, answers, _operation, meta) => {
        const conversation = entry.taskId ? historyDb.bySession(entry.sessionId)?.id : entry.context?.conversationId
        if (!conversation) return
        const bridge = lifetime.isCurrent() ? dsh.current : null
        if (!entry.memoryEligible || !entry.callId || entry.callSeq === undefined || !bridge?.memory.ready()) return
        const cards = meta?.rawCards ?? entry.question.questions
        const eligibleCustom = eligibleQuestionAnswers(cards, answers)
        const eligibleSelections = eligibleQuestionSelections(cards, answers)
        if (eligibleCustom.length === 0 && eligibleSelections.length === 0) return
        const sourceIds = Object.create(null) as Record<string, string>
        for (const item of eligibleCustom) {
          sourceIds[item.id] = questionAnswerSourceId(entry.sessionId, entry.callSeq, entry.callId, item.id)
        }
        return { conversationId: conversation, sourceIds, recordReceipt: true }
      },
      historySearch: async (query, range, session) =>
        historyRecall(historyDb, historyForProject(projectScopeKey(workspaceOfSession(session)), isMainSession(session))).search(query, range),
      historyRead: async (ref, around, session) =>
        historyRecall(historyDb, historyForProject(projectScopeKey(workspaceOfSession(session)), isMainSession(session))).read(ref, around),
      taskRead: (request, sessionId) => requireTasks().agent.query(request,
        isMainSession(sessionId) ? { kind: 'main', cwd: workDirNow() ?? '' } : { taskId: sessionId }),
      taskAct: (request, sessionId) => actOnSchedule(request, sessionId),
      routing: {
        receive: request => requests.receive(request),
        decide: decision => requests.decide(decision),
        fail: failure => requests.fail(failure), noteFast: outcome => requests.noteFast(outcome), endTurn: turn => requests.endTurn(turn),
      },
      conversationContext: sessionId => {
        const context = sessions.context()
        return context.sessionId === sessionId ? context : { conversationId: null, sessionId }
      },
      topicOfConversation: (conversationId, sessionId) => {
        const saved = historyDb.topicOf(conversationId)
        if (saved) return saved
        const current = sessions.current()
        if (sessionId && current.sessionId === sessionId && current.id === conversationId) return sessions.topicId()
        return conversationId
      },
      emit: (event) => {
        if (!lifetime.isCurrent()) return
        // A task's result written (shown where it came), read (kept, then done) or lost (sent again), as said by the
        // session it was delivered to; said of another session, it is not this report's. Read but its record not kept
        // (the database busy): a pass now, which puts it off to try again.
        // ACP prompt submission can precede native inbox admission, especially for images.
        if (event.type === 'human_turn_running') return wakeEffects()
        if (event.type === 'report_written' || event.type === 'report_read' || event.type === 'report_dropped') {
          const reportId = String(event.reportId)
          const queued = effects?.get(REPORT, reportId) as Effect<ReportPayload> | null | undefined
          if (!queued || queued.payload.deliveredTo !== event.sessionId) return undefined
          if (event.type === 'report_dropped') return wakeEffects()
          foregroundRequests.reportWritten(reportId)
          try {
            return event.type === 'report_written' ? records.written(queued) : records.read(queued)
          } catch (err) {
            emitDiagnosticFailure('task.report', err)
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
        if (event.type === 'turn_stopping') { turn.stopping = true; retireForegroundRequests() }
        if (event.type === 'turn_end' && event.stopReason === 'cancel_unconfirmed') {
          const selected = sessions.current()
          if (selected.sessionId) {
            stoppedContext = sessions.context()
            try { historyDb.detachNativeSession(selected.id, selected.sessionId) }
            catch (error) { emitDiagnosticFailure('conversation.cancel', error, { stage: 'checkpoint' }) }
            sessions.select({ ...selected, sessionId: null })
          }
        }
        emitToRenderer(event)
        if (event.type === 'turn_end' || event.type === 'error') endRequests(event)
        if (event.type === 'turn_end') return signal({ kind: 'agent.turn_ended', stopReason: typeof event.stopReason === 'string' ? event.stopReason : undefined })
        if (event.type === 'error') finishForegroundTurn()
        return undefined
      },
      onExit: lifetime.onExit,
    })
  }

  /** The agent of the conversation on screen acting on schedules or answering a task's question (viva-tasks); a task's own session may not. */
  async function actOnSchedule(request: TaskChannelAction, sessionId: string) {
    if (sessionId !== lastInfo.sessionId || !isMainSession(sessionId)) throw new Error(t('main.tasks-channel.not.from.a.task'))
    const caller = sessions.context()
    const bridge = dsh.current
    if (request.op === 'answer_background_task') {
      if (!bridge) throw new Error(t('main.tasks-channel.task.queries.are.not.enabled.in.this'))
      const pending = bridge.taskWaits(request.taskId).questions.find(
        (item): item is { questionId: string, questions: Question[] } =>
          Boolean(item && typeof item === 'object'
            && (item as { questionId?: unknown }).questionId === request.questionId
            && Array.isArray((item as { questions?: unknown }).questions)),
      )
      if (!pending) throw new Error(t('main.tasks-channel.question.not.found'))
      const questions = pending.questions
      const checked = checkAnswers(questions, request.answers)
      if (dsh.current !== bridge || !sameContext(caller, sessions.context())) throw new Error(t('main.tasks-channel.not.from.a.task'))
      const slot = taskRuntime?.dsh.reserveWaitResume('answer', request.questionId)
      if (slot && 'problem' in slot) throw new Error(slot.problem)
      const keep = taskRuntime?.dsh.holdQuestion(request.questionId) ?? null
      let accepted = false
      try {
        accepted = await bridge.answerQuestion(request.questionId, checked, undefined, { recordMemory: false })
        if (!accepted) throw new Error(t('main.tasks-channel.question.not.found'))
        keep?.(checked)
        return { ok: true, taskId: request.taskId, questionId: request.questionId }
      } finally {
        if (!accepted) slot?.release()
      }
    }
    if (!schedules) throw new Error(t('main.tasks-channel.task.queries.are.not.enabled.in.this'))
    const project = projectScopeKey(workDirNow())
    const sameWorkspace = (schedule: { cwd: string }) => project !== 'unknown' && projectScopeKey(schedule.cwd) === project
    if (request.op === 'schedule_list') {
      const visible = new Set(schedules.store.list().filter(sameWorkspace).map(schedule => schedule.id))
      return schedules.list().filter(schedule => visible.has(schedule.id))
    }
    if (request.op === 'schedule_update' || request.op === 'schedule_delete') {
      const schedule = schedules.store.get(request.id)
      if (schedule && !sameWorkspace(schedule)) throw new Error(t('main.schedule-runs.memory.stale'))
    }
    return schedules.act(request, caller.conversationId, workDirNow() ?? '')
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
      emitDiagnosticFailure('task.route', err, { stage: 'settled' })
    }
  }

  function requireTasks(): TaskRuntime {
    if (!taskRuntime) throw new Error(t('main.tasks-channel.task.queries.are.not.enabled.in.this'))
    return taskRuntime
  }

  /**
   * Results of background tasks and due schedules, back in the conversation on screen (task-reports.ts): into the turn
   * running there, or as a turn of their own once nothing runs. The window is told such a turn began, as it is told
   * nothing else of it: no words of the user's.
   */
  function isForeignReport(taskId: string, reportCwd?: string | null) {
    const current = sessions.context().sessionId
    const task = reportCwd
      ? projectScopeKey(reportCwd)
      : (historyDb.nativeProject(taskId) ?? projectScopeKey(workspaceOfSession(taskId)))
    const target = (current && historyDb.nativeProject(current)) || projectScopeKey(workDirNow())
    return task !== target
  }
  const taskReports = createTaskReports({
    conversation: () => (!dsh.current || sessions.isChanging() || dsh.current.isSwitching() || dsh.isQuitting()
      ? 'away' : turn.active ? 'busy' : 'idle'),
    activeTurnId: () => (turn.active ? turn.id : null),
    typing: () => Boolean(host.window.composerTyping?.()),
    wakeLater: (ms) => scheduleReportWake(ms),
    session: () => dsh.current?.currentSession() ?? null,
    holds: (effect) => effects?.holds(effect) ?? false,
    opening: id => foregroundRequests.openingReports().includes(id),
    status: (session, reportId, token) => dsh.current?.reportStatus(session, reportId, token) ?? Promise.resolve('unavailable'),
    deliver: (session, reportId, token, text, taskId, held, cwd) => {
      if (isForeignReport(taskId, cwd)) foregroundHistory?.keepReplyInForeground(session)
      return dsh.current?.deliverReport(session, reportId, token, text, held) ?? Promise.resolve('unavailable')
    },
    // Where a report went is kept with it (task-reports.ts): only that session's word on it counts.
    amend: (effect, payload) => effects?.amend(effect, payload) ?? false,
    onRead: (effect) => {
      try {
        records.read(effect)
      } catch (err) {
        emitDiagnosticFailure('task.report', err, { stage: 'checkpoint' })
        throw err
      }
    },
    currentConversation: () => sessions.current().id,
    unsavedConversation: (sessionId) => {
      const selected = sessions.current()
      if (selected.sessionId !== sessionId || historyDb?.hasAnyConversation(selected.id)) return null
      return { ...selected, topicId: sessions.topicId() }
    },
    superseded: (taskId, runId) => isScheduleTaskId(taskId) ? false : (taskRuntime?.reports.superseded(taskId, runId) ?? false),
    report: async (note, reports, held) => {
      const agent = dsh.current
      if (!agent) return false
      const context = sessions.context()
      const reportTopicId = sessions.topicId()
      if (!context.sessionId) return false
      if (dsh.current !== agent || !sameContext(context, sessions.context()) || sessions.isChanging()
        || agent.isSwitching() || turn.active || !held()) return false
      const claim = foregroundRequests.reserveReport(reports.map(item => item.reportId))
      if (!claim) return false
      turn = { active: true, by: 'task', stopping: false, startedAt: Date.now(), id: randomUUID() }
      emitToRenderer({ type: 'turn_started', turnId: turn.id, by: 'task', context })
      if (reports.some(item => isForeignReport(item.taskId, item.cwd))) foregroundHistory?.keepReplyInForeground(context.sessionId)
      void agent.prompt(note, [], { request: false, threadId: reportTopicId, held: () => claim.current() && held() }).catch((err: Error) => {
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
    beforeRecord: (conversationId, reportId) => foregroundHistory ? foregroundHistory.beforeReportRecord(conversationId, reportId) : { ready: true },
  })
  /** Runs the effects due: after a change that queued one, and whenever the conversation may be free for them. */
  let reportWakeTimer: ReturnType<typeof setTimeout> | null = null
  const clearReportWake = () => { if (reportWakeTimer) { clearTimeout(reportWakeTimer); reportWakeTimer = null } }
  const wakeEffects = () => { clearReportWake(); void effects?.wake() }
  function scheduleReportWake(ms: number) {
    clearReportWake()
    reportWakeTimer = setTimeout(() => { reportWakeTimer = null; void effects?.wake() }, Math.max(1, ms))
    reportWakeTimer.unref?.()
  }

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

  async function startBridge({ carryHistory = false }: { carryHistory?: boolean } = {}): Promise<AgentInfo | null> {
    if (dsh.isQuitting()) return null
    const config = currentConfig()
    if (config.problem) {
      stoppedContext = null
      const info = setupInfo(config)
      emitToRenderer({ type: 'ready', info })
      return info
    }
    fs.mkdirSync(config.cwd, { recursive: true })
    const context = sessions.startingIn(config.cwd)
    carryHistory ||= stoppedContext !== null
    if (carryHistory || historyProject(sessions.current().id, sessions.current().sessionId) !== projectScopeKey(context.cwd)) context.resumeSessionId = null
    try {
      const started = await dsh.start({ config, ...context, carryHistory })
      return started ? lastInfo : null
    } catch (err) {
      emitDiagnosticFailure('startup', err)
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
    stoppedContext = null
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
      const selected = sessions.current(), context = rendererContext()
      const found = historyDb.getTail(selected.id, CONVERSATION_WINDOW_MESSAGES)
      const hiddenStreamKeys = found && found.offset > 0 ? historyDb.streamKeysBefore(selected.id, found.offset) : undefined
      // No await between the history read and publication cutoff: both share this boundary.
      const history = found ? { id: found.conversation.id, updatedAt: found.conversation.updatedAt,
        createdAt: found.conversation.createdAt, parentId: found.conversation.parentId,
        messages: found.messages, offset: found.offset, total: found.total, records: found.records, folds: historyDb.foldsOf(selected.id) } : null
      return { ...rendererStream.snapshot(selected.id, context, stoppedContext !== null, hiddenStreamKeys), context, history, stopUnconfirmed: Boolean(stoppedContext),
        activeTurn: turn.active && !stoppedContext ? { id: turn.id, by: turn.by, startedAt: turn.startedAt, stopping: turn.stopping } : null,
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
    ipcMain.handle('agent:prompt', (_event, text, images = [], operation, turnId) => {
      if (sessions.isChanging()) throw new Error(t("main.main.preparing.a.new.topic.please.wait"))
      // With pictures the words may be left out.
      const question = images?.length && text === '' ? '' : assertText(text, 'prompt', MAX_PROMPT_CHARS)
      const pictures = imagesForPrompt(imageStore, images)
      const imageRefs = checkImages(images) ?? []
      const agent = requireBridge()
      if (stoppedContext || agent.needsRecovery()) throw new Error(t('conversation.stop.unconfirmed'))
      // Mid-switch a question would go to the session being left, and be cut off when that one closes. The window
      // keeps sending off while it switches; this holds for every other way in (the desktop island) too.
      if (agent.isSwitching()) throw new Error(switchingMessage())
      const retrying = operation !== undefined && (pendingHumanPrompts.has(JSON.stringify(operation))
        || typeof operation === 'string' && !pictures.length && historyDb.promptDelivery(operation) === 'sent')
      // Following questions already shown while a turn ended register together
      // in FIFO order. A first delivery needs the host's definite not-sent receipt;
      // canonical replay arrays still undergo the owner's exact source checks.
      const following = foregroundRequests.busy() && (Array.isArray(operation) || typeof operation === 'string' && historyDb.promptDelivery(operation) === 'not-sent')
      if ((turn.active || foregroundRequests.busy()) && !foregroundRequests.deferred() && !retrying && !following) throw new Error(t('main.main.wait.for.this.turn.to.finish.before'))
      return sendHumanPrompt(question, pictures, operation, turnId, imageRefs)
    })
    /** Words said while a turn runs go to that turn; 'idle' when it has just ended, so the window asks them anew. */
    ipcMain.handle('agent:steer', async (_event, text, operation) => {
      const words = assertText(text, 'steer', MAX_PROMPT_CHARS)
      const deliveryId = operation ?? randomUUID()
      if (foregroundRequests.deferred() || pendingHumanPrompts.has(JSON.stringify(deliveryId)) || historyDb.promptDelivery(deliveryId) === 'sent') {
        const result = await sendHumanPrompt(words, [], deliveryId)
        return result?.accepted === false ? { ok: false, reason: 'unavailable', message: result.message, delivery: !closed ? historyDb.promptDelivery(deliveryId) ?? 'pending' as const
          : result.sourceIds.includes(deliveryId) ? 'not-sent' as const : 'pending' as const }
          : { ok: true, delivery: 'sent' as const }
      }
      if (historyDb.promptPending([deliveryId])) throw new Error(t('main.memory.change.pending'))
      const agent = requireBridge(), origin = sessions.context(), originTopicId = sessions.topicId(), generation = foregroundRequests.lease(), admitted = humanAdmission, originalTurn = turn
      historyDb.reservePromptDelivery([deliveryId])
      foregroundHistory?.userSteer({ text: words, sourceId: deliveryId })
      const selected = () => generation() && dsh.current === agent
        && !sessions.isChanging() && !agent.isSwitching() && sameContext(origin, sessions.context())
      const held = () => selected() && turn === originalTurn && turn.active && (!admitted || admitted.current())
      return deliverHumanSteer(words, deliveryId, agent, held, selected, undefined, originTopicId)
    })
    ipcMain.handle('agent:cancel', async (_event, target) => {
      const agent = dsh.current
      if (!agent || !sameContext(target, sessions.context())) return false
      if (turn.active && turn.id !== target.turnId) return false
      const queued = [...pendingHumanPrompts.values()].some(prompt => prompt.turnId === target.turnId
        && !prompt.started() && sameContext(target, prompt.context()))
      if (!turn.active && !queued) return false
      if (await agent.cancel(target.sessionId)) return true
      if (agent !== dsh.current || !sameContext(target, sessions.context()) || turn.active && turn.id !== target.turnId) return false
      retireForegroundRequests()
      if (turn.active) finishForegroundTurn()
      emitToRenderer({ type: 'turn_end', stopReason: 'cancelled', context: sessions.context() })
      return true
    })
    let foregroundRecovery: Promise<AgentInfo | null> | undefined
    ipcMain.handle('agent:recover', async () => {
      if (foregroundRecovery) return foregroundRecovery
      if (!stoppedContext && !dsh.current?.needsRecovery()) return lastInfo
      foregroundRecovery = (async () => {
        foregroundHistory?.flush()
        await stopBridge()
        return startBridge({ carryHistory: true })
      })()
      try { return await foregroundRecovery } finally { foregroundRecovery = undefined }
    })
    ipcMain.handle('agent:new-session', async () => {
      if (stoppedContext) throw new Error(t('conversation.stop.unconfirmed'))
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
      const slot = taskRuntime?.dsh.reserveWaitResume('permission', id)
      if (slot && 'problem' in slot) throw new Error(slot.problem)
      let accepted = false
      try {
        accepted = dsh.current?.respondPermission(id, option) ?? false
        return accepted
      } finally {
        if (!accepted) slot?.release()
      }
    })
    ipcMain.handle('agent:answer', async (_event, questionId, answers, operation) => {
      const id = assertText(questionId, 'questionId', 200)
      const slot = taskRuntime?.dsh.reserveWaitResume('answer', id)
      if (slot && 'problem' in slot) throw new Error(slot.problem)
      // Held first: dsh closes the question while it takes the answer, and what was asked goes with it.
      const keep = taskRuntime?.dsh.holdQuestion(id) ?? null
      let accepted = false
      let sourceIds: Readonly<Record<string, string>> | undefined
      try {
        accepted = await dsh.current?.answerQuestion(id, answers, operation, {
          onSourceIds: ids => { sourceIds = ids },
        }) ?? false
        if (accepted) keep?.(answers, sourceIds)
        return accepted
      } finally {
        if (!accepted) slot?.release()
      }
    })
    // Keys the user typed for a server the model set up: straight to the encrypted store, never to dsh.
    ipcMain.handle('agent:secrets', (_event, requestId, values) => {
      const id = assertText(requestId, 'requestId', 200)
      if (values !== null && (typeof values !== 'object' || Array.isArray(values))) throw new Error('invalid secrets')
      return dsh.current?.provideSecrets(id, values) ?? false
    })
  }

  async function deliverHumanSteer(words: string, deliveryId: string, agent: Bridge,
    held: () => boolean, selected: () => boolean, onDispatch?: () => void, threadId?: string): Promise<IpcResults['agent:steer']> {
    // A normally finished turn asks the renderer to resend as a new question;
    // cancellation or a replacement selection must never do so.
    const retiredReason = (): 'idle' | 'unavailable' => selected() ? 'idle' : 'unavailable'
    let dispatched = false
    try {
      const result = !held() ? { ok: false, reason: retiredReason(), delivery: 'not-sent' as const }
        : await agent.steer(words, deliveryId, held, retiredReason, () => { dispatched = true; onDispatch?.() }, threadId)
      if (!closed && (result.ok || result.reason === 'idle' || result.delivery === 'not-sent')) historyDb.settlePromptDelivery([deliveryId], result.ok)
      return { ...result, delivery: closed ? result.delivery ?? (result.ok ? 'sent' as const : 'pending' as const) : historyDb.promptDelivery(deliveryId) }
    }
    catch (error) {
      if (!dispatched && !closed) historyDb.settlePromptDelivery([deliveryId], false)
      return { ok: false, reason: 'unavailable', delivery: closed ? 'pending' as const : historyDb.promptDelivery(deliveryId),
        message: error instanceof Error ? error.message : String(error) }
    }
  }

  /** A retained prompt keeps its original selection and operation through a report turn. */
  function sendHumanPrompt(question: string, pictures: ReturnType<typeof imagesForPrompt>, operation: string | string[] = randomUUID(), turnId: string = randomUUID(), imageRefs: readonly ImageRef[] = []): Promise<IpcResults['agent:prompt']> {
    const agent = requireBridge()
    let origin = sessions.context()
    let originTopicId = sessions.topicId()
    const retained = foregroundRequests.deferred()
    const key = JSON.stringify(operation)
    const fingerprint = createHash('sha256').update(JSON.stringify({ origin, question, pictures })).digest('hex')
    const prior = pendingHumanPrompts.get(key)
    if (prior) return prior.fingerprint === fingerprint ? prior.promise
      : Promise.reject(new Error(t('main.memory.context.stale')))
    if (Array.isArray(operation) && !historyDb.matchesPromptText(operation, question)) {
      return Promise.reject(new Error(t('main.memory.context.stale')))
    }
    if (typeof operation === 'string' && historyDb.promptDelivery(operation) === 'not-sent'
      && !historyDb.matchesPromptText([operation], question)) {
      return Promise.reject(new Error(t('main.memory.operation.conflict')))
    }
    if (!pictures.length && typeof operation === 'string' && historyDb.promptDelivery(operation) === 'sent') {
      // The native steer may have acknowledged while this report is still running.
      return historyDb.matchesPromptText([operation], question) ? Promise.resolve(undefined)
        : Promise.reject(new Error(t('main.memory.context.stale')))
    }
    const sources = typeof operation === 'string' ? [operation] : [...operation]
    if (historyDb.promptPending(sources)) return Promise.reject(new Error(t('main.memory.change.pending')))
    // Pictures are already visible and saved while they wait for a separate turn; replay IDs belong to earlier messages.
    const userMessage = typeof operation === 'string'
    if (userMessage && foregroundHistory) {
      try {
        foregroundHistory.userPrompt({
          text: question,
          images: imageRefs,
          sourceId: operation,
          advanceCheckpoint: !turn.active && !foregroundRequests.busy(),
          strict: true,
        })
      } catch (error) {
        return Promise.reject(error)
      }
      emitToRenderer({ type: 'prompt_persisted', sourceId: operation, context: origin })
    }
    if (userMessage && origin.sessionId) records.beforeUser(foregroundRequests.openingReports(), origin.sessionId, operation)
    const interjectable = userMessage && !pictures.length
    historyDb.reservePromptDelivery(sources)
    let nativeStarted = false, deliveryError: unknown
    const generation = foregroundRequests.lease()
    const selected = () => generation() && dsh.current === agent && !sessions.isChanging() && !agent.isSwitching()
      && !dsh.isQuitting() && sameContext(origin, sessions.context())
    const promise = foregroundRequests.human(selected, async current => {
      const own = { turnId, started: false, delivered() {
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
        originTopicId = sessions.topicId()
        if (userMessage && origin.conversationId && origin.sessionId) {
          historyDb.rebindMessageSession(origin.conversationId, operation, origin.sessionId)
        }
      }, topicId: () => originTopicId }
      humanAdmission = own
      try {
        await signal({ kind: 'chat.said', text: question, images: pictures, operation })
        if (deliveryError) throw deliveryError
      }
      catch (error) {
        if (!own.started && !closed) historyDb.settlePromptDelivery(sources, false)
        if (retained && !own.started) return { accepted: false as const,
          sourceIds: closed ? sources.filter(id => knownUnsentPrompts.has(id)) : historyDb.promptUndelivered(sources),
          message: error instanceof Error && error.message ? error.message : t('app.your.message.did.not.reach.the.assistant') }
        throw error
      }
      finally { if (humanAdmission === own) humanAdmission = null }
    }, interjectable ? async held => {
      const result = await deliverHumanSteer(question, operation, agent, held, selected, () => { nativeStarted = true }, originTopicId)
      if (result.ok) return { result: undefined }
      if (result.delivery === 'not-sent') nativeStarted = false
      if (result.reason === 'idle' && result.delivery === 'not-sent' && selected()) {
        historyDb.reservePromptDelivery(sources)
        return null
      }
      return { result: { accepted: false as const, sourceIds: result.delivery === 'not-sent' ? sources : [],
        message: result.message ?? t(result.delivery === 'pending' ? 'app.message.delivery.unknown' : 'app.your.message.did.not.reach.the.assistant') } }
    } : undefined).catch((error: unknown) => {
      if (error instanceof ForegroundRequestRetired && !nativeStarted) {
        if (!closed) historyDb.settlePromptDelivery(sources, false)
        return { accepted: false as const, sourceIds: closed ? sources.filter(id => knownUnsentPrompts.has(id)) : historyDb.promptUndelivered(sources),
          message: t('app.your.message.did.not.reach.the.assistant') }
      }
      throw error
    })
    const pending = { fingerprint, turnId, context: () => origin, sources, started: () => nativeStarted, promise }
    pendingHumanPrompts.set(key, pending)
    void promise.finally(() => {
      if (pendingHumanPrompts.get(key) === pending) pendingHumanPrompts.delete(key)
      wakeEffects()
    }).catch(() => {})
    return promise
  }

  /** chat.said's route: the question goes to the conversation on screen. */
  async function sayInChat(question: string, pictures: ReturnType<typeof imagesForPrompt>, operation: string | string[] = randomUUID()) {
    const agent = requireBridge()
    const admission = humanAdmission
    const assertAdmitted = () => { if (admission && !admission.current()) throw new ForegroundRequestRetired() }
    assertAdmitted()
    const replay = Array.isArray(operation)
    const id = agent.currentSession()
    turn = { active: true, by: 'user', stopping: false, startedAt: Date.now(), id: admission?.turnId ?? randomUUID() }
    emitToRenderer({ type: 'turn_started', turnId: turn.id, by: 'user', context: sessions.context() })
    const carried = sessions.takeCarried()
    const inlined = !replay && question ? inlineAttachedFiles(question, file => droppedFiles.has(file)) : ''
    const held = admission ? () => admission.current() : undefined
    const words = [carried, inlined, question].filter(Boolean).join('\n\n')
    const failed = (error: unknown) => {
      if (admission && !admission.current()) throw error
      finishForegroundTurn()
      if (id !== agent.currentSession()) {
        emitToRenderer({ type: 'error', message: error instanceof Error ? error.message : String(error), context: sessions.context() })
        return
      }
      throw error
    }
    const snapshottedTopicId = admission?.topicId?.() ?? sessions.topicId()
    let started = false
    await agent.prompt(words, pictures, { userTurn: true, onStart: () => { started = true; admission?.delivered() },
      sourceId: typeof operation === 'string' ? operation : operation.length === 1 ? operation[0] : undefined, sourceText: question, threadId: snapshottedTopicId, held }).catch(failed)
    if (!started) throw new ForegroundRequestRetired()
  }

  /** Where each kind of signal goes (event-core.ts Routes): a route for every kind, or the type check fails. */
  function routeSignals(events: EventCore) {
    events.route({
      'chat.said': ({ text, images, operation }) => sayInChat(text, images as ReturnType<typeof imagesForPrompt>, operation),
      // A turn of the user's just ended: clear the turn's source bindings.
      'agent.turn_ended': () => {
        finishForegroundTurn()
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
    const previous = sessions.current()
    const projectChanged = historyProject(previous.id, previous.sessionId) !== projectScopeKey(dir)
    const info = projectChanged
      ? await sessions.withSelection(async ({ switchAgent, select }) => {
        const carried = await filteredCarry(previous.id, true, dir)
        const started = await switchAgent(null, dir)
        const next = historyDb.create({ sessionId: started.sessionId, mode: started.mode, model: started.model, cwd: started.cwd })
        select(next)
        await publishCarry(next, carried)
        return { ...started, conversationId: next.id, topicId: next.topicId ?? next.id, remembersHistory: false }
      })
      : await sessions.switchDirectory(dir)
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

  /** A completed schedule run: its full report for the main conversation and its system notice queued in the same change. */
  function queueScheduleDelivery(item: DeliveredScheduleRun) {
    if (!effects) throw new Error('the effects queue is not open yet')
    const taskId = scheduleTaskId(item.scheduleId)
    const bounded = boundScheduleRecordOutput(item.body)
    const report: ReportPayload = {
      taskId,
      runId: item.key,
      title: item.title,
      status: item.status,
      host: null,
      cwd: item.cwd,
      output: bounded.text,
      ...(bounded.truncated ? { outputTruncated: true } : {}),
      token: randomUUID().replaceAll('-', ''),
      request: item.prompt.slice(0, REQUEST_CHARS),
      topic: null,
      startedAt: null,
      by: 'schedule',
    }
    effects.queue(REPORT, reportId(taskId, item.key), report, Date.now() + GATHER_MS)
    effects.queue(SCHEDULE_NOTICE, `${item.scheduleId}:${item.key}`, {
      title: item.title,
      body: item.body.slice(0, NOTICE_BODY_CHARS),
    })
  }

  /** A schedule's prompt run in its own folder; one whose folder is gone fails without leaking host paths to the model. */
  async function runSchedule(prompt: string, cwd: string): Promise<RunResult> {
    if (!isFolder(cwd)) return { ok: false, problem: t('main.schedule-runs.folder.gone') }
    return unattended.run(prompt, cwd)
  }

  function registerPersonalIpc(config: Config) {
    registerRuntimeMemoryIpc(ipcMain, {
      client: memory,
      sourceLink: historyDb.sourceLink,
      habits: () => activeHours(historyDb.questionTimes()),
      cwd: () => config.cwd,
      chooseDocs: () => host.dialogs.chooseFiles({ title: t("main.main.choose.reference.documents"), multiple: true }),
    })
    registerModelsIpc(ipcMain, { store: modelStore, restart: restartKeepingConversation })
    // The 插件 section: dsh's plugin manager, inside the running dsh (viva-plugins); nothing to ask while it is down.
    const pluginProfileDir = () => path.join(dshHomeOf(config), 'profiles', DSH_PROFILE)
    registerPluginsIpc(ipcMain, {
      call: (op, args) => (dsh.current ? dsh.current.plugins(op, args) : Promise.resolve({ ok: false as const, problem: 'disconnected' })),
      profileDir: pluginProfileDir,
      source: pluginSource,
      busy: () => turn.active,
      restart: restartKeepingConversation,
      specFit: (spec, registry) => {
        const call = pluginPnpm?.call ?? null
        const pnpm = call && registry && !pluginPnpm?.registry ? { ...call, args: [...call.args, `--registry=${registry}`] } : call
        return specFit({ spec, pnpm, run: runPnpm, fitOptions: profileFitOptions(pluginProfileDir()) })
      },
      // Only a company source is searched: the public registries are not a catalog of dsh plugins.
      catalog: (query) => searchCatalog({ query, pnpm: pluginPnpm?.registry ? pluginPnpm.call : null, run: runPnpm, fitOptions: profileFitOptions(pluginProfileDir()) }),
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

  function openPersonal(config: Config) {
    try {
      traceDb = openTraceDb({ file: path.join(userData, 'trace.db') })
    } catch (err: any) {
      emitDiagnosticFailure('storage', err, { stage: 'recovering' })
    }
    mcpStore = createMcpConfigStore({ file: path.join(userData, 'mcp-servers.json'), crypto: host.secrets, onError: (err) => emitDiagnosticFailure('mcp', err) })
    personal = createPersonal({ historyDb, mcpStore })
    registerPersonalIpc(config)
    const schedulesChanged = () => emitToRenderer({ type: 'schedules_changed' })
    schedules = createSchedules({ db: appDb.db, apply: applyChange, emit: event => emitToRenderer({ ...event, context: sessions.context() }),
      changed: () => { scheduleRuns?.wake(); schedulesChanged() } })
    scheduleRuns = createScheduleRuns({
      db: appDb.db,
      apply: applyChange,
      store: schedules.store,
      run: runSchedule,
      keep: queueScheduleDelivery,
      // Kept: its report and notice go out through the effects queue.
      delivered: wakeEffects,
      changed: schedulesChanged,
      onError: (err) => emitDiagnosticFailure('schedule', err),
    })
    registerSchedulesIpc(ipcMain, () => schedules)
    if (effects) {
      migrateLegacyFeed({
        db: appDb.db,
        apply: applyChange,
        effects,
        scheduleCwd: (id) => schedules?.store.get(id)?.cwd ?? null,
        scheduleConversationId: (id) => schedules?.store.get(id)?.conversationId ?? null,
        hasRecord: (key) => historyDb.hasRecord(key),
        hasConversation: (id) => historyDb.hasConversation(id),
        addRecord: (record) => historyDb.addRecord(record),
        archiveItems: (items) => historyDb.archiveLegacyFeed(items),
      })
    }
  }

  /** The agent's side of background tasks. */
  const taskAgent = {
    closeTask: (taskId: string) => dsh.current?.closeTask(taskId),
    cancelTask: (taskId: string) => dsh.current?.cancelTask(taskId),
    steerTask: (taskId: string, text: string, meta?: TaskDispatchMeta) => requireBridge().steerTask(taskId, text, meta),
    resumeTask: (request: Parameters<Bridge['resumeTask']>[0]) => (dsh.current ? dsh.current.resumeTask(request) : { ok: false, reason: 'unavailable' }),
    async startTask() {
      const agent = dsh.current
      const source = agent?.currentSession()
      if (!agent || !source || sessions.isChanging()) return { ok: false, reason: 'unavailable' }
      return agent.startTask()
    },
    promptTask: (taskId: string, text: string, meta?: TaskDispatchMeta, images?: ReadonlyArray<{ data: string, mimeType: string }>) =>
      dsh.current?.promptTask(taskId, text, meta, images),
  }

  /** Opens the database and drops conversations whose undo window has passed. */
  function openHistory(config: Config) {
    historyDb = journaled(openHistoryDb({ db: appDb.db }), 'history', HISTORY_WRITES, applyChange)
    historyDb.purgeDeleted({ olderThanMs: 0, pruneTombstones: false })
    sessions.open(config.cwd)
    foregroundHistory = createForegroundHistory({
      commit: historyDb.commit,
      current: sessions.current,
      setCurrent: sessions.select,
      agentInfo: () => lastInfo,
      sourceSession: () => rendererContext().sessionId,
      streamCursor: () => rendererStream.cursor(),
      messageCount: id => historyDb.messageCount(id),
      checkpoint: (conversationId, upToCursor) => rendererStream.checkpoint(conversationId, upToCursor),
      markQuestionPersisted: (conversationId, questionId) => rendererStream.markQuestionPersisted(conversationId, questionId),
      markPlainPersisted: (conversationId, upToCursor) => rendererStream.markPlainPersisted(conversationId, upToCursor),
      markStreamPersisted: (conversationId, key, upToCursor) => rendererStream.markStreamPersisted(conversationId, key, upToCursor),
      delegatedDuringTurn: (startedAt, endedAt) => {
        const list = (taskStore?.list() ?? []).filter(task => task.status !== 'interrupted'
          && typeof task.startedAt === 'number' && task.startedAt >= startedAt)
        if (!list.length) return false
        if (list.some(task => task.status === 'running' || task.status === 'waiting' || task.endedAt === undefined || task.endedAt === null)) {
          return true
        }
        const recordsList = historyDb.recordTimesOf(sessions.current().id)
        return list.some(task => !recordsList.some(record => record.reportId === `${task.id}:${task.runId}` && record.at <= endedAt))
      },
      onPendingDrained: () => wakeEffects(),
      onError: err => emitDiagnosticFailure('storage', err, { stage: 'checkpoint' }),
    })
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
      selectSession: sessions.withSelection,
      chooseExportPath,
      isBusy: () => turn.active,
      filteredCarry,
      publishCarry,
      folderExists: (dir) => isFolder(dir),
      workDir: () => workDirNow() ?? null,
      retainTombstones: () => (effects?.listByKind<ReportPayload>(REPORT) ?? [])
        .map((effect) => effect.payload.deliveredConversation?.id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    })
    registerRewindIpc(ipcMain, {
      db: historyDb,
      current: sessions.current,
      isBusy: () => turn.active,
      agentInfo: () => lastInfo,
      selectSession: sessions.withSelection,
      traceDb: () => traceDb,
      readNativeTrace,
      apply: applyChange,
      rebuild: async (previous, kept) => {
        const project = historyProject(previous.id, previous.sessionId)
        if (project !== projectScopeKey(previous.cwd)) return null
        const current = historyDb.get(previous.id)?.messages.slice(0, kept.length) ?? []
        const rows = current.flatMap((row, index) => row.role === 'user' && row.sourceId && row.sourceId === kept[index]?.sourceId
          ? [{ ...row, segmentId: previous.id }] : [])
        const allowed = historyForProject(project)
        return carriedRecords(rows.filter(allowed))
      },
      publishCarry,
    })
    // Tasks still going, kept so the next launch can offer to take them up (dsh ends with the app). Only the task
    // runtime writes them, each change with its event (task.started, task.ended, …).
    taskStore = createTaskStore({ db: appDb.db,
      onError: (err) => emitDiagnosticFailure('task', err) })
    effects = createEffects({ db: appDb.db, apply: applyChange, onError: (err) => emitDiagnosticFailure('effects', err) })
    effects.runs(REPORT, taskReports)
    // A completed schedule run's notification (schedule-runs.ts): handed to the desktop, done.
    effects.runs(SCHEDULE_NOTICE, async (queued) => {
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
      effects,
    })
    registerTaskIpc(ipcMain, taskRuntime.window)
    // The main conversation's requests: each decision's task actions go to the task runtime. A task starts from the
    // conversation on screen (task-runtime.ts), so only while that is still the request's: a decision outliving its
    // turn (stopped meanwhile) must not start its remaining work in another conversation. The main conversation can
    // inspect, message and stop any of its background tasks regardless of working directory.
    const tasks = taskRuntime.agent
    const visible = (taskId: string, cwd: string | null) => { tasks.query({ op: 'get', taskId }, { kind: 'main', cwd: cwd ?? '' }) }
    function requestEvidence(place: RequestPlace) {
      const bridge = dsh.current
      const here = () => {
        const selected = sessions.current()
        return bridge === dsh.current && selected.id === place.conversationId && selected.sessionId === place.sessionId
      }
      if (!here()) throw new Error(t('main.requests.start.elsewhere'))
    }
    const admitTask = (place: RequestPlace) => () => {
      const selected = sessions.current()
      return selected.sessionId === place.sessionId && selected.id === place.conversationId
    }
    const taskImages = (refs: readonly ImageRef[] | undefined) => {
      if (!refs?.length) return undefined
      if (!requireBridge().canReadImages()) throw new Error(t('main.acp-bridge.this.model.cannot.read.images.among.deepseek'))
      return { refs, payloads: imagesForPrompt(imageStore, refs) }
    }
    requests = createRequestRuntime({
      store: createRequestStore({ db: appDb.db }),
      apply: applyChange,
      tasks: {
        start: async ({ title, brief }, place) => {
          requestEvidence(place)
          return tasks.start(brief, title, admitTask(place), taskImages(place.images))
        },
        message: async (taskId, text, place) => {
          requestEvidence(place)
          visible(taskId, place.cwd)
          return tasks.message(taskId, text, admitTask(place), taskImages(place.images))
        },
        stop: async (taskId, place) => {
          requestEvidence(place)
          visible(taskId, place.cwd)
          return tasks.stop(taskId)
        },
      },
    })
    const recovered = requests.recover()
    if (recovered.uncertain) emitDiagnostic({ event: 'operation.progress', operation: 'task.route', stage: 'recovering', metrics: { pendingCount: recovered.uncertain } })
  }

  /** Opens the stores and registers the backend's channels, before the window loads. */
  function open() {
    appDb = openAppDb({ file: path.join(userData, 'app.db') })
    rendererStream = createRendererStream(host.window.send, appDb.db)
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
    defaultWorkspace = config.cwd
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
    scheduleRuns?.close()
    foregroundHistory?.flush()
    foregroundHistory?.close()
    taskRuntime?.dispose()
    historyDb?.close()
    appDb?.close()
    effects?.close()
    traceDb?.close()
  }

    onLocaleChange(() => {
    SETUP_MESSAGES = setupMessages()
  })
  const droppedFiles = createDroppedFileRegistry()

  return {
    open,
    startBridge,
    allowDroppedFiles(raw: unknown) {
      if (!Array.isArray(raw)) return
      droppedFiles.allow(raw.filter((item): item is string => typeof item === 'string'))
    },
    /** One input from the shell (the window came to the front, the computer woke): recorded, then routed. */
    signal,
    /** The stored events after `seq`, for a shell that missed them (event-core.ts). */
    since: (seq: number) => core?.since(seq) ?? [],
    settingsView,
    preferences: () => preferences,
    images: () => imageStore,
    agentPid: () => dsh.current?.pid() ?? null,
    memoryOwnerPid: () => dsh.current?.memoryOwnerPid() ?? null,
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
    /** Quitting stops dsh and its supervised child memory worker. */
    async stop() {
      clearReportWake()
      await dsh.stopWithin()
    },
    wakeReports: wakeEffects,
    close: () => { clearReportWake(); close() },
  }
}

export type Backend = ReturnType<typeof createBackend>

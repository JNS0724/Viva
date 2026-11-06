import { createDshLifecycle, type DshLifetime } from './dsh-lifecycle.ts'
import { createConversationSession } from './conversation-session.ts'
import { createConfigActions } from './config-actions.ts'
import { createSchedules, type Schedules } from './schedules.ts'
import { createScheduleRuns, type ScheduleRuns } from './schedule-runs.ts'
import { createUnattendedRuns, type RunResult, type TaskEvent } from './unattended-runs.ts'
import { FEED_WRITES, openFeedStore, type FeedItem, type FeedStore } from './feed-store.ts'
import { onLocaleChange } from '../shared/i18n/locale.ts'
import { t } from '../shared/i18n/translate.ts'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MAX_MESSAGE_CHARS as MAX_PROMPT_CHARS } from '../shared/text-limits.ts'
import { openMemoryDb } from '../../plugins/memory/lib/store.ts'
import { openTraceDb } from '../../plugins/trace/lib/store.ts'
import { registerLanguageIpc } from './language-ipc.ts'
import { DEFAULT_PERMISSION, installedDshVersion, PERMISSION_LEVELS, PERSONA, resolvePlugins } from './app-plugins.ts'
import { APP_ROOT, CODE_ROOT } from '../shared/node/app-roots.ts'
import { DSH_PROFILE, resolveConfig } from './config.ts'
import { createAcpBridge, switchingMessage } from './acp-bridge.ts'
import { importDshServers, userDshHome } from './dsh-mcp-import.ts'
import { ensureDshProfile, vivaLayerFile } from './dsh-profile.ts'
import { pnpmLauncher } from './pnpm-launcher.ts'
import { dshEnv } from './dsh-runtime.ts'
import { registerExtensionsIpc } from './extensions-ipc.ts'
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
import { registerMemoryIpc } from './memory-ipc.ts'
import { createModelStore, defaultModel, modelValue, parseModelValue, piAiProviders, providerEnv } from './model-providers.ts'
import { registerModelsIpc } from './models-ipc.ts'
import { createPersonal } from './personal.ts'
import { createPreferences } from './preferences.ts'
import { CONFIG_IDS } from './session-info.ts'
import { createSettingsStore, keyHint } from './settings-store.ts'
import { skillRoots } from './skills.ts'
import { historyRecall } from './history-recall.ts'
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
/** After a turn the memory plugin's background pass may still write; look again this often, this long. */
const LATE_MEMORY_POLL_MS = 2_000
const LATE_MEMORY_WINDOW_MS = 30_000
/** How much of a 动态 item a notification shows. */
const NOTICE_BODY_CHARS = 200
/** The effects queue's kind for a new 动态 item's notification. */
const FEED_NOTICE = 'feed-notice'
/** How many 动态 items the window is given, the latest first. */
const FEED_LISTED = 100

type HistoryDb = ReturnType<typeof openHistoryDb>
type Bridge = ReturnType<typeof createAcpBridge>
type AgentInfo = { mode: string, model: string, cwd: string, reason?: string, [field: string]: any }

/** The writes of the stores on the app database, each recorded with its event (journal.ts). */
const HISTORY_WRITES = Object.freeze(['save', 'addRecord', 'moveRecords', 'rename', 'setPinned', 'softDelete', 'restore', 'purgeDeleted', 'fold', 'unfold', 'setStar'] as const)
/** The user's own changes on the 关于你 page; what the agent saves is recorded when the app reads it (memory.learned). */
const MEMORY_WRITES = Object.freeze(['setProfile', 'addMemory', 'updateMemory', 'deleteMemory', 'restoreMemory', 'reviveMemory', 'setOnboarding'] as const)

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
  let memoryDb!: ReturnType<typeof openMemoryDb>
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
  /** Habits, turn reports and the user's MCP servers; memory itself is the dsh plugin. See personal.ts. */
  let personal!: ReturnType<typeof createPersonal>
  /** When the running dsh was launched: the memory plugin must have started after it to count as working. */
  let launchedAt = 0
  /** The turn in progress: memories the agent saves during it are reported when it ends. */
  let turn = { active: false, startedAt: 0 }
  let lateMemoryTimer: ReturnType<typeof setInterval> | undefined
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

  type DshContext = { config: Config, cwd: string, resumeSessionId: string | null }
  const dsh = createDshLifecycle({
    create: ({ config, cwd }: DshContext, lifetime) => {
      launchedAt = Date.now()
      return createBridge(config, cwd, lifetime)
    },
    connect: (instance: Bridge, context: DshContext) => instance.start({ resumeSessionId: context.resumeSessionId }),
    onReady: (started, context) => {
      const info = sessions.ready(started, context.cwd)
      emitToRenderer({ type: 'ready', info })
      wakeEffects()
      scheduleRuns?.wake()
    },
    onGone: () => {
      taskRuntime?.dsh.gone(); unattended.gone()
      // Retired generations cannot deliver a final error/turn_end. Settle the foreground here too,
      // including deliberate model/key restarts, before publishing the replacement's readiness.
      if (turn.active) {
        emitToRenderer({ type: 'turn_end', stopReason: 'cancelled' })
        reportTurnMemories()
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

  /** Tells the window what the agent remembered or replaced, and what background the plugin sent. */
  function reportMemoryChanges(segment = sessions.current()) {
    try {
      const report = personal.collect({ conversationId: segment.id, sessionId: segment.sessionId })
      if (report?.memories.length || report?.invalidated.length) {
        // What the agent wrote, through the plugin in dsh: recorded here once the app has read it.
        applyChange('memory.learned', { memories: report.memories.length, invalidated: report.invalidated.length }, () => undefined)
        emitToRenderer({ type: 'memory_changed', memories: report.memories, invalidated: report.invalidated })
      }
      if (report?.injected.length) emitToRenderer({ type: 'memory_context', injected: report.injected })
    } catch (err: any) {
      console.error('[memory] could not read what was saved or sent:', err.message)
    }
  }

  /** At a turn's end, and for a while after it, since the background pass finishes later. */
  function reportTurnMemories() {
    if (!turn.active) return
    turn = { ...turn, active: false }
    const segment = sessions.current()
    reportMemoryChanges(segment)
    clearInterval(lateMemoryTimer)
    const until = Date.now() + LATE_MEMORY_WINDOW_MS
    lateMemoryTimer = setInterval(() => {
      // Memory claiming has a global watermark. Never let an old turn's poll claim a new
      // topic's writes, or writes made while the next foreground turn is still running.
      const current = sessions.current()
      if (current.id !== segment.id || current.sessionId !== segment.sessionId || turn.active) {
        clearInterval(lateMemoryTimer); return
      }
      reportMemoryChanges(segment)
      if (Date.now() >= until) clearInterval(lateMemoryTimer)
    }, LATE_MEMORY_POLL_MS)
  }

  /** The permission level picked; one no longer offered (an older or edited file) reads as the default. */
  const permissionNow = () => (PERMISSION_LEVELS.includes(preferences.get().permission) ? preferences.get().permission : DEFAULT_PERMISSION)

  /**
   * Writes the app's dsh profile: the persona and the plugins that pass the compatibility check, in the app's layer
   * given to dsh over the profile (dsh-profile.ts). Without it dsh still runs on its stock profile, with no memory,
   * trace or policy, and without the app's layer.
   */
  function prepareProfile(config: Config): { profile: string, overlay: string | null } {
    try {
      const { plugins, problems } = resolvePlugins({ codeRoot: CODE_ROOT, userData, dshVersion: installedDshVersion(APP_ROOT), permission: permissionNow() })
      pluginProblems = problems
      problems.forEach(({ name, problem }) => console.error(`[plugins] ${name} left out: ${problem}`))
      const pnpmCommand = pnpmLauncher({ dir: path.join(userData, 'bin'), appRoot: APP_ROOT, runtime: config.runtime })
      ensureDshProfile({ dshHome: dshHomeOf(config), profile: DSH_PROFILE, plugins, persona: PERSONA, models: profileModels(config), imagesDir: imagesDir(), pnpmCommand })
      return { profile: DSH_PROFILE, overlay: vivaLayerFile(dshHomeOf(config)) }
    } catch (err: any) {
      console.error('[plugins] could not prepare the dsh profile, starting without the app plugins:', err.message)
      return { profile: FALLBACK_PROFILE, overlay: null }
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
      .then((info) => info && emitToRenderer({ type: 'config', info }))
      .catch((err) => console.error('[mcp] could not reattach the session after a change:', err.message))
      // A task's result held back while the session was reattached comes back now.
      .finally(wakeEffects)
  }

  /** Events from a replaced bridge are dropped so a restart can't leak into the new conversation. */
  function createBridge(config: Config, cwd: string, lifetime: DshLifetime) {
    return createAcpBridge({
      prewarmSessions: true,
      dshBin: config.dshBin,
      nodeBin: config.nodeBin,
      ...prepareProfile(config),
      cwd,
      env: dshEnv({ base: process.env, dshHome: dshHomeOf(config), runtime: config.runtime, settings: dshSettings(config) }),
      mcpServers: () => personal.mcpServers(),
      configActions: configActions(config),
      historySearch: (query, range) => (historyDb ? historyRecall(historyDb).search(query, range) : []),
      historyRead: (ref, around) => (historyDb ? historyRecall(historyDb).read(ref, around) : { status: 'deleted' as const }),
      taskRead: (request, sessionId) => requireTasks().agent.query(request, sessionId === lastInfo.sessionId ? { cwd: workDirNow() ?? '' } : { taskId: sessionId }),
      taskAct: (request, sessionId) => actOnTask(request, sessionId),
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
        if (event.type === 'turn_end') return signal({ kind: 'agent.turn_ended' })
        if (event.type === 'error') reportTurnMemories()
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
    if (request.op.startsWith('schedule_')) {
      if (!schedules) throw new Error(t('main.tasks-channel.task.queries.are.not.enabled.in.this'))
      return schedules.act(request as ScheduleAction, sessions.current().id, workDirNow() ?? '')
    }
    const tasks = requireTasks().agent
    if (request.op !== 'start' && request.op !== 'stop' && request.op !== 'message') throw new Error(t('main.task-registry.unknown.task.query.operation'))
    if (request.op === 'start') return tasks.start(request.brief)
    tasks.query({ op: 'get', taskId: request.taskId }, { cwd: workDirNow() ?? '' })
    if (request.op === 'stop') return tasks.stop(request.taskId)
    return tasks.message(request.taskId, request.text)
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
    conversation: () => (!dsh.current || sessions.isChanging() || dsh.current.isSwitching() || dsh.isQuitting() ? 'away' : turn.active ? 'busy' : 'idle'),
    session: () => dsh.current?.currentSession() ?? null,
    holds: (effect) => effects?.holds(effect) ?? false,
    status: (session, reportId, token) => dsh.current?.reportStatus(session, reportId, token) ?? Promise.resolve('unavailable'),
    deliver: (session, reportId, token, text) => dsh.current?.deliverReport(session, reportId, token, text) ?? Promise.resolve('unavailable'),
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
    superseded: (taskId, runId) => taskRuntime?.reports.superseded(taskId, runId) ?? false,
    report: (note) => {
      const agent = dsh.current
      if (!agent) return false
      turn = { active: true, startedAt: Date.now() }
      emitToRenderer({ type: 'turn_started', by: 'task' })
      agent.prompt(note).catch((err: Error) => {
        turn = { ...turn, active: false }
        emitToRenderer({ type: 'error', message: err.message })
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
  const setupInfo = (config: Config) => ({ mode: 'setup', problem: config.problem, cwd: config.cwd, model: '', models: [], efforts: [], reason: '' })
  const setupMessages = (): Readonly<Record<string, string>> => ({ 'no-key': t("main.main.enter.a.deepseek.api.key.or.add"), 'no-dsh': t("main.main.deepseek.harness.not.found.run.npm.install") })
  let SETUP_MESSAGES = setupMessages()

  function requireBridge() {
    if (!dsh.current) throw new Error(SETUP_MESSAGES[lastInfo.problem] ?? t("main.main.the.assistant.is.not.connected.yet"))
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
      emitToRenderer({ type: 'waits', ...(dsh.current?.sessionWaits() ?? { permissions: [], questions: [], secrets: [] }) })
      return true
    })
    ipcMain.handle('agent:prompt', (_event, text, images = []) => {
      if (sessions.isChanging()) throw new Error(t("main.main.preparing.a.new.topic.please.wait"))
      // With pictures the words may be left out.
      const question = images?.length && text === '' ? '' : assertText(text, 'prompt', MAX_PROMPT_CHARS)
      const pictures = imagesForPrompt(imageStore, images)
      const agent = requireBridge()
      // Mid-switch a question would go to the session being left, and be cut off when that one closes. The window
      // keeps sending off while it switches; this holds for every other way in (the desktop island) too.
      if (agent.isSwitching()) throw new Error(switchingMessage())
      return signal({ kind: 'chat.said', text: question, images: pictures })
    })
    /** Words said while a turn runs go to that turn; 'idle' when it has just ended, so the window asks them anew. */
    ipcMain.handle('agent:steer', (_event, text) => {
      const words = assertText(text, 'steer', MAX_PROMPT_CHARS)
      if (!turn.active) return { ok: false, reason: 'idle' }
      return requireBridge().steer(words)
    })
    ipcMain.handle('agent:cancel', () => dsh.current?.cancel())
    ipcMain.handle('agent:new-session', sessions.newTopic)
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
    ipcMain.handle('agent:answer', (_event, questionId, answers) => {
      const id = assertText(questionId, 'questionId', 200)
      // Held first: dsh closes the question while it takes the answer, and what was asked goes with it.
      const keep = taskRuntime?.dsh.holdQuestion(id) ?? null
      const accepted = dsh.current?.answerQuestion(id, answers) ?? false
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
  function sayInChat(question: string, pictures: ReturnType<typeof imagesForPrompt>) {
    const agent = requireBridge()
    try {
      personal.habits()
    } catch (err: any) {
      console.error('[memory] could not update the habits:', err.message)
    }
    turn = { active: true, startedAt: Date.now() }
    // A topic gone on from its saved records (history-ipc.ts continue-from-records): they go with the first question,
    // as background only; the window shows (and the history keeps) the question as it was typed.
    const carried = sessions.takeCarried()
    return agent.prompt(carried ? `${carried}\n\n${question}` : question, pictures)
  }

  /** Where each kind of signal goes (event-core.ts Routes): a route for every kind, or the type check fails. */
  function routeSignals(events: EventCore) {
    events.route({
      'chat.said': ({ text, images }) => sayInChat(text, images as ReturnType<typeof imagesForPrompt>),
      // A turn of the user's just ended: memories saved in it are reported.
      'agent.turn_ended': () => {
        reportTurnMemories()
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
    const connected = Boolean(dsh.current)
    const info = await sessions.switchDirectory(dir)
    if (connected) emitToRenderer({ type: 'workdir', cwd: dir, info })
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
    const info = await dsh.current.reloadSession()
    lastInfo = { ...lastInfo, ...info, remembersHistory: info.resumed || lastInfo.remembersHistory }
    return lastInfo
  }

  /** 动态 changed: the window shows it, the tray counts what is new. */
  function feedChanged() {
    host.window.setPending(feed?.list().filter((item) => item.seenAt === null).length ?? 0)
    emitToRenderer({ type: 'feed_changed' })
  }

  /** A new item in 动态: its notification queued in the change that made it, so a quit before it goes loses nothing. */
  function queueFeedNotice(item: FeedItem) {
    if (!effects) throw new Error('the effects queue is not open yet')
    effects.queue(FEED_NOTICE, item.id, { title: item.title, body: item.body.slice(0, NOTICE_BODY_CHARS) })
  }

  /** A schedule's prompt run in its own folder; one whose folder is gone fails, saying so. */
  function runSchedule(prompt: string, cwd: string): Promise<RunResult> {
    if (!isFolder(cwd)) return Promise.resolve({ ok: false, problem: t('main.schedule-runs.folder.gone', { cwd }) })
    return unattended.run(prompt, cwd)
  }

  function registerPersonalIpc(config: Config) {
    registerMemoryIpc(ipcMain, {
      // The memory plugin's file, not the app database: each write's event follows once the write is in.
      db: journaled(memoryDb, 'memory', MEMORY_WRITES, applyChange),
      habits: () => personal.habits(),
      cwd: () => config.cwd,
      chooseDocs: () => host.dialogs.chooseFiles({ title: t("main.main.choose.reference.documents"), multiple: true }),
    })
    registerModelsIpc(ipcMain, { store: modelStore, restart: restartKeepingConversation })
    // The 插件 section: dsh's plugin manager, inside the running dsh (viva-plugins); nothing to ask while it is down.
    registerPluginsIpc(ipcMain, {
      call: (op, args) => (dsh.current ? dsh.current.plugins(op, args) : Promise.resolve({ ok: false as const, problem: 'disconnected' })),
      profileDir: () => path.join(dshHomeOf(config), 'profiles', DSH_PROFILE),
    })
    registerExtensionsIpc(ipcMain, {
      store: mcpStore,
      roots: () => skillRoots({ dshHome: dshHomeOf(config), cwd: workDirNow() ?? config.cwd }),
      mcpStatus: () => ({ ...personal.mcpStatus(lastInfo, launchedAt), plugins: pluginProblems }),
      applyMcp: applyMcpChange,
      trash: (file) => host.shell.trash(file),
      dshDirs: () => ({ defaultDir: userDshHome(), lastDir: preferences.get().dshImportDir }),
      chooseDshDir,
      importDsh,
      rememberDshDir: (dir) => preferences.set('dshImportDir', dir),
    })
  }

  /** Profile and memories live next to the history; the memory plugin inside dsh opens the same file. */
  function openPersonal(config: Config) {
    memoryDb = openMemoryDb({ file: path.join(userData, 'memory.db') })
    try {
      traceDb = openTraceDb({ file: path.join(userData, 'trace.db') })
    } catch (err: any) {
      console.error('[trace] could not open trace.db; reopened conversations fall back to dsh logs:', err.message)
    }
    mcpStore = createMcpConfigStore({ file: path.join(userData, 'mcp-servers.json'), crypto: host.secrets, onError: (err) => console.error('[mcp]', err.message) })
    personal = createPersonal({ memoryDb, historyDb, mcpStore })
    registerPersonalIpc(config)
    const schedulesChanged = () => emitToRenderer({ type: 'schedules_changed' })
    schedules = createSchedules({ db: appDb.db, apply: applyChange, emit: emitToRenderer, changed: () => { scheduleRuns?.arm(); schedulesChanged() } })
    // A schedule's run adds its item inside its own change (schedule.ran); the window's writes are events of their own.
    const items = openFeedStore({ db: appDb.db })
    feed = journaled(items, 'feed', FEED_WRITES, applyChange)
    scheduleRuns = createScheduleRuns({
      db: appDb.db,
      apply: applyChange,
      store: schedules.store,
      feed: items,
      run: runSchedule,
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
    startTask: (request: Parameters<Bridge['startTask']>[0]) => (dsh.current && !sessions.isChanging() ? dsh.current.startTask(request) : { ok: false, reason: 'unavailable' }),
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
      isBusy: () => turn.active,
      folderExists: (dir) => isFolder(dir),
      workDir: () => workDirNow() ?? null,
      carryNext: sessions.carryNext,
    })
    registerRewindIpc(ipcMain, {
      db: historyDb,
      current: sessions.current,
      isBusy: () => turn.active,
      agentInfo: () => lastInfo,
      selectSession: sessions.withSelection,
      traceDb: () => traceDb,
    })
    // Tasks still going, kept so the next launch can offer to take them up (dsh ends with the app). Only the task
    // runtime writes them, each change with its event (task.started, task.ended, …).
    taskStore = createTaskStore({ db: appDb.db, onError: (err) => console.error('[tasks]', err.message) })
    effects = createEffects({ db: appDb.db, apply: applyChange, onError: (err) => console.error('[effects]', err instanceof Error ? err.message : String(err)) })
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
    clearInterval(lateMemoryTimer)
    scheduleRuns?.close()
    historyDb?.close()
    appDb?.close()
    memoryDb?.close()
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

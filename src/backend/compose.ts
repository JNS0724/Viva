import { createSchedules, type Schedules } from './schedules.ts'
import { createScheduleRuns, type ScheduleRuns } from './schedule-runs.ts'
import { createUnattendedRuns, type TaskEvent } from './unattended-runs.ts'
import { openFeedStore, type FeedItem } from './feed-store.ts'
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
import { expandHome, importDshServers, importSummary, userDshHome } from './dsh-mcp-import.ts'
import { ensureDshProfile, vivaLayerFile } from './dsh-profile.ts'
import { pnpmLauncher } from './pnpm-launcher.ts'
import { dshEnv } from './dsh-runtime.ts'
import { restartDelay } from '../shared/restart-delay.ts'
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
import { createMcpConfigStore, editServer, parseServerInput, type ServerChanges } from './mcp-config.ts'
import { registerMemoryIpc } from './memory-ipc.ts'
import { createModelStore, defaultModel, modelValue, parseModelValue, piAiProviders, providerEnv } from './model-providers.ts'
import { registerModelsIpc } from './models-ipc.ts'
import { createPersonal } from './personal.ts'
import { createPreferences } from './preferences.ts'
import { CONFIG_IDS } from './session-info.ts'
import { sessionTiming } from './session-timing.ts'
import { createSettingsStore, keyHint } from './settings-store.ts'
import { openFollowups, type Followups } from './followups-main.ts'
import type { Notice } from './notice-plan.ts'
import type { ProposalView } from './followup-channel.ts'
import { createSkill, importSkill, listSkills, removeSkill, skillRoots } from './skills.ts'
import { ResumeError } from './resume-failure.ts'
import { historyRecall } from './history-recall.ts'
import { openFollowupStore } from './followup-store.ts'
import { openAppDb, type AppDb } from './app-db.ts'
import { createEventCore, type EventCore, type Signal } from './event-core.ts'
import { createTaskSignals, taskEventOf } from './task-signals.ts'
import { type Apply, journaled } from './journal.ts'
import { commandIpc } from './commands.ts'
import type { HostCapabilities, HostEvent } from './host.ts'

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
/** How long quitting waits for dsh to finish before the app goes anyway. */
const QUIT_WAIT_MS = 5_000
const CRASH_WINDOW_MS = 10 * 60_000
/** How much of a 动态 item a notification shows. */
const NOTICE_BODY_CHARS = 200

type HistoryDb = ReturnType<typeof openHistoryDb>
type Bridge = ReturnType<typeof createAcpBridge>
type AgentInfo = { mode: string, model: string, cwd: string, reason?: string, [field: string]: any }
/** What the model may change from the conversation (config-channel.ts), the app performing it. */
type ConfigActions = NonNullable<Parameters<typeof createAcpBridge>[0]['configActions']>
type ServerUpdate = Parameters<ConfigActions['updateServer']>[0]

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

/** The settings form's shape, which parseServerInput checks: keys as "NAME=value" lines, env or headers by type. */
function serverForm(spec: { name: string, url?: string, command?: string, args: readonly string[] }, secrets: Readonly<Record<string, unknown>>) {
  const pairs = Object.entries(secrets).map(([name, value]) => `${name}=${value}`).join('\n')
  const http = Boolean(spec.url)
  return { name: spec.name, type: http ? 'http' : 'stdio', command: spec.command, args: spec.args.join('\n'), url: spec.url, env: http ? '' : pairs, headers: http ? pairs : '' }
}

/** A change the model asked for (config-channel.ts ServerUpdate) as editServer takes it: what it names, and the keys typed. */
const updateChanges = (spec: ServerUpdate, secrets: Readonly<Record<string, string>>): ServerChanges => ({
  name: spec.newName || undefined,
  type: spec.url ? 'http' : spec.command ? 'stdio' : undefined,
  command: spec.command || undefined,
  args: spec.args ?? undefined,
  url: spec.url || undefined,
  values: secrets,
})

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
  /** Follow-ups: reminders at the user's times, what is ready told in the user's gaps (followups-main.ts). */
  let followups: Followups | null = null
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
  /** The conversation on screen: the latest one at launch, one picked from the history panel, or a fresh one. */
  let conversation!: ReturnType<HistoryDb['create']>
  /** Saved records a topic goes on from in a new session, to go with the first question asked in it (agent:prompt). */
  let carry: { conversationId: string, text: string } | null = null
  /**
   * The working directory the agent works in now: the current conversation's own, or the app's (config.cwd,
   * defaultWorkDir) when it has none or it is gone. The user switches it from the window (work-dir-ipc.ts).
   */
  let workDir: string | null = null
  let defaultWorkDir: string | null = null
  let bridge: Bridge | null = null
  let bridgeGeneration = 0
  /** When dsh died on its own lately; see restartDelay. */
  let crashes: number[] = []
  let restartTimer: ReturnType<typeof setTimeout> | undefined
  /** Set once quitting has begun: dsh is being stopped and must not be started again. */
  let quitting = false
  /** What the window is told of the agent (session-info.ts, acp-bridge.ts): mode, model, session, what it remembers. */
  let lastInfo: AgentInfo = { mode: 'connecting', model: '', cwd: '', reason: '' }

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
  const unattended = createUnattendedRuns({ agent: () => bridge })

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
  const workDirNow = () => workDir ?? defaultWorkDir
  /** Where a conversation goes on: in its own directory while that is still there, else in the app's. */
  const workDirFor = (segment: { cwd?: string | null } | null | undefined, config: Config) => (segment?.cwd && isFolder(segment.cwd) ? segment.cwd : config.cwd)

  /** Tells the window what the agent remembered or replaced, and what background the plugin sent. */
  function reportMemoryChanges() {
    try {
      const report = personal.collect({ conversationId: conversation.id, sessionId: conversation.sessionId })
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
    reportMemoryChanges()
    clearInterval(lateMemoryTimer)
    const until = Date.now() + LATE_MEMORY_WINDOW_MS
    lateMemoryTimer = setInterval(() => {
      reportMemoryChanges()
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

  function serverNamed(name: string) {
    const server = mcpStore.list().find((item) => item.name === name)
    if (!server) throw new Error(t("main.main.no.mcp.server.named", { name: name }))
    return server
  }

  /** Takes the MCP servers of a dsh home over, keys and all (dsh-mcp-import.ts); names already in use are skipped. */
  const importDsh = (dir: string) => importDshServers({ dir, store: mcpStore, takenNames: takenServerNames })

  /**
   * What the model may change from the conversation (viva-config plugin, config-channel.ts), each after the
   * user approved it on the card: MCP servers through the encrypted store, skills in the app's own folder.
   */
  function configActions(config: Config): ConfigActions {
    const roots = () => skillRoots({ dshHome: dshHomeOf(config), cwd: workDirNow() ?? config.cwd })
    const userRoot = () => {
      const root = roots().find((item) => item.managed)
      if (!root) throw new Error('the app has no skill folder of its own')
      return root.dir
    }
    return {
      listServers: () => mcpStore.list().map((server) => `${server.name}（${server.type === 'http' ? server.url : [server.command, ...server.args].join(' ')}）`
        + (server.missing.length ? t("main.main.missing.credentials", { value1: server.missing.join('、') }) : '')),
      prepareServer: (spec) => {
        parseServerInput(serverForm(spec, Object.fromEntries(spec.secrets.map((name) => [name, 'x']))), takenServerNames())
      },
      addServer: (spec, secrets) => {
        mcpStore.add(parseServerInput(serverForm(spec, secrets), takenServerNames()))
        mcpReloadDue = true
        return t("main.main.connected.mcp.server.takes.effect.after.this", { name: spec.name, value2: spec.secrets.length ? t("main.main.credentials.are.entered.in.the.window.by") : '' })
      },
      removeServer: (name) => {
        if (!takenServerNames().includes(name)) throw new Error(t("main.main.no.mcp.server.named", { name: name }))
        mcpStore.remove(name)
        mcpReloadDue = true
        return t("main.main.removed.mcp.server.takes.effect.after.this", { name: name })
      },
      prepareUpdate: (spec) => {
        editServer(serverNamed(spec.name), updateChanges(spec, Object.fromEntries(spec.secrets.map((name) => [name, 'x']))), takenServerNames())
      },
      updateServer: (spec, secrets) => {
        const next = editServer(serverNamed(spec.name), updateChanges(spec, secrets), takenServerNames())
        mcpStore.update(spec.name, next)
        mcpReloadDue = true
        return t("main.main.updated.mcp.server.takes.effect.after.this", { name: next.name, value2: next.missing.length ? t("main.main.still.needs.the.user.can.enter.these", { value1: next.missing.join('、') }) : '' })
      },
      /** No card: the servers and keys are the user's own, already set up in dsh (they asked for it this way). */
      importServers: async (dir) => {
        const target = dir ? expandHome(dir) : userDshHome()
        const result = await importDsh(target)
        if (result.added.length) mcpReloadDue = true
        if (target !== userDshHome()) preferences.set('dshImportDir', target)
        return importSummary(result, { forModel: true })
      },
      listSkills: () => listSkills(roots()).map((skill) => `${skill.id}：${skill.name}${skill.description ? ` — ${skill.description}` : ''}${skill.problem ? `（${skill.problem}）` : ''}`),
      createSkill: (spec) => t("main.main.created.skill.it.will.be.available.for", { value1: createSkill(spec, userRoot()) }),
      installSkill: (source) => t("main.main.installed.skill", { value1: importSkill(source, userRoot()) }),
      removeSkill: async (id) => t("main.main.deleted.skill.it.can.be.recovered.from", { value1: await removeSkill(id, roots(), (file) => host.shell.trash(file)) }),
    }
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
  function createBridge(config: Config, cwd: string) {
    const generation = ++bridgeGeneration
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
        if (generation !== bridgeGeneration) return
        if (event.type === 'followup_propose') return signal({ kind: 'agent.followup_proposed', event: event as { type: string, proposal: unknown } })
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
      onExit: (exit) => {
        if (generation === bridgeGeneration) recoverFromCrash(exit)
      },
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
      return schedules.act(request as ScheduleAction, conversation.id)
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
    conversation: () => (!bridge || bridge.isSwitching() || quitting ? 'away' : turn.active ? 'busy' : 'idle'),
    session: () => bridge?.currentSession() ?? null,
    holds: (effect) => effects?.holds(effect) ?? false,
    status: (session, reportId, token) => bridge?.reportStatus(session, reportId, token) ?? Promise.resolve('unavailable'),
    deliver: (session, reportId, token, text) => bridge?.deliverReport(session, reportId, token, text) ?? Promise.resolve('unavailable'),
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
    currentConversation: () => conversation.id,
    superseded: (taskId, runId) => taskRuntime?.reports.superseded(taskId, runId) ?? false,
    report: (note) => {
      const agent = bridge
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
    current: () => conversation,
    show: emitToRenderer,
  })
  /** Runs the effects due: after a change that queued one, and whenever the conversation may be free for them. */
  const wakeEffects = () => { void effects?.wake() }

  /** Only the app's selected provider credentials reach dsh; inherited endpoints remain isolated. */
  function dshSettings(config: Config) {
    return { DEEPSEEK_API_KEY: config.apiKey, ...providerEnv(modelStore.list()) }
  }

  /** dsh died on its own: start it again on the conversation on screen, waiting longer each time, until it keeps dying. */
  function recoverFromCrash({ message }: { message: string }) {
    taskRuntime?.dsh.gone()
    unattended.gone()
    console.error('[dsh] exited unexpectedly:', message)
    bridge = null
    turn = { active: false, startedAt: 0 }
    if (quitting) return
    const now = Date.now()
    crashes = [...crashes.filter((at) => now - at < CRASH_WINDOW_MS), now]
    const delay = restartDelay(crashes, now)
    if (delay === null) {
      emitToRenderer({ type: 'error', message: t("main.main.the.assistant.exited.repeatedly.retrying.has.stopped", { message: message }) })
      return
    }
    emitToRenderer({ type: 'error', message: t("main.main.the.assistant.exited.unexpectedly.reconnecting.in.seconds", { value1: Math.round(delay / 1000) }) })
    clearTimeout(restartTimer)
    restartTimer = setTimeout(() => {
      if (!bridge && !quitting) startBridge()
    }, delay)
  }

  /** Stops the running dsh and waits until it has exited, so a new one never shares its session files. */
  async function stopBridge() {
    taskRuntime?.dsh.gone()
    unattended.gone()
    clearTimeout(restartTimer)
    const running = bridge
    bridge = null
    await running?.dispose()
  }

  /** dsh stopped (it may still be writing the session), but no longer than QUIT_WAIT_MS. */
  const stopBridgeInTime = () => Promise.race([stopBridge(), new Promise((resolve) => setTimeout(resolve, QUIT_WAIT_MS))])

  /** Nothing to start yet (no key, or dsh not installed): the window shows how to fix it. */
  const setupInfo = (config: Config) => ({ mode: 'setup', problem: config.problem, cwd: config.cwd, model: '', models: [], efforts: [], reason: '' })
  const setupMessages = (): Readonly<Record<string, string>> => ({ 'no-key': t("main.main.enter.a.deepseek.api.key.or.add"), 'no-dsh': t("main.main.deepseek.harness.not.found.run.npm.install") })
  let SETUP_MESSAGES = setupMessages()

  function requireBridge() {
    if (!bridge) throw new Error(SETUP_MESSAGES[lastInfo.problem] ?? t("main.main.the.assistant.is.not.connected.yet"))
    return bridge
  }

  async function startBridge() {
    const config = currentConfig()
    if (config.problem) {
      const info = setupInfo(config)
      emitToRenderer({ type: 'ready', info })
      return info
    }
    fs.mkdirSync(config.cwd, { recursive: true })
    launchedAt = Date.now()
    workDir = workDirFor(conversation, config)
    bridge = createBridge(config, workDir)
    try {
      const started = await bridge.start({ resumeSessionId: conversation.sessionId })
      // The agent knows the conversation on screen if it resumed it, or if there was nothing to know yet.
      const info = { ...started, remembersHistory: started.resumed || !historyDb.get(conversation.id) }
      conversation = { ...conversation, sessionId: info.sessionId, cwd: workDir }
      emitToRenderer({ type: 'ready', info })
      // Results of tasks that ended while dsh was away come back once it is here again; schedules due meanwhile run.
      wakeEffects()
      scheduleRuns?.wake()
      return info
    } catch (err: any) {
      console.error('[main] failed to start agent bridge:', err)
      emitToRenderer({ type: 'error', message: t("main.main.could.not.connect.the.assistant", { message: err.message }) })
      return null
    }
  }

  /** New models for the same conversation: dsh restarts and resumes the session on screen. */
  async function restartKeepingConversation() {
    await stopBridge()
    return startBridge()
  }

  /**
   * dsh starts a session in the same process on the model its profile named at launch; the user may have
   * picked another one since, and new conversations follow the latest pick.
   */
  async function withLastModel<I extends { modelValue?: string, models?: ReadonlyArray<{ value: string }> }>(info: I) {
    const last = modelStore.lastModel()
    if (!last) return info
    const value = modelValue(last)
    if (info.modelValue === value || !info.models?.some((model) => model.value === value)) return info
    return { ...info, ...await requireBridge().setConfig('model', value) }
  }

  /** A new key (or none) means a different agent, so the conversation starts over. */
  async function restartWithNewConversation() {
    conversation = historyDb.create({ cwd: workDirNow() })
    await stopBridge()
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
    let newSessionPending: Promise<AgentInfo> | null = null
    ipcMain.handle('agent:info', () => lastInfo)
    // What the conversation on screen waits on the user for, for a window that opens on a dsh at work (a reload): said
    // on the live channel, so it comes in its place among the pushes (renderer waits-state.ts), not in the answer.
    ipcMain.handle('agent:waits', () => {
      emitToRenderer({ type: 'waits', ...(bridge?.sessionWaits() ?? { permissions: [], questions: [], secrets: [] }) })
      return true
    })
    ipcMain.handle('agent:prompt', (_event, text, images = []) => {
      if (newSessionPending) throw new Error(t("main.main.preparing.a.new.topic.please.wait"))
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
    ipcMain.handle('agent:cancel', () => bridge?.cancel())
    ipcMain.handle('agent:new-session', () => {
      if (newSessionPending) return newSessionPending
      if (turn.active) throw new Error(t("main.main.wait.for.this.turn.to.finish.before.2"))
      const measure = sessionTiming()
      newSessionPending = measure('new-topic.total', async () => {
        if (!bridge) {
          conversation = historyDb.create({ cwd: workDirNow() })
          return lastInfo
        }
        const opened = await bridge.newSession()
        const info = { ...await measure('new-topic.model', () => withLastModel(opened)), remembersHistory: true }
        conversation = historyDb.create({ sessionId: info.sessionId, cwd: workDirNow() })
        lastInfo = info
        return info
      }).finally(() => { newSessionPending = null })
      return newSessionPending
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
      return bridge?.respondPermission(id, option) ?? false
    })
    ipcMain.handle('agent:answer', (_event, questionId, answers) => {
      const id = assertText(questionId, 'questionId', 200)
      // Held first: dsh closes the question while it takes the answer, and what was asked goes with it.
      const keep = taskRuntime?.dsh.holdQuestion(id) ?? null
      const accepted = bridge?.answerQuestion(id, answers) ?? false
      if (accepted) keep?.(answers)
      return accepted
    })
    // Keys the user typed for a server the model set up: straight to the encrypted store, never to dsh.
    ipcMain.handle('agent:secrets', (_event, requestId, values) => {
      const id = assertText(requestId, 'requestId', 200)
      if (values !== null && (typeof values !== 'object' || Array.isArray(values))) throw new Error('invalid secrets')
      return bridge?.provideSecrets(id, values) ?? false
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
    // The user's turn comes first: background preparation stops after the item at hand.
    followups?.scheduler.yieldToUser()
    // A topic gone on from its saved records (history-ipc.ts continue-from-records): they go with the first question,
    // as background only; the window shows (and the history keeps) the question as it was typed.
    const carried = carry && carry.conversationId === conversation.id ? carry.text : null
    carry = null
    return agent.prompt(carried ? `${carried}\n\n${question}` : question, pictures)
  }

  /** Where each kind of signal goes (event-core.ts Routes): a route for every kind, or the type check fails. */
  function routeSignals(events: EventCore) {
    events.route({
      'chat.said': ({ text, images }) => sayInChat(text, images as ReturnType<typeof imagesForPrompt>),
      // A turn of the user's just ended: a gap, where what is ready may be told; memories saved in it are reported.
      'agent.turn_ended': () => {
        followups?.gap()
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
      // The same proposal turned down lately is not shown again.
      'agent.followup_proposed': ({ event }) => {
        const proposal = followups?.admitProposal(event.proposal as ProposalView)
        if (proposal) emitToRenderer({ ...event, proposal })
      },
      'clock.reminder_due': () => followups?.notifier.fire(),
      'clock.prepare_window': () => followups?.scheduler.fire(),
      'system.woke': () => woke(),
      'system.user_returned': () => followups?.notifier.gap(),
      'window.foreground': () => followups?.gap(),
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
   * Without an agent (setup state) an old conversation can still be read; it keeps its session for later.
   * A conversation goes on in its own directory while that is still there.
   * `exactly` (继续这个话题): that session in its own directory or none; never another directory in its place,
   * nor a new session (resume-failure.ts says why not, and the agent stays on the conversation it was on).
   */
  async function switchAgent(sessionId: string | null, cwd?: string | null, { exactly = false } = {}) {
    if (exactly && !(cwd && isFolder(cwd))) throw new ResumeError('missing-dir', t('resume.missing.directory', { cwd: cwd ?? t('resume.folder.unrecorded') }))
    if (exactly && !bridge) throw new ResumeError('unavailable', '助手还没准备好')
    const target = cwd && isFolder(cwd) ? cwd : workDirNow()
    if (!bridge) {
      workDir = target
      return { ...lastInfo, sessionId, cwd: target, resumed: false }
    }
    // With a bridge the agent has started somewhere, so there is a folder in use.
    try {
      const info = await bridge.switchSession(sessionId, target ?? undefined, { exactly })
      workDir = target
      lastInfo = { ...info, remembersHistory: info.resumed }
      return info
    } catch (err) {
      // Back where it was, or on a new session where that was gone too: the conversation on screen follows.
      if (err instanceof ResumeError && err.info) {
        lastInfo = { ...lastInfo, ...err.info, remembersHistory: Boolean(err.info.resumed) }
        if (err.info.sessionId && err.info.sessionId !== conversation.sessionId) conversation = { ...conversation, sessionId: err.info.sessionId }
      }
      throw err
    }
  }

  const forkProblems = (): Readonly<Record<string, string>> => Object.freeze({
    unavailable: t("main.main.this.assistant.version.cannot.change.working.directories"),
    missing: t("main.main.this.conversation.has.ended.try.again.later"),
  })
  let FORK_PROBLEMS = forkProblems()

  /**
   * The user picked another working directory: the conversation goes on there, everything said so far with it
   * (a fork of the session into that directory), as a new segment of the timeline after the current one.
   */
  async function switchWorkDir(dir: string) {
    const previous = conversation
    const stored = Boolean(historyDb.get(previous.id))
    if (!bridge) {
      workDir = dir
      conversation = historyDb.create({ cwd: dir, parentId: stored ? previous.id : null })
      return { ...lastInfo, cwd: dir }
    }
    const forked = await bridge.fork({ cwd: dir })
    if (!forked.ok) throw new Error(FORK_PROBLEMS[forked.reason] ?? t("main.main.could.not.change.working.directory", { reason: forked.reason }))
    workDir = dir
    lastInfo = { ...forked.info, remembersHistory: true }
    conversation = historyDb.create({
      sessionId: forked.info.sessionId, mode: lastInfo.mode, model: lastInfo.model, cwd: dir, parentId: stored ? previous.id : null,
    })
    emitToRenderer({ type: 'workdir', cwd: dir, info: lastInfo })
    return lastInfo
  }

  const chooseWorkFolder = () => host.dialogs.chooseFolder({ title: t("main.main.choose.working.directory"), createDirectory: true })
  const chooseExportPath = (defaultName: string) => host.dialogs.saveFile({
    title: t("main.main.export.conversation"), defaultPath: path.join(host.paths.documents, defaultName), filters: [{ name: 'Markdown', extensions: ['md'] }],
  })
  const chooseDshDir = () => host.dialogs.chooseFolder({ title: t("main.main.choose.the.dsh.folder.usually.named.dsh"), defaultPath: os.homedir(), showHidden: true })

  /** Reattaches the session with the current MCP servers; not while a turn runs (it would be cancelled). */
  async function applyMcpChange() {
    if (!bridge || turn.active) return null
    const info = await bridge.reloadSession()
    lastInfo = { ...lastInfo, ...info, remembersHistory: info.resumed || lastInfo.remembersHistory }
    return lastInfo
  }

  /** A new item in 动态: a notification (opened, it shows 动态), and the window shows it. */
  function feedDelivered(item: FeedItem) {
    showNotice({ kind: 'ready', followupIds: [], title: item.title, body: item.body.slice(0, NOTICE_BODY_CHARS), interrupts: false, system: true })
    emitToRenderer({ type: 'feed_changed' })
  }

  /** A follow-up's notice as a system notification; opened, it is counted for the week of self-use. */
  function showNotice(notice: Notice) {
    host.notify(notice, (afterMs) => followups?.store.logEvent('notice_opened', { kind: notice.kind, afterMs }))
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
      call: (op, args) => (bridge ? bridge.plugins(op, args) : Promise.resolve({ ok: false as const, problem: 'disconnected' })),
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
    schedules = createSchedules({ db: appDb.db, emit: emitToRenderer, changed: () => { scheduleRuns?.arm(); schedulesChanged() } })
    scheduleRuns = createScheduleRuns({
      db: appDb.db,
      store: schedules.store,
      feed: openFeedStore({ db: appDb.db }),
      run: unattended.run,
      delivered: feedDelivered,
      changed: schedulesChanged,
      onError: (err) => console.error('[schedules]', err instanceof Error ? err.message : String(err)),
    })
    ipcMain.handle('schedules:list', () => schedules?.list() ?? [])
    ipcMain.handle('schedules:accept', (_event, proposalId) => requireSchedules().accept(String(proposalId)))
    ipcMain.handle('schedules:decline', (_event, proposalId) => { requireSchedules().decline(String(proposalId)) })
    followups = openFollowups({
      ipcMain,
      db: appDb.db,
      apply: applyChange,
      signal: (kind) => { signal({ kind }) },
      notify: showNotice,
      windowInFront: host.window.inFront,
      onPending: (count) => {
        host.window.setPending(count)
        // Something changed in the main process (a draft, a reminder): the window shows it as it is now.
        emitToRenderer({ type: 'followups_changed' })
      },
      idleSeconds: host.power.idleSeconds,
      loadSchedule: () => preferences.get().prepareSchedule,
      storeSchedule: (schedule) => preferences.set('prepareSchedule', schedule),
      userBusy: () => (turn.active ? t("main.main.you.are.in.a.conversation") : bridge?.workingTasks() ? t("main.main.your.background.tasks.are.running") : null),
      prepareText: (call, signal) => {
        // The model the conversation is on, else the one new conversations start on.
        const route = parseModelValue(String(lastInfo.modelValue ?? '')) ?? profileModels(config).defaultModel
        if (!route) return Promise.resolve({ ok: false as const, problem: t("main.main.no.model.available.yet"), called: false as const })
        return bridge ? bridge.prepareText({ ...route, ...call }, signal) : Promise.resolve({ ok: false as const, problem: t("main.acp-bridge.the.assistant.is.not.ready.yet"), called: false as const })
      },
      takenUp: (conversationId, since) => (taskStore?.list() ?? []).some((task) => (task.startedAt ?? 0) >= since
        && (task.segmentId === conversationId || historyDb.get(task.segmentId)?.conversation.parentId === conversationId)),
      materials: {
        conversation: (id) => historyDb.get(id)?.messages.map((m) => ({ role: m.role, text: m.text })) ?? null,
        profile: () => memoryDb.latestSynthesis()?.text ?? null,
      },
      workDir: () => workDirNow() ?? config.cwd,
      conversationExists: (id) => Boolean(historyDb.get(id)),
      onState: (state) => emitToRenderer({ type: 'prepare_state', state }),
      onError: (err) => console.error('[followups]', err instanceof Error ? err.message : String(err)),
    })
  }

  /** The agent's side of background tasks. */
  const taskAgent = {
    closeTask: (taskId: string) => bridge?.closeTask(taskId),
    cancelTask: (taskId: string) => bridge?.cancelTask(taskId),
    steerTask: (taskId: string, text: string) => requireBridge().steerTask(taskId, text),
    resumeTask: (request: Parameters<Bridge['resumeTask']>[0]) => (bridge ? bridge.resumeTask(request) : { ok: false, reason: 'unavailable' }),
    startTask: (request: Parameters<Bridge['startTask']>[0]) => (bridge ? bridge.startTask(request) : { ok: false, reason: 'unavailable' }),
    promptTask: (taskId: string, text: string) => {
      followups?.scheduler.yieldToUser()
      return bridge?.promptTask(taskId, text)
    },
  }

  /** Back to before the turn where the user said these words; the agent goes on there, remembering what came before. */
  async function forkBack(request: { words: string, occurrence: number }) {
    if (!bridge) return { ok: false as const, reason: 'unavailable' }
    const forked = await bridge.fork(request)
    if (forked.ok) lastInfo = { ...forked.info, remembersHistory: true }
    return forked
  }

  /** Opens the database and drops conversations whose undo window has passed. */
  function openHistory(config: Config) {
    historyDb = journaled(openHistoryDb({ db: appDb.db }), 'history', HISTORY_WRITES, applyChange)
    historyDb.purgeDeleted({ olderThanMs: 0 })
    conversation = historyDb.latest()?.conversation ?? historyDb.create({ cwd: config.cwd })
    registerHistoryIpc(ipcMain, {
      db: historyDb,
      dshHome: dshHomeOf(config),
      traceDb: () => traceDb,
      current: () => conversation,
      // A report waiting for this conversation (task-reports.ts) may go now.
      setCurrent: (next) => { conversation = next; wakeEffects() },
      agentInfo: () => lastInfo,
      switchAgent,
      chooseExportPath,
      isBusy: () => turn.active,
      folderExists: (dir) => isFolder(dir),
      workDir: () => workDirNow() ?? null,
      carryNext: (conversationId, text) => { carry = { conversationId, text } },
    })
    registerRewindIpc(ipcMain, {
      db: historyDb,
      current: () => conversation,
      // A report waiting for this conversation (task-reports.ts) may go now.
      setCurrent: (next) => { conversation = next; wakeEffects() },
      isBusy: () => turn.active,
      agentInfo: () => lastInfo,
      forkAgent: forkBack,
      switchAgent,
      traceDb: () => traceDb,
    })
    // Tasks still going, kept so the next launch can offer to take them up (dsh ends with the app). Only the task
    // runtime writes them, each change with its event (task.started, task.ended, …).
    taskStore = createTaskStore({ db: appDb.db, onError: (err) => console.error('[tasks]', err.message) })
    effects = createEffects({ db: appDb.db, apply: applyChange, onError: (err) => console.error('[effects]', err instanceof Error ? err.message : String(err)) })
    effects.runs(REPORT, taskReports)
    taskRuntime = createTaskRuntime({
      db: historyDb,
      store: taskStore,
      current: () => conversation,
      agentInfo: () => lastInfo,
      agent: taskAgent,
      waitsOf: (taskId) => bridge?.taskWaits(taskId) ?? { permissions: [], questions: [] },
      apply: applyChange,
      publish: emitToRenderer,
      // Once a task's end is kept: its result back to the conversation, and a gap.
      onEnd: () => {
        wakeEffects()
        followups?.gap()
      },
      effects,
    })
    registerTaskIpc(ipcMain, taskRuntime.window)
  }

  /** Opens the stores and registers the backend's channels, before the window loads. */
  function open() {
    appDb = openAppDb({ file: path.join(userData, 'app.db') })
    core = createEventCore({ app: appDb, publish: host.window.send })
    // The follow-ups' tables, before anything reads them.
    openFollowupStore({ db: appDb.db })
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
    defaultWorkDir = config.cwd
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

  /** The computer back from sleep, or unlocked: reminders missed meanwhile go out, merged into one; preparation looks again. */
  function woke() {
    scheduleRuns?.wake()
    followups?.notifier.wake()
    followups?.scheduler.refresh()
  }

  function close() {
    clearInterval(lateMemoryTimer)
    scheduleRuns?.close()
    followups?.close()
    historyDb?.close()
    appDb?.close()
    memoryDb?.close()
    traceDb?.close()
  }

  onLocaleChange(() => {
    SETUP_MESSAGES = setupMessages()
    FORK_PROBLEMS = forkProblems()
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
    followups: () => followups,
    agentPid: () => bridge?.pid() ?? null,
    hasBridge: () => Boolean(bridge),
    isQuitting: () => quitting,
    /** Quitting has begun (or the session ends): dsh must not be started again. */
    markQuitting: () => { quitting = true },
    /** Stops dsh, waiting at most a few seconds. */
    stop: stopBridgeInTime,
    close,
  }
}

export type Backend = ReturnType<typeof createBackend>

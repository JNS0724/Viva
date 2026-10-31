import { onLocaleChange } from '../shared/i18n/locale.ts'
import { t } from '../shared/i18n/translate.ts'
import { registerLanguageIpc } from './language-ipc.ts'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MAX_MESSAGE_CHARS as MAX_PROMPT_CHARS } from '../shared/text-limits.ts'
import { app, BrowserWindow, dialog, globalShortcut, ipcMain as electronIpcMain, Menu, nativeImage, Notification, powerMonitor, protocol, safeStorage, screen, shell, Tray } from 'electron'
import { openMemoryDb } from '../../plugins/memory/lib/store.ts'
import { openTraceDb } from '../../plugins/trace/lib/store.ts'
import { DEFAULT_PERMISSION, installedDshVersion, PERMISSION_LEVELS, PERSONA, resolvePlugins } from './app-plugins.ts'
import { APP_ROOT, CODE_ROOT, DSH_PROFILE, resolveConfig } from './config.ts'
import { createAcpBridge, switchingMessage } from './acp-bridge.ts'
import { createDeskIsland } from './desk-island.ts'
import { leaveFullScreen } from './full-screen.ts'
import { adoptDshSessions, adoptDshSkills, removeOwnProfiles } from './dsh-migrate.ts'
import { expandHome, importDshServers, importSummary, userDshHome } from './dsh-mcp-import.ts'
import { ensureDshProfile } from './dsh-profile.ts'
import { dshEnv, restartDelay } from './dsh-runtime.ts'
import { registerExtensionsIpc } from './extensions-ipc.ts'
import { registerFilesIpc } from './files-ipc.ts'
import { openHistoryDb } from './history-db.ts'
import { imagesForPrompt, registerImageIpc } from './image-ipc.ts'
import { IMAGE_SCHEME_PRIVILEGES, registerImageProtocol } from './image-protocol.ts'
import { checkedIpc } from './ipc-contract.ts'
import { createImageStore } from './image-store.ts'
import { registerHistoryIpc } from './history-ipc.ts'
import { registerRewindIpc } from './rewind-ipc.ts'
import { registerTaskIpc } from './task-ipc.ts'
import { createTaskStore } from './task-store.ts'
import { createTaskRegistry } from './task-registry.ts'
import { registerWorkDirIpc } from './work-dir-ipc.ts'
import { migrateLegacyHistory } from './history-migrate.ts'
import { ASK_SHORTCUT, registerAskShortcut, registerIslandIpc } from './island-main.ts'
import { createTray } from './tray.ts'
import { adoptLegacyData, LEGACY_NAME } from './legacy-data.ts'
import { externalUrl } from './links.ts'
import { createMcpConfigStore, editServer, parseServerInput, type ServerChanges } from './mcp-config.ts'
import { registerMemoryIpc } from './memory-ipc.ts'
import { createModelStore, defaultModel, modelValue, parseModelValue, piAiProviders, providerEnv } from './model-providers.ts'
import { registerModelsIpc } from './models-ipc.ts'
import { createPersonal } from './personal.ts'
import { createPreferences } from './preferences.ts'
import { removeTree } from './remove-tree.ts'
import { CONFIG_IDS } from './session-info.ts'
import { sessionTiming } from './session-timing.ts'
import { createSettingsStore, keyHint } from './settings-store.ts'
import { openSources } from './sources-main.ts'
import { NO_SOURCES } from './message-reader.ts'
import { openFollowups, type Followups } from './followups-main.ts'
import type { Notice } from './notice-plan.ts'
import type { ProposalView } from './followup-channel.ts'
import { createSkill, importSkill, listSkills, removeSkill, skillRoots } from './skills.ts'
import { installAutomationDriver } from './automation-driver.ts'
import { ResumeError } from './resume-failure.ts'
import { historyRecall } from './history-recall.ts'
import { devIcon, windowChrome, windowSize } from './window-options.ts'

const automationMode = app.commandLine.hasSwitch('enable-smoke-test-driver')
// A standard alternate profile works for automation and separate user profiles alike.
const profileDirectory = app.commandLine.getSwitchValue('user-data-dir')
if (automationMode && !profileDirectory) throw new Error('External automation requires an explicit --user-data-dir')
if (profileDirectory) {
  const directory = path.resolve(profileDirectory)
  fs.mkdirSync(directory, { recursive: true })
  app.setPath('userData', directory)
}

const MAX_KEY_CHARS = 1_000
/** dsh's stock ACP profile: used, without memory, when the app's own profile can't be written. */
const FALLBACK_PROFILE = 'acp'
/** After a turn the memory plugin's background pass may still write; look again this often, this long. */
const LATE_MEMORY_POLL_MS = 2_000
const LATE_MEMORY_WINDOW_MS = 30_000

/** Every channel the pages send on goes through the contract's check first (ipc-contract.js). */
const ipcMain = checkedIpc(electronIpcMain, { onRefused: (_channel, problem) => console.error('[ipc] refused:', problem) })

type HistoryDb = ReturnType<typeof openHistoryDb>

// The stores and databases are opened once at launch (app.whenReady, openHistory, openPersonal), before any
// window or handler can reach them: `!` says so. What may be absent at any time says `| null`.
let settingsStore!: ReturnType<typeof createSettingsStore>
/** Switches from settings, such as the desktop island (preferences.js). */
let preferences!: ReturnType<typeof createPreferences>
/** False in smoke runs, which turn the desktop island on only while they check it. */
let deskAllowed = true
/** Model providers the user added besides DeepSeek; see model-providers.js. */
let modelStore!: ReturnType<typeof createModelStore>
let historyDb!: HistoryDb
/** Pictures pasted into questions, and dsh's copies of them, in a folder the user may move (image-store.js). */
let imageStore!: ReturnType<typeof createImageStore>
/** The user's MCP servers, encrypted where they hold keys (mcp-config.js). */
let mcpStore!: ReturnType<typeof createMcpConfigStore>
/** An MCP server was added or removed from the conversation: reattach the session once the turn is over. */
let mcpReloadDue = false
let memoryDb!: ReturnType<typeof openMemoryDb>
/** What the trace plugin recorded, for the 过程 of reopened conversations; null if it can't be opened. */
let traceDb: ReturnType<typeof openTraceDb> | null = null
let sources: ReturnType<typeof openSources> | null = null
/** Background tasks still going or ended lately (task-store.ts); follow-ups look at it to not prepare what a task does. */
let taskStore: ReturnType<typeof createTaskStore> | null = null
const taskRegistry = createTaskRegistry({ changed: snapshot => {
  emitToRenderer({ type: 'task_snapshot', taskId: snapshot.taskId, snapshot })
  if (snapshot.endedAt !== null) {
    const stored = taskStore?.list().find(task => task.id === snapshot.taskId)
    if (stored) taskStore?.add({ ...stored, status: snapshot.status, endedAt: snapshot.endedAt, resultPreview: snapshot.resultPreview })
  }
} })
/** Follow-ups: reminders at the user's times, what is ready told in the user's gaps (followups-main.ts). */
let followups: Followups | null = null
/** Ready follow-ups, for the tray, which may be made after the count changed. */
let pendingFollowups = 0
/** Notifications shown and not yet clicked or closed: kept, or they may be collected before a click reaches them. */
const shownNotices = new Set<Notification>()
/** How long a shown notification is kept for its click. */
const NOTICE_KEEP_MS = 60 * 60 * 1000
/** Started with the computer (开机启动): the window stays hidden, Viva in the tray. */
const startedHidden = process.argv.includes('--hidden') || (process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin)
/** Plugins left out of the profile at the last launch, and why; shown in settings. */
let pluginProblems: Array<{ name: string, contract: string, problem: string }> = []
/** Habits, turn reports and the user's MCP servers; memory itself is the dsh plugin. See personal.js. */
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
 * defaultWorkDir) when it has none or it is gone. The user switches it from the window (work-dir-ipc.js).
 */
let workDir: string | null = null
let defaultWorkDir: string | null = null
let win: BrowserWindow | null = null
/** The island on the desktop, shown while the window is in the background (desk-island.js). */
let desk: ReturnType<typeof createDeskIsland> | null = null
/** The tray icon, made the first time the window is closed to it (tray.js). */
let tray: ReturnType<typeof createTray> | null = null
/** Whether the shortcut that opens the island's input is ours (another app may hold it); null before it is tried. */
let shortcutHeld: ReturnType<typeof registerAskShortcut> | null = null
let bridge: ReturnType<typeof createAcpBridge> | null = null
let bridgeGeneration = 0
/** When dsh died on its own lately; see restartDelay. */
let crashes: number[] = []
let restartTimer: ReturnType<typeof setTimeout> | undefined
/** Set once quitting has begun: dsh is being stopped and must not be started again. */
let quitting = false
/** How long quitting waits for dsh to finish before the app goes anyway. */
const QUIT_WAIT_MS = 5_000
/** What the window is told of the agent (session-info.ts, acp-bridge.ts): mode, model, session, what it remembers. */
let lastInfo: { mode: string, model: string, cwd: string, reason?: string, [field: string]: any } = { mode: 'connecting', model: '', cwd: '', reason: '' }

/** What the window is told of the agent (renderer app.ts onEvent): its type, and what that type carries. */
type AgentEvent = { type: string, [field: string]: any }
/** The app's launch settings as resolved now (config.ts resolveConfig). */
type Config = ReturnType<typeof currentConfig>
/** What the model may change from the conversation (config-channel.ts), the app performing it. */
type ConfigActions = NonNullable<Parameters<typeof createAcpBridge>[0]['configActions']>

/** dsh's home, which resolveConfig always sets when given the app's data folder (as currentConfig does). */
function dshHomeOf(config: Config): string {
  if (!config.dshHome) throw new Error('dsh has no home folder')
  return config.dshHome
}

function emitToRenderer(event: AgentEvent) {
  if (event.type === 'ready') lastInfo = event.info
  if (event.type === 'config') lastInfo = { ...lastInfo, ...event.info }
  if (win && !win.isDestroyed()) win.webContents.send('agent:event', event)
}

const currentConfig = () => resolveConfig(process.env, fs.existsSync, settingsStore.getApiKey(), modelStore.list().length > 0, {
  userData: app.getPath('userData'), execPath: process.execPath, packaged: app.isPackaged,
})

/** The pictures folder: where the user moved it, or in the app's data. */
const imagesDir = () => preferences.get().imagesDir || path.join(app.getPath('userData'), 'images')

const isFolder = (dir: string) => {
  try {
    return fs.statSync(dir).isDirectory()
  } catch {
    return false
  }
}
const workDirNow = () => workDir ?? defaultWorkDir
/** Where a conversation goes on: in its own directory while that is still there, else in the app's. */
const workDirFor = (segment: { cwd?: string | null } | null | undefined, config: Config) => (segment?.cwd && isFolder(segment.cwd) ? segment.cwd : config.cwd)

/** Tells the window what the agent remembered or replaced, and what background the plugin sent. */
function reportMemoryChanges() {
  try {
    const report = personal.collect({ conversationId: conversation.id, sessionId: conversation.sessionId })
    if (report?.memories.length || report?.invalidated.length) {
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

/**
 * Writes the app's dsh profile: the persona and the plugins that pass the compatibility check. Without it
 * dsh still runs on its stock profile, with no memory, trace or policy.
 */
function prepareProfile(config: Config) {
  try {
    const { plugins, problems } = resolvePlugins({
      codeRoot: CODE_ROOT, userData: app.getPath('userData'), dshVersion: installedDshVersion(APP_ROOT), permission: permissionNow(),
    })
    pluginProblems = problems
    problems.forEach(({ name, problem }) => console.error(`[plugins] ${name} left out: ${problem}`))
    ensureDshProfile({ dshHome: dshHomeOf(config), profile: DSH_PROFILE, plugins, persona: PERSONA, models: profileModels(config), imagesDir: imagesDir() })
    return DSH_PROFILE
  } catch (err: any) {
    console.error('[plugins] could not prepare the dsh profile, starting without the app plugins:', err.message)
    return FALLBACK_PROFILE
  }
}

/** The models dsh offers: DeepSeek with a key, the user's providers, and the one new sessions start with. */
function profileModels(config: Config) {
  const providers = modelStore.list()
  const hasDeepSeek = Boolean(config.apiKey)
  return { providers: piAiProviders(providers), deepseek: hasDeepSeek, defaultModel: defaultModel({ lastModel: modelStore.lastModel(), providers, hasDeepSeek }) }
}

/** Events from a replaced bridge are dropped so a restart can't leak into the new conversation. */
/** The settings form's shape, which parseServerInput checks: keys as "NAME=value" lines, env or headers by type. */
function serverForm(spec: { name: string, url?: string, command?: string, args: readonly string[] }, secrets: Readonly<Record<string, unknown>>) {
  const pairs = Object.entries(secrets).map(([name, value]) => `${name}=${value}`).join('\n')
  const http = Boolean(spec.url)
  return { name: spec.name, type: http ? 'http' : 'stdio', command: spec.command, args: spec.args.join('\n'), url: spec.url, env: http ? '' : pairs, headers: http ? pairs : '' }
}

const takenServerNames = () => mcpStore.list().map((server) => server.name)

function serverNamed(name: string) {
  const server = mcpStore.list().find((item) => item.name === name)
  if (!server) throw new Error(t("main.main.no.mcp.server.named", { name: name }))
  return server
}

/** A change the model asked for (config-channel.ts ServerUpdate) as editServer takes it: what it names, and the keys typed. */
type ServerUpdate = Parameters<ConfigActions['updateServer']>[0]
const updateChanges = (spec: ServerUpdate, secrets: Readonly<Record<string, string>>): ServerChanges => ({
  name: spec.newName || undefined,
  type: spec.url ? 'http' : spec.command ? 'stdio' : undefined,
  command: spec.command || undefined,
  args: spec.args ?? undefined,
  url: spec.url || undefined,
  values: secrets,
})

/**
 * What the model may change from the conversation (viva-config plugin, config-channel.js), each after the
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
    removeSkill: async (id) => t("main.main.deleted.skill.it.can.be.recovered.from", { value1: await removeSkill(id, roots(), (file) => shell.trashItem(file)) }),
  }
}

function reloadMcpAfterTurn() {
  mcpReloadDue = false
  applyMcpChange()
    .then((info) => info && emitToRenderer({ type: 'config', info }))
    .catch((err) => console.error('[mcp] could not reattach the session after a change:', err.message))
}

function createBridge(config: Config, cwd: string) {
  const generation = ++bridgeGeneration
  return createAcpBridge({
    prewarmSessions: true,
    dshBin: config.dshBin,
    nodeBin: config.nodeBin,
    profile: prepareProfile(config),
    cwd,
    env: dshEnv({ base: process.env, dshHome: dshHomeOf(config), runtime: config.runtime, settings: dshSettings(config) }),
    mcpServers: () => personal.mcpServers(),
    configActions: configActions(config),
    messageActions: { read: (request) => (sources ? sources.read(request) : Promise.resolve(NO_SOURCES)) },
    historySearch: (query, range) => (historyDb ? historyRecall(historyDb).search(query, range) : []),
    historyRead: (ref, around) => (historyDb ? historyRecall(historyDb).read(ref, around) : { status: 'deleted' as const }),
    taskRead: (request, sessionId) => taskRegistry.query(request, sessionId === lastInfo.sessionId ? { cwd: workDirNow() ?? '' } : { taskId: sessionId }),
    emit: (event) => {
      if (generation !== bridgeGeneration) return
      if (event.type === 'followup_propose') {
        // The same suggestion turned down lately is not shown again.
        const proposal = followups?.admitProposal(event.proposal as ProposalView)
        if (proposal) emitToRenderer({ ...event, proposal })
        return
      }
      emitToRenderer(event)
      taskRegistry.receive(event)
      // A turn of the user's, or a task of theirs, just ended: a gap, where what is ready may be told.
      if (event.type === 'turn_end' || event.type === 'task_end') followups?.gap()
      if (event.type === 'turn_end' || event.type === 'error') reportTurnMemories()
      if (event.type === 'turn_end' && mcpReloadDue) reloadMcpAfterTurn()
    },
    onExit: (exit) => {
      if (generation === bridgeGeneration) recoverFromCrash(exit)
    },
  })
}

/** Only the app's selected provider credentials reach dsh; inherited endpoints remain isolated. */
function dshSettings(config: Config) {
  return {
    DEEPSEEK_API_KEY: config.apiKey,
    ...providerEnv(modelStore.list()),
  }
}

/** dsh died on its own: start it again on the conversation on screen, waiting longer each time, until it keeps dying. */
function recoverFromCrash({ message }: { message: string }) {
  taskRegistry.interrupt()
  console.error('[dsh] exited unexpectedly:', message)
  bridge = null
  turn = { active: false, startedAt: 0 }
  if (quitting) return
  const now = Date.now()
  crashes = [...crashes.filter((at) => now - at < 10 * 60_000), now]
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
  taskRegistry.interrupt()
  clearTimeout(restartTimer)
  const running = bridge
  bridge = null
  await running?.dispose()
}

/** dsh stopped (it may still be writing the session), but no longer than QUIT_WAIT_MS. */
const stopBridgeInTime = () => Promise.race([stopBridge(), new Promise((resolve) => setTimeout(resolve, QUIT_WAIT_MS))])

/** Nothing to start yet (no key, or dsh not installed): the window shows how to fix it. */
const setupInfo = (config: Config) => ({ mode: 'setup', problem: config.problem, cwd: config.cwd, model: '', models: [], efforts: [], reason: '' })
let SETUP_MESSAGES: Readonly<Record<string, string>> = { 'no-key': t("main.main.enter.a.deepseek.api.key.or.add"), 'no-dsh': t("main.main.deepseek.harness.not.found.run.npm.install") }

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

function settingsView() {
  const saved = settingsStore.getApiKey()
  const envKey = process.env.DEEPSEEK_API_KEY ?? ''
  return {
    hasKey: Boolean(saved || envKey),
    keyHint: keyHint(saved || envKey),
    source: saved ? 'saved' : envKey ? 'env' : null,
    encryptionAvailable: safeStorage.isEncryptionAvailable(),
    deskIsland: preferences.get().deskIsland,
    shortcut: shortcutHeld === null ? null : { keys: ASK_SHORTCUT, held: shortcutHeld },
    images: imageStore.usage(),
    permission: permissionNow(),
    openAtLogin: { on: preferences.get().openAtLogin, available: canOpenAtLogin() },
  }
}

/** Only the installed app may start with the computer: in development it would register Electron itself. */
const canOpenAtLogin = () => app.isPackaged && !automationMode

/** 开机启动: off unless the user turns it on; started so, Viva stays in the tray (startedHidden). */
function setOpenAtLogin(on: boolean) {
  if (!canOpenAtLogin()) throw new Error(t("main.main.start.at.login.is.available.only.in"))
  app.setLoginItemSettings({ openAtLogin: on, ...(process.platform === 'win32' ? { args: ['--hidden'] } : {}) })
  preferences.set('openAtLogin', on)
}

/** The permission level picked; one no longer offered (an older or edited file) reads as the default. */
const permissionNow = () => (PERMISSION_LEVELS.includes(preferences.get().permission) ? preferences.get().permission : DEFAULT_PERMISSION)

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

function assertText(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > maxLength) {
    throw new Error(`invalid ${name}`)
  }
  return value
}

function registerAgentIpc() {
  let newSessionPending: Promise<typeof lastInfo> | null = null
  ipcMain.handle('agent:info', () => lastInfo)
  ipcMain.handle('agent:prompt', (_event, text, images = []) => {
    if (newSessionPending) throw new Error(t("main.main.preparing.a.new.topic.please.wait"))
    // With pictures the words may be left out.
    const question = images?.length && text === '' ? '' : assertText(text, 'prompt', MAX_PROMPT_CHARS)
    const pictures = imagesForPrompt(imageStore, images)
    const agent = requireBridge()
    // Mid-switch a question would go to the session being left, and be cut off when that one closes. The window
    // keeps sending off while it switches; this holds for every other way in (the desktop island) too.
    if (agent.isSwitching()) throw new Error(switchingMessage())
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
  ipcMain.handle('agent:answer', (_event, questionId, answers) => bridge?.answerQuestion(assertText(questionId, 'questionId', 200), answers) ?? false)
  // Keys the user typed for a server the model set up: straight to the encrypted store, never to dsh.
  ipcMain.handle('agent:secrets', (_event, requestId, values) => {
    const id = assertText(requestId, 'requestId', 200)
    if (values !== null && (typeof values !== 'object' || Array.isArray(values))) throw new Error('invalid secrets')
    return bridge?.provideSecrets(id, values) ?? false
  })
}

/** Brings the window to the front: from the desktop island, the tray, the Dock or a second launch. */
function showWindow() {
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  if (process.platform === 'darwin') app.focus({ steal: true })
  win.focus()
}

const windowInFront = () => Boolean(win && !win.isDestroyed() && win.isFocused() && win.isVisible() && !win.isMinimized())

/** The window, for what happens only while it is open: its dialogs, the shortcut's focus, closing it to the tray. */
function mainWindow(): BrowserWindow {
  if (!win || win.isDestroyed()) throw new Error('the window is not open')
  return win
}

/** The shortcut that opens the island's input, from any app; not in smoke runs, which share the machine. */
function registerShortcut(config: Config) {
  if (automationMode) return
  shortcutHeld = registerAskShortcut(globalShortcut, {
    foreground: windowInFront,
    focusComposer: () => mainWindow().webContents.send('composer:focus'),
    openInput: () => desk?.openInput() ?? false,
    showWindow,
  })
}

/** Closing the window keeps Viva running in the tray, with the island on the desktop. */
function closeToTray() {
  // A full-screen window hidden as it is would leave its Space behind, black (full-screen.js).
  const shown = mainWindow()
  if (shown.isFullScreen()) leaveFullScreen(shown, hideToTray)
  else hideToTray()
}

function hideToTray() {
  mainWindow().hide()
  showTray()
  desk?.setAway(true)
}

function showTray() {
  tray ??= createTray({
    Tray, Menu, nativeImage,
    iconDir: path.join(CODE_ROOT, 'src', 'assets', 'tray'),
    platform: process.platform,
    onOpen: showWindow,
    onQuit: () => app.quit(),
    onPending: openTasksPage,
    pending: pendingFollowups,
  })
}

/**
 * The desktop island comes out when the window is closed to the tray and goes when it is shown again; a smoke
 * run turns it on only when it checks it. Closing still follows the normal tray lifecycle.
 */
function attachDeskIsland(config: Config, window: BrowserWindow) {
  deskAllowed = !automationMode
  desk = createDeskIsland({
    BrowserWindow,
    screen,
    preload: path.join(CODE_ROOT, 'src', 'preload', 'desk-preload.cjs'),
    page: path.join(CODE_ROOT, 'src', 'renderer', 'desk.html'),
    mainWindow: window,
    enabled: deskAllowed && preferences.get().deskIsland,
    places: { get: () => preferences.get().deskPlaces, set: (places) => preferences.set('deskPlaces', places) },
    coach: { get: () => preferences.get().deskCoached, set: () => preferences.set('deskCoached', true) },
  })
  window.on('close', (event) => {
    if (quitting) return
    event.preventDefault()
    closeToTray()
  })
  window.on('show', () => desk?.setAway(false))
  // Windows logging off or shutting down closes the window for real, or it would hold the session up.
  window.on('session-end', () => {
    quitting = true
  })
  window.on('closed', () => {
    desk?.destroy()
    desk = null
  })
}

/** The desktop island's switch, from settings or from 关闭桌面岛 in the island's menu. */
function setDeskIsland(on: boolean) {
  preferences.set('deskIsland', on)
  desk?.setEnabled(on && deskAllowed)
}

const switchOffDesk = () => setDeskIsland(false)

function registerSettingsIpc() {
  ipcMain.handle('shell:open-link', (_event, url) => shell.openExternal(externalUrl(url)))
  ipcMain.handle('settings:get', () => settingsView())
  ipcMain.handle('settings:save-key', async (_event, key) => {
    settingsStore.saveApiKey(assertText(key, 'API key', MAX_KEY_CHARS))
    return { settings: settingsView(), info: await restartWithNewConversation() }
  })
  ipcMain.handle('settings:set-desk-island', (_event, on) => {
    if (typeof on !== 'boolean') throw new Error('invalid desk island switch')
    setDeskIsland(on)
    return settingsView()
  })
  ipcMain.handle('settings:set-permission', (_event, level) => setPermission(level))
  ipcMain.handle('settings:set-open-at-login', (_event, on) => {
    setOpenAtLogin(on)
    return settingsView()
  })
  ipcMain.handle('settings:reset-desk-place', () => {
    desk?.resetPlace()
    if (!desk) preferences.set('deskPlaces', { last: null, places: {} })
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

let FORK_PROBLEMS: Readonly<Record<string, string>> = Object.freeze({
  unavailable: t("main.main.this.assistant.version.cannot.change.working.directories"),
  missing: t("main.main.this.conversation.has.ended.try.again.later"),
})

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

async function chooseWorkFolder() {
  const result = await dialog.showOpenDialog(mainWindow(), { title: t("main.main.choose.working.directory"), properties: ['openDirectory', 'createDirectory'] })
  return result.canceled ? null : result.filePaths[0] ?? null
}

async function chooseExportPath(defaultName: string): Promise<string | null> {
  const result = await dialog.showSaveDialog(mainWindow(), {
    title: t("main.main.export.conversation"),
    defaultPath: path.join(app.getPath('documents'), defaultName),
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  })
  return result.canceled ? null : result.filePath ?? null
}

/** Reattaches the session with the current MCP servers; not while a turn runs (it would be cancelled). */
async function applyMcpChange() {
  if (!bridge || turn.active) return null
  const info = await bridge.reloadSession()
  lastInfo = { ...lastInfo, ...info, remembersHistory: info.resumed || lastInfo.remembersHistory }
  return lastInfo
}

const pickFiles = async (options: Electron.OpenDialogOptions) => {
  const result = await dialog.showOpenDialog(mainWindow(), options)
  return result.canceled ? null : result.filePaths
}

/** Takes the MCP servers of a dsh home over, keys and all (dsh-mcp-import.ts); names already in use are skipped. */
const importDsh = (dir: string) => importDshServers({ dir, store: mcpStore, takenNames: takenServerNames })

async function chooseDshDir(): Promise<string | null> {
  const result = await dialog.showOpenDialog(mainWindow(), {
    title: t("main.main.choose.the.dsh.folder.usually.named.dsh"), defaultPath: os.homedir(), properties: ['openDirectory', 'showHiddenFiles'],
  })
  return result.canceled ? null : result.filePaths[0] ?? null
}

/** The 后台 page, from a notification or the tray: the window in front, on that page. */
function openTasksPage() {
  showWindow()
  if (win && !win.isDestroyed()) win.webContents.send('island:action', { kind: 'tasks' })
}

/** A follow-up's notice as a system notification; clicked, it opens the 后台 page. */
function showNotice(notice: Notice) {
  // Native Windows notifications may register/update a Start-menu shortcut for
  // our app ID. Automated smoke runs must not point that shortcut at a QA binary.
  // Notification planning/delivery is tested with injected notifiers separately.
  if (automationMode) return
  if (!Notification.isSupported()) return
  const shown = new Notification({ title: notice.title, body: notice.body })
  const shownAt = Date.now()
  shownNotices.add(shown)
  const done = () => shownNotices.delete(shown)
  shown.on('click', () => {
    done()
    // How long it took the user to open it: the week of self-use asks whether notices come at the right time.
    followups?.store.logEvent('notice_opened', { kind: notice.kind, afterMs: Date.now() - shownAt })
    openTasksPage()
  })
  shown.on('close', done)
  // Some systems never say a notification closed: let it go after a while.
  setTimeout(done, NOTICE_KEEP_MS).unref?.()
  shown.show()
}

/** 安装消息源: a folder with a viva-source.json in it. */
async function chooseSourceFolder(): Promise<string | null> {
  const result = await dialog.showOpenDialog(mainWindow(), { title: t("main.main.choose.a.source.folder.containing.viva.source"), properties: ['openDirectory'] })
  return result.canceled ? null : result.filePaths[0] ?? null
}

function registerPersonalIpc(config: Config, mcpStore: ReturnType<typeof createMcpConfigStore>) {
  registerMemoryIpc(ipcMain, {
    db: memoryDb,
    habits: () => personal.habits(),
    cwd: () => config.cwd,
    chooseDocs: () => pickFiles({ title: t("main.main.choose.reference.documents"), properties: ['openFile', 'multiSelections'] }),
  })
  registerModelsIpc(ipcMain, { store: modelStore, restart: restartKeepingConversation })
  registerExtensionsIpc(ipcMain, {
    store: mcpStore,
    roots: () => skillRoots({ dshHome: dshHomeOf(config), cwd: workDirNow() ?? config.cwd }),
    mcpStatus: () => ({ ...personal.mcpStatus(lastInfo, launchedAt), plugins: pluginProblems }),
    applyMcp: applyMcpChange,
    trash: (file) => shell.trashItem(file),
    dshDirs: () => ({ defaultDir: userDshHome(), lastDir: preferences.get().dshImportDir }),
    chooseDshDir,
    importDsh,
    rememberDshDir: (dir) => preferences.set('dshImportDir', dir),
  })
}

/** Profile and memories live next to the history; the memory plugin inside dsh opens the same file. */
function openPersonal(config: Config) {
  const userData = app.getPath('userData')
  memoryDb = openMemoryDb({ file: path.join(userData, 'memory.db') })
  try {
    traceDb = openTraceDb({ file: path.join(userData, 'trace.db') })
  } catch (err: any) {
    console.error('[trace] could not open trace.db; reopened conversations fall back to dsh logs:', err.message)
  }
  mcpStore = createMcpConfigStore({
    file: path.join(userData, 'mcp-servers.json'),
    crypto: safeStorage,
    onError: (err) => console.error('[mcp]', err.message),
  })
  personal = createPersonal({ memoryDb, historyDb, mcpStore })
  registerPersonalIpc(config, mcpStore)
  sources = openSources({
    userData,
    crypto: safeStorage,
    ipcMain,
    openPath: (dir) => shell.openPath(dir),
    chooseFolder: chooseSourceFolder,
    trash: (dir) => shell.trashItem(dir),
    onError: (err) => console.error('[sources]', err.message),
    onMessages: () => followups?.scheduler.refresh(),
  })
  const sourcesDb = sources.db
  followups = openFollowups({
    userData,
    ipcMain,
    notify: showNotice,
    windowInFront,
    onPending: (count) => {
      pendingFollowups = count
      tray?.setPending(count)
      // Something changed in the main process (a suggestion, a draft, a reminder): the window shows it as it is now.
      emitToRenderer({ type: 'followups_changed' })
    },
    idleSeconds: () => powerMonitor.getSystemIdleTime(),
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
    messages: {
      unjudged: (limit) => sourcesDb.unjudged(limit),
      oldestUnjudgedAt: () => sourcesDb.oldestUnjudgedAt(),
      markJudged: (items) => sourcesDb.markJudged(items),
      message: (source, id) => sourcesDb.message(source, id),
    },
  })
}

/** Opens the database, imports the old JSON history once, and drops conversations whose undo window has passed. */
function openHistory(config: Config) {
  const userData = app.getPath('userData')
  historyDb = openHistoryDb({ file: path.join(userData, 'history.db') })
  const imported = migrateLegacyHistory({
    dir: path.join(userData, 'history'),
    db: historyDb,
    onError: (err) => console.error('[history]', err.message),
  })
  if (imported) process.stdout.write(`[history] imported ${imported} conversation(s) from the old JSON files\n`)
  historyDb.purgeDeleted({ olderThanMs: 0 })
  conversation = historyDb.latest()?.conversation ?? historyDb.create({ cwd: config.cwd })
  registerHistoryIpc(ipcMain, {
    db: historyDb,
    dshHome: dshHomeOf(config),
    traceDb: () => traceDb,
    current: () => conversation,
    setCurrent: (next) => { conversation = next },
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
    setCurrent: (next) => { conversation = next },
    isBusy: () => turn.active,
    agentInfo: () => lastInfo,
    forkAgent: forkBack,
    switchAgent,
    traceDb: () => traceDb,
  })
  registerTaskIpc(ipcMain, {
    registry: taskRegistry,
    db: historyDb,
    // Tasks still going, kept so the next launch can offer to take them up (dsh ends with the app).
    store: taskStore = createTaskStore({ file: path.join(userData, 'background-tasks.json'), onError: (err) => console.error('[tasks]', err.message) }),
    current: () => conversation,
    setCurrent: (next) => { conversation = next },
    isBusy: () => turn.active,
    setBusy: (active) => { turn = { ...turn, active } },
    agentInfo: () => lastInfo,
    agent: taskAgent,
  })
}

/** The agent's side of background tasks; a change of the main session is the one shown from then on. */
const withInfo = <R extends { ok: boolean, info?: any }>(result: R): R => {
  if (result.ok) lastInfo = { ...result.info, remembersHistory: true }
  return result
}
type Bridge = ReturnType<typeof createAcpBridge>
const taskAgent = {
  spinOff: async (request: { words: string }) => withInfo(await requireBridge().spinOff(request)),
  mergeBack: async (taskId: string) => withInfo(await requireBridge().mergeBack(taskId)),
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

/** Run from the repository, the app shows its own icon instead of Electron's. */
function useDevIcon() {
  const icon = devIcon({ platform: process.platform, packaged: app.isPackaged, appRoot: APP_ROOT })
  if (!icon || !fs.existsSync(icon)) return null
  if (process.platform === 'darwin') app.dock?.setIcon(icon)
  return process.platform === 'darwin' ? null : icon
}

function createWindow(config: Config) {
  const icon = useDevIcon()
  const created = new BrowserWindow({
    ...windowSize(screen.getPrimaryDisplay().workAreaSize),
    ...windowChrome(process.platform),
    ...(icon ? { icon } : {}),
    show: false,
    backgroundColor: '#060B16',
    webPreferences: {
      preload: path.join(CODE_ROOT, 'src', 'preload', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // A smoke run goes on unwatched in the background, where the page and timers would be slowed down.
      backgroundThrottling: !automationMode,
    },
  })
  win = created
  attachDeskIsland(config, created)
  created.once('ready-to-show', () => {
    if (!startedHidden || automationMode) return created.show()
    // Started with the computer: in the tray, the island on the desktop, until the user opens it.
    showTray()
    desk?.setAway(true)
  })
  // Coming back to the window is one of the user's gaps.
  created.on('focus', () => followups?.gap())
  // The page never leaves index.html and never opens windows: links go to the browser (shell:open-link).
  created.webContents.on('will-navigate', (event) => event.preventDefault())
  created.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  created.webContents.once('did-finish-load', () => { startBridge() })
  created.loadFile(path.join(CODE_ROOT, 'src', 'renderer', 'index.html'))
}

// Windows shows a notification only for the app its Start menu shortcut names (the installer's, electron-builder appId).
if (process.platform === 'win32') app.setAppUserModelId('app.viva.desktop')
// Before the app is ready: the pages load pasted pictures by name from viva-image:// (image-protocol.js).
protocol.registerSchemesAsPrivileged([IMAGE_SCHEME_PRIVILEGES])
// dsh's home is the app's own now, so a second copy of the app would share it: hand over to the first.
if (!app.requestSingleInstanceLock()) app.exit(0)
app.on('second-instance', () => showWindow())
// macOS: clicking the Dock icon brings back a window closed to the tray.
app.on('activate', () => showWindow())

/** Conversations and memories kept under the app's old name, my-agent, come along on the first launch as Viva. */
function bringLegacyData() {
  try {
    const copied = adoptLegacyData({ userData: app.getPath('userData'), legacyDir: path.join(app.getPath('appData'), LEGACY_NAME) })
    if (copied.length) process.stdout.write(`[viva] copied ${copied.join(', ')} from the ${LEGACY_NAME} data folder\n`)
  } catch (err: any) {
    console.error(`[viva] could not copy the ${LEGACY_NAME} data:`, err.message)
  }
}

/**
 * The app's dsh used to live in the user's own ~/.dsh: its sessions come along (old conversations still
 * resume) and the profiles it wrote there go. The user's own sessions and profiles stay where they are.
 */
function bringDshData(config: Config) {
  const fromHome = userDshHome()
  try {
    const toHome = dshHomeOf(config)
    const sessions = adoptDshSessions({ fromHome, toHome, cwd: config.cwd })
    const skills = adoptDshSkills({ fromHome, toHome })
    const removed = removeOwnProfiles({ fromHome, toHome })
    if (sessions || skills.length || removed.length) {
      process.stdout.write(`[viva] moved to the app's own dsh home: ${sessions} sessions, skills ${skills.join(', ') || 'none'}; profiles removed: ${removed.join(', ') || 'none'}\n`)
    }
  } catch (err: any) {
    console.error(`[viva] could not bring the sessions over from ${fromHome}:`, err.message)
  }
}

app.whenReady().then(async () => {
  // macOS needs its app menu for ⌘C / ⌘V; elsewhere the hidden title bar has no room for a menu bar.
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null)
  settingsStore = createSettingsStore({
    file: path.join(app.getPath('userData'), 'settings.json'),
    crypto: safeStorage,
    onError: (err) => console.error('[settings] could not read saved settings:', err.message),
  })
  preferences = createPreferences({
    file: path.join(app.getPath('userData'), 'preferences.json'),
    onError: (err) => console.error('[preferences] could not read them, using the defaults:', err.message),
  })
  registerLanguageIpc(ipcMain, {
    getLanguage: () => preferences.get().language,
    saveLanguage: (language) => { preferences.set('language', language) },
    systemLocale: () => app.getLocale(),
    refreshNative: () => tray?.setPending(pendingFollowups),
    broadcast: (state) => { for (const window of BrowserWindow.getAllWindows()) window.webContents.send('language:changed', state) },
  })
  modelStore = createModelStore({
    file: path.join(app.getPath('userData'), 'models.json'),
    crypto: safeStorage,
    onError: (err) => console.error('[models] could not read the model providers:', err.message),
  })
  imageStore = createImageStore({ dir: imagesDir })
  registerImageProtocol(protocol, imageStore)
  registerImageIpc(ipcMain, {
    store: imageStore,
    setDir: (dir) => preferences.set('imagesDir', dir),
    chooseFolder: async () => {
      const result = await dialog.showOpenDialog(mainWindow(), { title: t("main.main.where.should.images.be.stored"), properties: ['openDirectory', 'createDirectory'] })
      return result.canceled ? null : result.filePaths[0] ?? null
    },
    reveal: (dir) => shell.openPath(dir),
    isBusy: () => turn.active,
    restart: restartKeepingConversation,
  })
  registerAgentIpc()
  registerSettingsIpc()
  registerIslandIpc(ipcMain, { desk: () => desk, window: () => win, showWindow, Menu, switchOff: switchOffDesk })
  const config = currentConfig()
  defaultWorkDir = config.cwd
  // Set just above, so the folder in use is always one from here on.
  const workDirInUse = () => workDirNow() ?? config.cwd
  registerFilesIpc(ipcMain, { root: workDirInUse, shell, notify: emitToRenderer })
  registerWorkDirIpc(ipcMain, {
    current: workDirInUse,
    defaultDir: config.cwd,
    preferences,
    chooseFolder: chooseWorkFolder,
    isBusy: () => turn.active,
    switchTo: switchWorkDir,
    reveal: (dir) => shell.openPath(dir),
  })
  if (!automationMode) {
    bringLegacyData()
    bringDshData(config)
  }
  openHistory(config)
  openPersonal(config)
  installAutomationDriver(automationMode, {
    agentPid: () => bridge?.pid() ?? null, desk: () => desk,
    sources: () => sources, followups: () => followups,
  })
  // The computer back from sleep, or unlocked: reminders missed meanwhile go out, merged into one.
  // Timers slept with the computer: preparation and the sources look again from now.
  const woke = () => {
    followups?.notifier.wake()
    followups?.scheduler.refresh()
    sources?.wakeUp()
  }
  powerMonitor.on('resume', woke)
  powerMonitor.on('unlock-screen', woke)
  createWindow(config)
  registerShortcut(config)
}).catch((err) => {
  // Without a window there is nothing to show the error in, and the process would stay on with nothing to see.
  console.error('[viva] could not start:', err)
  dialog.showErrorBox(t("main.main.viva.could.not.start"), err?.message ?? String(err))
  app.exit(1)
})

app.on('window-all-closed', () => app.quit())
/** Quitting waits for dsh to finish (it may still be writing the session), up to QUIT_WAIT_MS. */
app.on('before-quit', (event) => {
  if (quitting || !bridge) {
    quitting = true
    return
  }
  event.preventDefault()
  quitting = true
  stopBridgeInTime().finally(() => app.quit())
})
app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  tray?.destroy()
  clearInterval(lateMemoryTimer)
  sources?.close()
  followups?.close()
  historyDb?.close()
  memoryDb?.close()
  traceDb?.close()
})

onLocaleChange(() => {
  SETUP_MESSAGES = { 'no-key': t("main.main.enter.a.deepseek.api.key.or.add"), 'no-dsh': t("main.main.deepseek.harness.not.found.run.npm.install") }
  FORK_PROBLEMS = Object.freeze({
  unavailable: t("main.main.this.assistant.version.cannot.change.working.directories"),
  missing: t("main.main.this.conversation.has.ended.try.again.later"),
})
})

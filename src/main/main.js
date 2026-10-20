import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, nativeImage, powerSaveBlocker, safeStorage, screen, shell, Tray } from 'electron'
import { openMemoryDb } from '../../plugins/memory/lib/store.js'
import { openTraceDb } from '../../plugins/trace/lib/store.js'
import { installedDshVersion, PERSONA, resolvePlugins } from './app-plugins.js'
import { APP_ROOT, DSH_PROFILE, resolveConfig } from './config.js'
import { createAcpBridge } from './acp-bridge.js'
import { createDeskIsland } from './desk-island.js'
import { adoptDshSessions, adoptDshSkills, removeOwnProfiles } from './dsh-migrate.js'
import { ensureDshProfile } from './dsh-profile.js'
import { dshEnv, restartDelay } from './dsh-runtime.js'
import { registerExtensionsIpc } from './extensions-ipc.js'
import { registerFilesIpc } from './files-ipc.js'
import { openHistoryDb } from './history-db.js'
import { registerHistoryIpc } from './history-ipc.js'
import { migrateLegacyHistory } from './history-migrate.js'
import { ASK_SHORTCUT, registerAskShortcut, registerIslandIpc } from './island-main.js'
import { createTray } from './tray.js'
import { adoptLegacyData, LEGACY_NAME } from './legacy-data.js'
import { externalUrl } from './links.js'
import { createMcpConfigStore, parseServerInput } from './mcp-config.js'
import { registerMemoryIpc } from './memory-ipc.js'
import { createModelStore, defaultModel, modelValue, parseModelValue, piAiProviders, providerEnv } from './model-providers.js'
import { registerModelsIpc } from './models-ipc.js'
import { createPersonal } from './personal.js'
import { createPreferences } from './preferences.js'
import { removeTree } from './remove-tree.js'
import { CONFIG_IDS } from './session-info.js'
import { createSettingsStore, keyHint } from './settings-store.js'
import { createSkill, importSkill, listSkills, removeSkill, skillRoots } from './skills.js'
import { runSmoke } from './smoke.js'
import { devIcon, windowChrome, windowSize } from './window-options.js'

const MAX_PROMPT_CHARS = 20_000
const MAX_KEY_CHARS = 1_000
/** dsh's stock ACP profile: used, without memory, when the app's own profile can't be written. */
const FALLBACK_PROFILE = 'acp'
/** After a turn the memory plugin's background pass may still write; look again this often, this long. */
const LATE_MEMORY_POLL_MS = 2_000
const LATE_MEMORY_WINDOW_MS = 30_000

let settingsStore = null
/** Switches from settings, such as the desktop island (preferences.js). */
let preferences = null
/** False in smoke runs, which turn the desktop island on only while they check it. */
let deskAllowed = true
/** Model providers the user added besides DeepSeek; see model-providers.js. */
let modelStore = null
let historyDb = null
/** The user's MCP servers, encrypted where they hold keys (mcp-config.js). */
let mcpStore = null
/** An MCP server was added or removed from the conversation: reattach the session once the turn is over. */
let mcpReloadDue = false
let memoryDb = null
/** What the trace plugin recorded, for the 过程 of reopened conversations; null if it can't be opened. */
let traceDb = null
/** Plugins left out of the profile at the last launch, and why; shown in settings. */
let pluginProblems = []
/** Habits, turn reports and the user's MCP servers; memory itself is the dsh plugin. See personal.js. */
let personal = null
/** When the running dsh was launched: the memory plugin must have started after it to count as working. */
let launchedAt = 0
/** The turn in progress: memories the agent saves during it are reported when it ends. */
let turn = { active: false, startedAt: 0 }
let lateMemoryTimer = null
/** The conversation on screen: the latest one at launch, one picked from the history panel, or a fresh one. */
let conversation = null
let win = null
/** The island on the desktop, shown while the window is in the background (desk-island.js). */
let desk = null
/** The tray icon, made the first time the window is closed to it (tray.js). */
let tray = null
/** Whether the shortcut that opens the island's input is ours (another app may hold it); null before it is tried. */
let shortcutHeld = null
let bridge = null
let bridgeGeneration = 0
/** When dsh died on its own lately; see restartDelay. */
let crashes = []
let restartTimer = null
/** Set once quitting has begun: dsh is being stopped and must not be started again. */
let quitting = false
/** How long quitting waits for dsh to finish before the app goes anyway. */
const QUIT_WAIT_MS = 5_000
let lastInfo = { mode: 'connecting', model: '', cwd: '', reason: '' }

/** Smoke runs get their own userData, so they never read or overwrite the real history and key. */
function isolateSmokeUserData() {
  const { smoke, smokePhase, smokeOut } = resolveConfig(process.env, fs.existsSync)
  if (!smoke) return
  // `relaunch` reopens what `walkthrough` left; the other phases start from nothing of their own.
  const shared = smokePhase === 'walkthrough' || smokePhase === 'relaunch'
  const dir = path.join(smokeOut, shared ? 'userData' : `userData-${smokePhase}`)
  if (smokePhase !== 'relaunch') removeTree(dir)
  // dsh's home is inside userData (dsh-runtime.js), so it is the smoke run's own too; so is the workspace,
  // so a smoke run never writes into the developer's.
  app.setPath('userData', dir)
  process.env.AGENT_CWD ||= path.join(dir, 'workspace')
}

function emitToRenderer(event) {
  if (event.type === 'ready') lastInfo = event.info
  if (event.type === 'config') lastInfo = { ...lastInfo, ...event.info }
  if (win && !win.isDestroyed()) win.webContents.send('agent:event', event)
}

const currentConfig = () => resolveConfig(process.env, fs.existsSync, settingsStore.getApiKey(), modelStore.list().length > 0, {
  userData: app.getPath('userData'), execPath: process.execPath, packaged: app.isPackaged,
})

/** Tells the window what the agent remembered or replaced, and what background the plugin sent. */
function reportMemoryChanges() {
  try {
    const report = personal.collect({ conversationId: conversation.id, sessionId: conversation.sessionId })
    if (report?.memories.length || report?.invalidated.length) {
      emitToRenderer({ type: 'memory_changed', memories: report.memories, invalidated: report.invalidated })
    }
    if (report?.injected.length) emitToRenderer({ type: 'memory_context', injected: report.injected })
  } catch (err) {
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
function prepareProfile(config) {
  try {
    const { plugins, problems } = resolvePlugins({
      appRoot: APP_ROOT, userData: app.getPath('userData'), dshVersion: installedDshVersion(APP_ROOT),
    })
    pluginProblems = problems
    problems.forEach(({ name, problem }) => console.error(`[plugins] ${name} left out: ${problem}`))
    ensureDshProfile({ dshHome: config.dshHome, profile: DSH_PROFILE, plugins, persona: PERSONA, models: profileModels(config) })
    return DSH_PROFILE
  } catch (err) {
    console.error('[plugins] could not prepare the dsh profile, starting without the app plugins:', err.message)
    return FALLBACK_PROFILE
  }
}

/** The models dsh offers: DeepSeek with a key, the user's providers, and the one new sessions start with. */
function profileModels(config) {
  const providers = modelStore.list()
  const hasDeepSeek = Boolean(config.apiKey)
  return { providers: piAiProviders(providers), deepseek: hasDeepSeek, defaultModel: defaultModel({ lastModel: modelStore.lastModel(), providers, hasDeepSeek }) }
}

/** Events from a replaced bridge are dropped so a restart can't leak into the new conversation. */
/** The settings form's shape, which parseServerInput checks: keys as "NAME=value" lines, env or headers by type. */
function serverForm(spec, secrets) {
  const pairs = Object.entries(secrets).map(([name, value]) => `${name}=${value}`).join('\n')
  const http = Boolean(spec.url)
  return { name: spec.name, type: http ? 'http' : 'stdio', command: spec.command, args: spec.args.join('\n'), url: spec.url, env: http ? '' : pairs, headers: http ? pairs : '' }
}

const takenServerNames = () => mcpStore.list().map((server) => server.name)

/**
 * What the model may change from the conversation (viva-config plugin, config-channel.js), each after the
 * user approved it on the card: MCP servers through the encrypted store, skills in the app's own folder.
 */
function configActions(config) {
  const roots = () => skillRoots({ dshHome: config.dshHome, cwd: config.cwd })
  const userRoot = () => roots().find((root) => root.managed).dir
  return {
    listServers: () => mcpStore.list().map((server) => `${server.name}（${server.type === 'http' ? server.url : [server.command, ...server.args].join(' ')}）`),
    prepareServer: (spec) => {
      parseServerInput(serverForm(spec, Object.fromEntries(spec.secrets.map((name) => [name, 'x']))), takenServerNames())
    },
    addServer: (spec, secrets) => {
      mcpStore.add(parseServerInput(serverForm(spec, secrets), takenServerNames()))
      mcpReloadDue = true
      return `已接入 MCP 服务器「${spec.name}」，这一轮结束后生效${spec.secrets.length ? '；密钥由用户在窗口里填写并加密保存' : ''}。`
    },
    removeServer: (name) => {
      if (!takenServerNames().includes(name)) throw new Error(`没有名为「${name}」的 MCP 服务器`)
      mcpStore.remove(name)
      mcpReloadDue = true
      return `已移除 MCP 服务器「${name}」，这一轮结束后生效。`
    },
    listSkills: () => listSkills(roots()).map((skill) => `${skill.id}：${skill.name}${skill.description ? ` — ${skill.description}` : ''}${skill.problem ? `（${skill.problem}）` : ''}`),
    createSkill: (spec) => `已新建 skill「${createSkill(spec, userRoot())}」，下次遇到同类事会用上。`,
    installSkill: (source) => `已安装 skill「${importSkill(source, userRoot())}」。`,
    removeSkill: async (id) => `已删除 skill「${await removeSkill(id, roots(), (file) => shell.trashItem(file))}」，可以在废纸篓里找回。`,
  }
}

function reloadMcpAfterTurn() {
  mcpReloadDue = false
  applyMcpChange()
    .then((info) => info && emitToRenderer({ type: 'config', info }))
    .catch((err) => console.error('[mcp] could not reattach the session after a change:', err.message))
}

function createBridge(config) {
  const generation = ++bridgeGeneration
  return createAcpBridge({
    dshBin: config.dshBin,
    nodeBin: config.nodeBin,
    profile: prepareProfile(config),
    cwd: config.cwd,
    env: dshEnv({ base: process.env, dshHome: config.dshHome, runtime: config.runtime, settings: dshSettings(config) }),
    mcpServers: () => personal.mcpServers(),
    configActions: configActions(config),
    emit: (event) => {
      if (generation !== bridgeGeneration) return
      emitToRenderer(event)
      if (event.type === 'turn_end' || event.type === 'error') reportTurnMemories()
      if (event.type === 'turn_end' && mcpReloadDue) reloadMcpAfterTurn()
    },
    onExit: (exit) => {
      if (generation === bridgeGeneration) recoverFromCrash(exit)
    },
  })
}

/** What the app hands dsh: the keys, and in the memory smoke run the fake model's address. */
function dshSettings(config) {
  return {
    DEEPSEEK_API_KEY: config.apiKey,
    ...providerEnv(modelStore.list()),
    ...(config.smoke && process.env.DEEPSEEK_BASE_URL ? { DEEPSEEK_BASE_URL: process.env.DEEPSEEK_BASE_URL } : {}),
  }
}

/** dsh died on its own: start it again on the conversation on screen, waiting longer each time, until it keeps dying. */
function recoverFromCrash({ message }) {
  console.error('[dsh] exited unexpectedly:', message)
  bridge = null
  turn = { active: false, startedAt: 0 }
  if (quitting) return
  const now = Date.now()
  crashes = [...crashes.filter((at) => now - at < 10 * 60_000), now]
  const delay = restartDelay(crashes, now)
  if (delay === null) {
    emitToRenderer({ type: 'error', message: `助手连续意外退出，已停止重试：${message}。可以检查设置后重新打开应用。` })
    return
  }
  emitToRenderer({ type: 'error', message: `助手意外退出，${Math.round(delay / 1000)} 秒后自动重新连接…` })
  clearTimeout(restartTimer)
  restartTimer = setTimeout(() => {
    if (!bridge && !quitting) startBridge()
  }, delay)
}

/** Stops the running dsh and waits until it has exited, so a new one never shares its session files. */
async function stopBridge() {
  clearTimeout(restartTimer)
  const running = bridge
  bridge = null
  await running?.dispose()
}

/** Nothing to start yet (no key, or dsh not installed): the window shows how to fix it. */
const setupInfo = (config) => ({ mode: 'setup', problem: config.problem, cwd: config.cwd, model: '', models: [], efforts: [], reason: '' })
const SETUP_MESSAGES = { 'no-key': '请先在设置里填写 DeepSeek API key，或添加其他模型', 'no-dsh': '没有找到 DeepSeek Harness，请在项目目录运行 npm install' }

function requireBridge() {
  if (!bridge) throw new Error(SETUP_MESSAGES[lastInfo.problem] ?? '助手还没有连接')
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
  bridge = createBridge(config)
  try {
    const started = await bridge.start({ resumeSessionId: conversation.sessionId })
    // The agent knows the conversation on screen if it resumed it, or if there was nothing to know yet.
    const info = { ...started, remembersHistory: started.resumed || !historyDb.get(conversation.id) }
    conversation = { ...conversation, sessionId: info.sessionId }
    emitToRenderer({ type: 'ready', info })
    return info
  } catch (err) {
    console.error('[main] failed to start agent bridge:', err)
    emitToRenderer({ type: 'error', message: `连接助手失败：${err.message}` })
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
async function withLastModel(info) {
  const last = modelStore.lastModel()
  if (!last) return info
  const value = modelValue(last)
  if (info.modelValue === value || !info.models?.some((model) => model.value === value)) return info
  return { ...info, ...await bridge.setConfig('model', value) }
}

/** A new key (or none) means a different agent, so the conversation starts over. */
async function restartWithNewConversation() {
  conversation = historyDb.create()
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
  }
}

function assertText(value, name, maxLength) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > maxLength) {
    throw new Error(`invalid ${name}`)
  }
  return value
}

function registerAgentIpc() {
  ipcMain.handle('agent:info', () => lastInfo)
  ipcMain.handle('agent:prompt', (_event, text) => {
    const question = assertText(text, 'prompt', MAX_PROMPT_CHARS)
    const agent = requireBridge()
    try {
      personal.habits()
    } catch (err) {
      console.error('[memory] could not update the habits:', err.message)
    }
    turn = { active: true, startedAt: Date.now() }
    return agent.prompt(question)
  })
  ipcMain.handle('agent:cancel', () => bridge?.cancel())
  ipcMain.handle('agent:new-session', async () => {
    if (!bridge) {
      conversation = historyDb.create()
      return lastInfo
    }
    const info = { ...await withLastModel(await bridge.newSession()), remembersHistory: true }
    conversation = historyDb.create({ sessionId: info.sessionId })
    lastInfo = info
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

/** The shortcut that opens the island's input, from any app; not in smoke runs, which share the machine. */
function registerShortcut(config) {
  if (config.smoke) return
  shortcutHeld = registerAskShortcut(globalShortcut, {
    foreground: windowInFront,
    focusComposer: () => win.webContents.send('composer:focus'),
    openInput: () => desk?.openInput() ?? false,
    showWindow,
  })
}

/** Closing the window keeps Viva running in the tray, with the island on the desktop. */
function closeToTray() {
  win.hide()
  tray ??= createTray({
    Tray, Menu, nativeImage,
    iconDir: path.join(APP_ROOT, 'src', 'assets', 'tray'),
    platform: process.platform,
    onOpen: showWindow,
    onQuit: () => app.quit(),
  })
  desk?.setAway(true)
}

/**
 * The desktop island comes out when the window is closed to the tray and goes when it is shown again; a smoke
 * run turns it on only when it checks it, and closes the window for real.
 */
function attachDeskIsland(config) {
  deskAllowed = !config.smoke
  desk = createDeskIsland({
    BrowserWindow,
    screen,
    preload: path.join(APP_ROOT, 'src', 'preload', 'desk-preload.cjs'),
    page: path.join(APP_ROOT, 'src', 'renderer', 'desk.html'),
    mainWindow: win,
    enabled: deskAllowed && preferences.get().deskIsland,
    places: { get: () => preferences.get().deskPlaces, set: (places) => preferences.set('deskPlaces', places) },
    coach: { get: () => preferences.get().deskCoached, set: () => preferences.set('deskCoached', true) },
  })
  win.on('close', (event) => {
    if (quitting || config.smoke) return
    event.preventDefault()
    closeToTray()
  })
  win.on('show', () => desk?.setAway(false))
  // Windows logging off or shutting down closes the window for real, or it would hold the session up.
  win.on('session-end', () => {
    quitting = true
  })
  win.on('closed', () => {
    desk?.destroy()
    desk = null
  })
}

/** The desktop island's switch, from settings or from 关闭桌面岛 in the island's menu. */
function setDeskIsland(on) {
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

/** Without an agent (setup state) an old conversation can still be read; it keeps its session for later. */
async function switchAgent(sessionId) {
  if (!bridge) return { ...lastInfo, sessionId, resumed: false }
  const info = await bridge.switchSession(sessionId)
  lastInfo = { ...info, remembersHistory: info.resumed }
  return info
}

async function chooseExportPath(defaultName) {
  const result = await dialog.showSaveDialog(win, {
    title: '导出对话',
    defaultPath: path.join(app.getPath('documents'), defaultName),
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  })
  return result.canceled ? null : result.filePath
}

/** Reattaches the session with the current MCP servers; not while a turn runs (it would be cancelled). */
async function applyMcpChange() {
  if (!bridge || turn.active) return null
  const info = await bridge.reloadSession()
  lastInfo = { ...lastInfo, ...info, remembersHistory: info.resumed || lastInfo.remembersHistory }
  return lastInfo
}

const pickFiles = async (options) => {
  const result = await dialog.showOpenDialog(win, options)
  return result.canceled ? null : result.filePaths
}

function registerPersonalIpc(config, mcpStore) {
  registerMemoryIpc(ipcMain, {
    db: memoryDb,
    habits: () => personal.habits(),
    cwd: () => config.cwd,
    chooseDocs: () => pickFiles({ title: '选择常用文档', properties: ['openFile', 'multiSelections'] }),
  })
  registerModelsIpc(ipcMain, { store: modelStore, restart: restartKeepingConversation })
  registerExtensionsIpc(ipcMain, {
    store: mcpStore,
    roots: () => skillRoots({ dshHome: config.dshHome, cwd: config.cwd }),
    mcpStatus: () => ({ ...personal.mcpStatus(lastInfo, launchedAt), plugins: pluginProblems }),
    applyMcp: applyMcpChange,
    trash: (file) => shell.trashItem(file),
  })
}

/** Profile and memories live next to the history; the memory plugin inside dsh opens the same file. */
function openPersonal(config) {
  const userData = app.getPath('userData')
  memoryDb = openMemoryDb({ file: path.join(userData, 'memory.db') })
  try {
    traceDb = openTraceDb({ file: path.join(userData, 'trace.db') })
  } catch (err) {
    console.error('[trace] could not open trace.db; reopened conversations fall back to dsh logs:', err.message)
  }
  mcpStore = createMcpConfigStore({
    file: path.join(userData, 'mcp-servers.json'),
    crypto: safeStorage,
    onError: (err) => console.error('[mcp]', err.message),
  })
  personal = createPersonal({ memoryDb, historyDb, mcpStore })
  registerPersonalIpc(config, mcpStore)
}

/** Opens the database, imports the old JSON history once, and drops conversations whose undo window has passed. */
function openHistory(config) {
  const userData = app.getPath('userData')
  historyDb = openHistoryDb({ file: path.join(userData, 'history.db') })
  const imported = migrateLegacyHistory({
    dir: path.join(userData, 'history'),
    db: historyDb,
    onError: (err) => console.error('[history]', err.message),
  })
  if (imported) process.stdout.write(`[history] imported ${imported} conversation(s) from the old JSON files\n`)
  historyDb.purgeDeleted({ olderThanMs: 0 })
  conversation = historyDb.latest()?.conversation ?? historyDb.create()
  registerHistoryIpc(ipcMain, {
    db: historyDb,
    dshHome: config.dshHome,
    traceDb: () => traceDb,
    current: () => conversation,
    setCurrent: (next) => { conversation = next },
    agentInfo: () => lastInfo,
    switchAgent,
    chooseExportPath,
  })
}

/** Run from the repository, the app shows its own icon instead of Electron's. */
function useDevIcon() {
  const icon = devIcon({ platform: process.platform, packaged: app.isPackaged, appRoot: APP_ROOT })
  if (!icon || !fs.existsSync(icon)) return null
  if (process.platform === 'darwin') app.dock?.setIcon(icon)
  return process.platform === 'darwin' ? null : icon
}

function createWindow(config) {
  const icon = useDevIcon()
  win = new BrowserWindow({
    ...windowSize(screen.getPrimaryDisplay().workAreaSize),
    ...windowChrome(process.platform),
    ...(icon ? { icon } : {}),
    show: false,
    backgroundColor: '#060B16',
    webPreferences: {
      preload: path.join(APP_ROOT, 'src', 'preload', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // A smoke run goes on unwatched in the background, where the page and timers would be slowed down.
      backgroundThrottling: !config.smoke,
    },
  })
  attachDeskIsland(config)
  win.once('ready-to-show', () => win.show())
  // The page never leaves index.html and never opens windows: links go to the browser (shell:open-link).
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.once('did-finish-load', () => {
    startBridge()
    if (config.smoke) {
      // Nor may macOS App Nap suspend the app (and the fake model it serves) while nobody looks.
      powerSaveBlocker.start('prevent-app-suspension')
      runSmoke(win, config, (code) => app.exit(code), {
        agentPid: () => bridge?.pid() ?? null, desk: () => desk, cwd: config.cwd, userData: app.getPath('userData'), model: () => smokeModel,
      })
    }
  })
  win.loadFile(path.join(APP_ROOT, 'src', 'renderer', 'index.html'))
}

isolateSmokeUserData()
// dsh's home is the app's own now, so a second copy of the app would share it: hand over to the first.
if (!app.requestSingleInstanceLock()) app.exit(0)
app.on('second-instance', () => showWindow())
// macOS: clicking the Dock icon brings back a window closed to the tray.
app.on('activate', () => showWindow())

/** The memory smoke run's stand-in model, kept so the run can check what the model was sent. */
let smokeModel = null

/** The memory smoke run talks to the real dsh, which calls a local stand-in for the DeepSeek API. */
async function startSmokeModel() {
  // A file URL: import() takes `C:\...` for a URL scheme on Windows.
  // The installed app has no test folder; SMOKE_FIXTURES points a smoke run of it at the repository's.
  const fixtures = process.env.SMOKE_FIXTURES || path.join(APP_ROOT, 'test', 'fixtures')
  const { startFakeLlm } = await import(pathToFileURL(path.join(fixtures, 'fake-llm.js')).href)
  smokeModel = await startFakeLlm()
  process.env.DEEPSEEK_BASE_URL = smokeModel.url
}

/** Conversations and memories kept under the app's old name, my-agent, come along on the first launch as Viva. */
function bringLegacyData() {
  try {
    const copied = adoptLegacyData({ userData: app.getPath('userData'), legacyDir: path.join(app.getPath('appData'), LEGACY_NAME) })
    if (copied.length) process.stdout.write(`[viva] copied ${copied.join(', ')} from the ${LEGACY_NAME} data folder\n`)
  } catch (err) {
    console.error(`[viva] could not copy the ${LEGACY_NAME} data:`, err.message)
  }
}

/**
 * The app's dsh used to live in the user's own ~/.dsh: its sessions come along (old conversations still
 * resume) and the profiles it wrote there go. The user's own sessions and profiles stay where they are.
 */
function bringDshData(config) {
  const fromHome = process.env.DSH_HOME ? path.resolve(process.env.DSH_HOME) : path.join(os.homedir(), '.dsh')
  try {
    const sessions = adoptDshSessions({ fromHome, toHome: config.dshHome, cwd: config.cwd })
    const skills = adoptDshSkills({ fromHome, toHome: config.dshHome })
    const removed = removeOwnProfiles({ fromHome, toHome: config.dshHome })
    if (sessions || skills.length || removed.length) {
      process.stdout.write(`[viva] moved to the app's own dsh home: ${sessions} sessions, skills ${skills.join(', ') || 'none'}; profiles removed: ${removed.join(', ') || 'none'}\n`)
    }
  } catch (err) {
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
  modelStore = createModelStore({
    file: path.join(app.getPath('userData'), 'models.json'),
    crypto: safeStorage,
    onError: (err) => console.error('[models] could not read the model providers:', err.message),
  })
  registerAgentIpc()
  registerSettingsIpc()
  registerIslandIpc(ipcMain, { desk: () => desk, window: () => win, busy: () => turn.active, showWindow, Menu, switchOffDesk })
  const config = currentConfig()
  registerFilesIpc(ipcMain, { root: () => config.cwd, shell, notify: emitToRenderer })
  if (config.smokePhase === 'memory') await startSmokeModel()
  if (!config.smoke) {
    bringLegacyData()
    bringDshData(config)
  }
  openHistory(config)
  openPersonal(config)
  createWindow(config)
  registerShortcut(config)
}).catch((err) => {
  // Without a window there is nothing to show the error in, and the process would stay on with nothing to see.
  console.error('[viva] could not start:', err)
  dialog.showErrorBox('Viva 无法启动', err?.message ?? String(err))
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
  const timeout = new Promise((resolve) => setTimeout(resolve, QUIT_WAIT_MS))
  Promise.race([stopBridge(), timeout]).finally(() => app.quit())
})
app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  tray?.destroy()
  clearInterval(lateMemoryTimer)
  historyDb?.close()
  memoryDb?.close()
  traceDb?.close()
})

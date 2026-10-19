import fs from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, Menu, safeStorage, screen, shell } from 'electron'
import { openMemoryDb } from '../../plugins/memory/lib/store.js'
import { openTraceDb } from '../../plugins/trace/lib/store.js'
import { installedDshVersion, PERSONA, resolvePlugins } from './app-plugins.js'
import { APP_ROOT, DSH_PROFILE, resolveConfig } from './config.js'
import { createAcpBridge } from './acp-bridge.js'
import { ensureDshProfile } from './dsh-profile.js'
import { registerExtensionsIpc } from './extensions-ipc.js'
import { openHistoryDb } from './history-db.js'
import { registerHistoryIpc } from './history-ipc.js'
import { migrateLegacyHistory } from './history-migrate.js'
import { createMcpConfigStore } from './mcp-config.js'
import { registerMemoryIpc } from './memory-ipc.js'
import { createPersonal } from './personal.js'
import { CONFIG_IDS } from './session-info.js'
import { createSettingsStore, keyHint } from './settings-store.js'
import { skillRoots } from './skills.js'
import { runSmoke } from './smoke.js'
import { windowChrome, windowSize } from './window-options.js'

const MAX_PROMPT_CHARS = 20_000
const MAX_KEY_CHARS = 1_000
/** dsh's stock ACP profile: used, without memory, when the app's own profile can't be written. */
const FALLBACK_PROFILE = 'acp'
/** After a turn the memory plugin's background pass may still write; look again this often, this long. */
const LATE_MEMORY_POLL_MS = 2_000
const LATE_MEMORY_WINDOW_MS = 30_000

let settingsStore = null
let historyDb = null
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
let bridge = null
let bridgeGeneration = 0
let lastInfo = { mode: 'connecting', model: '', cwd: '', reason: '' }

/** Smoke runs get their own userData, so they never read or overwrite the real history and key. */
function isolateSmokeUserData() {
  const { smoke, smokePhase, smokeOut } = resolveConfig(process.env, fs.existsSync)
  if (!smoke) return
  // `relaunch` reopens what `walkthrough` left; the other phases start from nothing of their own.
  const shared = smokePhase === 'walkthrough' || smokePhase === 'relaunch'
  const dir = path.join(smokeOut, shared ? 'userData' : `userData-${smokePhase}`)
  if (smokePhase !== 'relaunch') fs.rmSync(dir, { recursive: true, force: true })
  app.setPath('userData', dir)
  // The app writes its dsh profile on launch; a smoke run must not touch the real ~/.dsh.
  process.env.DSH_HOME = path.join(dir, 'dsh-home')
}

function emitToRenderer(event) {
  if (event.type === 'ready') lastInfo = event.info
  if (event.type === 'config') lastInfo = { ...lastInfo, ...event.info }
  if (win && !win.isDestroyed()) win.webContents.send('agent:event', event)
}

const currentConfig = () => resolveConfig(process.env, fs.existsSync, settingsStore.getApiKey())

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
    ensureDshProfile({ dshHome: config.dshHome, profile: DSH_PROFILE, plugins, persona: PERSONA })
    return DSH_PROFILE
  } catch (err) {
    console.error('[plugins] could not prepare the dsh profile, starting without the app plugins:', err.message)
    return FALLBACK_PROFILE
  }
}

/** Events from a replaced bridge are dropped so a restart can't leak into the new conversation. */
function createBridge(config) {
  const generation = ++bridgeGeneration
  return createAcpBridge({
    dshBin: config.dshBin,
    nodeBin: config.nodeBin,
    profile: prepareProfile(config),
    cwd: config.cwd,
    env: { ...process.env, DEEPSEEK_API_KEY: config.apiKey },
    mcpServers: () => personal.mcpServers(),
    emit: (event) => {
      if (generation !== bridgeGeneration) return
      emitToRenderer(event)
      if (event.type === 'turn_end' || event.type === 'error') reportTurnMemories()
    },
  })
}

/** Nothing to start yet (no key, or dsh not installed): the window shows how to fix it. */
const setupInfo = (config) => ({ mode: 'setup', problem: config.problem, cwd: config.cwd, model: '', models: [], efforts: [], reason: '' })
const SETUP_MESSAGES = { 'no-key': '请先在设置里填写 DeepSeek API key', 'no-dsh': '没有找到 DeepSeek Harness，请在项目目录运行 npm install' }

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
    emitToRenderer({ type: 'error', message: `连接 DeepSeek Harness 失败：${err.message}` })
    return null
  }
}

/** A new key (or none) means a different agent, so the conversation starts over. */
function restartWithNewConversation() {
  conversation = historyDb.create()
  bridge?.dispose()
  bridge = null
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
    const info = { ...await bridge.newSession(), remembersHistory: true }
    conversation = historyDb.create({ sessionId: info.sessionId })
    lastInfo = info
    return info
  })
  ipcMain.handle('agent:set-config', async (_event, configId, value) => {
    if (!CONFIG_IDS.includes(configId)) throw new Error(`invalid config option: ${configId}`)
    const info = await requireBridge().setConfig(configId, assertText(value, 'config value', 200))
    lastInfo = { ...lastInfo, ...info }
    return info
  })
  ipcMain.handle('agent:permission', (_event, requestId, optionId) => {
    const id = assertText(requestId, 'requestId', 200)
    const option = optionId === null ? null : assertText(optionId, 'optionId', 200)
    return bridge?.respondPermission(id, option) ?? false
  })
}

function registerSettingsIpc() {
  ipcMain.handle('settings:get', () => settingsView())
  ipcMain.handle('settings:save-key', async (_event, key) => {
    settingsStore.saveApiKey(assertText(key, 'API key', MAX_KEY_CHARS))
    return { settings: settingsView(), info: await restartWithNewConversation() }
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
  registerExtensionsIpc(ipcMain, {
    store: mcpStore,
    roots: () => skillRoots({ dshHome: config.dshHome, cwd: config.cwd }),
    mcpStatus: () => ({ ...personal.mcpStatus(lastInfo, launchedAt), plugins: pluginProblems }),
    applyMcp: applyMcpChange,
    chooseSkill: async () => (await pickFiles({
      title: '选择 skill 文件夹（含 SKILL.md）或 .md 文件',
      properties: ['openDirectory', 'openFile'],
      filters: [{ name: 'Skill', extensions: ['md'] }],
    }))?.[0] ?? null,
    trash: (file) => shell.trashItem(file),
    openPath: (dir) => shell.openPath(dir),
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
  const mcpStore = createMcpConfigStore({
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

function createWindow(config) {
  win = new BrowserWindow({
    ...windowSize(screen.getPrimaryDisplay().workAreaSize),
    ...windowChrome(process.platform),
    show: false,
    backgroundColor: '#060B16',
    webPreferences: {
      preload: path.join(APP_ROOT, 'src', 'preload', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  win.once('ready-to-show', () => win.show())
  win.webContents.once('did-finish-load', () => {
    startBridge()
    if (config.smoke) runSmoke(win, config, (code) => app.exit(code))
  })
  win.loadFile(path.join(APP_ROOT, 'src', 'renderer', 'index.html'))
}

isolateSmokeUserData()

/** The memory smoke run talks to the real dsh, which calls a local stand-in for the DeepSeek API. */
async function startSmokeModel() {
  const { startFakeLlm } = await import(path.join(APP_ROOT, 'test', 'fixtures', 'fake-llm.js'))
  process.env.DEEPSEEK_BASE_URL = (await startFakeLlm()).url
}

app.whenReady().then(async () => {
  // macOS needs its app menu for ⌘C / ⌘V; elsewhere the hidden title bar has no room for a menu bar.
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null)
  settingsStore = createSettingsStore({
    file: path.join(app.getPath('userData'), 'settings.json'),
    crypto: safeStorage,
    onError: (err) => console.error('[settings] could not read saved settings:', err.message),
  })
  registerAgentIpc()
  registerSettingsIpc()
  const config = currentConfig()
  if (config.smokePhase === 'memory') await startSmokeModel()
  openHistory(config)
  openPersonal(config)
  createWindow(config)
})

app.on('window-all-closed', () => app.quit())
app.on('before-quit', () => bridge?.dispose())
app.on('will-quit', () => {
  clearInterval(lateMemoryTimer)
  historyDb?.close()
  memoryDb?.close()
  traceDb?.close()
})

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { Readable, Writable } from 'node:stream'
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { dshLaunch } from './config.js'
import { createPermissionBroker } from './permission-broker.js'
import { createConfigDesk } from './config-channel.js'
import { createSteerDesk } from './steer-channel.js'
import { createForkDesk } from './fork-channel.js'
import { createQuestionDesk } from './question-channel.js'
import { describeConfig, describeError } from './session-info.js'
import pkg from '../../package.json' with { type: 'json' }

const STDERR_TAIL_LIMIT = 4000
/** dsh gets this long to finish after its input closes, then its process tree is ended; then killed outright. */
const SHUTDOWN_GRACE_MS = 1500
// The version the app was built as, so it cannot fall behind a release (package.json ships in the app).
const CLIENT_INFO = { name: 'viva', version: pkg.version }
const CLIENT_CAPABILITIES = { fs: { readTextFile: false, writeTextFile: false }, terminal: false }
const NO_MCP = () => []

/**
 * dsh rejects the whole session when one MCP server cannot start, naming it as `mcp-client(<name>)`
 * or by its position (`mcpServers[2]`). Returns that server, or null when the error is about something else.
 */
export function failingMcpServer(err, servers) {
  const text = `${err?.message ?? ''} ${JSON.stringify(err?.data ?? '')}`
  const byName = /mcp-client\(([^)]+)\)/.exec(text)?.[1]
  if (byName) return servers.find((server) => server.name === byName) ?? null
  const byIndex = /mcpServers\[(\d+)\]/.exec(text)?.[1]
  return byIndex === undefined ? null : servers[Number(byIndex)] ?? null
}

/** spawn reports a missing working directory as ENOENT too, so that is checked before blaming the program. */
function launchError(err, { command, nodeBin, cwd }) {
  if (err.code !== 'ENOENT') return `无法启动 dsh：${err.message}`
  if (!fs.existsSync(cwd)) return `工作目录不存在：${cwd}`
  return command === nodeBin
    ? `找不到 Node.js（${nodeBin}）：dsh 需要它才能运行，请先安装 Node.js，或用 DSH_NODE 指定路径`
    : `找不到 dsh：${command}`
}

/** Not yet exited. A finished process's id may already belong to another one, so it is never signalled. */
const isRunning = (target) => (target.exitCode ?? target.signalCode ?? null) === null

/**
 * Drives `dsh --profile <profile>` over stdio. Everything the agent reports is forwarded through `emit`
 * as plain objects: ready / update / config / permission / question / question_closed / turn_end / error.
 * Questions come from the app's dsh plugin over an IPC channel beside stdio (question-channel.js).
 * `mcpServers()` lists the MCP servers to attach to each session (read again on every new or resumed session).
 * `onExit`, when given, hears about dsh ending on its own (a crash) instead of the window getting an error,
 * so the owner can start it again.
 */
export function createAcpBridge({
  dshBin, nodeBin = 'node', profile, cwd, env = process.env, emit, spawnFn = spawn, mcpServers = NO_MCP, onExit = null,
  platform = process.platform, configActions = null,
}) {
  const broker = createPermissionBroker()
  let mcp = { active: [], dropped: [] }
  let child = null
  let connection = null
  let sessionId = null
  /** The working directory of the session in use: dsh's own at first, another one once a fork moved it. */
  let sessionCwd = cwd
  let canResume = false
  let stderrTail = ''
  let disposed = false
  const toPlugins = (message) => {
    if (child?.connected) child.send(message)
  }
  /**
   * Background tasks (phase 3): sessions that went on in the background, by id (the task's id is its
   * session's). They stay open beside the main conversation; what they report reaches the window as task_*.
   */
  const tasks = new Map()
  /** Sessions with a turn running (a prompt not yet answered). */
  const running = new Set()
  const taskOf = (id) => (tasks.has(id) ? id : null)
  const questions = createQuestionDesk({ send: toPlugins, emit, sessionId: () => sessionId, taskOf })
  // MCP servers and skills set up from the conversation (the viva-config plugin); the app performs them.
  const config = configActions ? createConfigDesk({ send: toPlugins, emit, sessionId: () => sessionId, actions: configActions }) : null
  // What the user says while a turn runs goes to that turn (the viva-steer plugin), not to a new prompt.
  const steering = createSteerDesk({ send: toPlugins, sessionId: () => sessionId })
  // Going back to an earlier point, or on in another directory (the viva-fork plugin, prototype).
  const forking = createForkDesk({ send: toPlugins, sessionId: () => sessionId })

  /** The model options of the session in use, kept so a task taken back to the main conversation keeps its own. */
  let configNow = null
  const infoFrom = (configOptions) => {
    configNow = configOptions ?? configNow
    return { mode: 'live', cwd: sessionCwd, reason: '', sessionId, mcp, ...describeConfig(configNow) }
  }

  const client = {
    async sessionUpdate(params) {
      if (tasks.has(params.sessionId)) return emit({ type: 'task_update', taskId: params.sessionId, update: params.update })
      if (params.sessionId !== sessionId) return
      if (params.update?.sessionUpdate === 'config_option_update') {
        emit({ type: 'config', info: infoFrom(params.update.configOptions) })
        return
      }
      emit({ type: 'update', update: params.update })
    },
    async requestPermission(params) {
      const { requestId, promise } = broker.create(params)
      const taskId = taskOf(params.sessionId)
      emit({ type: 'permission', requestId, toolCall: params.toolCall, options: params.options, ...(taskId ? { taskId } : {}) })
      return promise
    },
  }

  function spawnRuntime() {
    const { command, args } = dshLaunch(dshBin, nodeBin, profile)
    child = spawnFn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] })
    child.on('message', (message) => {
      questions.receive(message)
      config?.receive(message)
      steering.receive(message)
      forking.receive(message)
    })
    child.stderr?.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL_LIMIT)
    })
    child.on('error', (err) => emit({ type: 'error', message: launchError(err, { command, nodeBin, cwd }) }))
    child.on('exit', (code, signal) => {
      if (disposed) return
      const message = describeError(`dsh 已退出（${code ?? signal}）`, stderrTail)
      if (onExit) onExit({ code, signal, message })
      else emit({ type: 'error', message })
    })
    return ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout))
  }

  /** Sends `request` with the MCP servers, leaving out each one dsh reports as failing until the rest work. */
  async function withMcpServers(request) {
    let servers = mcpServers()
    const dropped = []
    for (;;) {
      try {
        const response = await request(servers)
        mcp = { active: servers.map((server) => server.name), dropped }
        return response
      } catch (err) {
        const failing = failingMcpServer(err, servers)
        if (!failing) throw err
        console.error(`[acp-bridge] MCP server "${failing.name}" failed, retrying without it:`, describeError(err))
        dropped.push({ name: failing.name, reason: describeError(err) })
        servers = servers.filter((server) => server !== failing)
      }
    }
  }

  async function openSession() {
    const response = await withMcpServers((servers) => connection.newSession({ cwd: sessionCwd, mcpServers: servers }))
    sessionId = response.sessionId
    return { ...infoFrom(response.configOptions), resumed: false }
  }

  /**
   * Reattaches to a session from an earlier launch (`session/resume`); dsh keeps its context, nothing is replayed.
   * @param {string | null} resumeSessionId @param {string} [targetCwd] the session's directory, when not the current one
   */
  async function resumeOrOpen(resumeSessionId, targetCwd = sessionCwd) {
    sessionCwd = targetCwd
    if (!resumeSessionId || !canResume) return openSession()
    try {
      const response = await withMcpServers((servers) => connection.resumeSession({ sessionId: resumeSessionId, cwd: targetCwd, mcpServers: servers }))
      sessionId = resumeSessionId
      return { ...infoFrom(response.configOptions), resumed: true }
    } catch (err) {
      console.error('[acp-bridge] could not resume the saved session, starting a new one:', describeError(err))
      return openSession()
    }
  }

  /** Changes the model or reasoning effort; dsh applies it from the next turn. */
  async function setConfig(configId, value) {
    try {
      const response = await connection.setSessionConfigOption({ sessionId, configId, value })
      return infoFrom(response.configOptions)
    } catch (err) {
      throw new Error(describeError(err, stderrTail))
    }
  }

  /** @param {{ resumeSessionId?: string | null }} [options] */
  async function start({ resumeSessionId = null } = {}) {
    connection = new ClientSideConnection(() => client, spawnRuntime())
    try {
      const init = await connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: CLIENT_CAPABILITIES,
        clientInfo: CLIENT_INFO,
      })
      canResume = Boolean(init.agentCapabilities?.sessionCapabilities?.resume)
      return await resumeOrOpen(resumeSessionId)
    } catch (err) {
      throw new Error(describeError(err, stderrTail))
    }
  }

  /** Its end is the main conversation's, or (once the turn went to the background) its task's. */
  async function prompt(text) {
    const asked = sessionId
    running.add(asked)
    try {
      const response = await connection.prompt({ sessionId: asked, prompt: [{ type: 'text', text }] })
      if (tasks.has(asked)) emit({ type: 'task_end', taskId: asked, stopReason: response.stopReason })
      else if (asked === sessionId) emit({ type: 'turn_end', stopReason: response.stopReason })
    } catch (err) {
      const message = describeError(err, stderrTail)
      if (tasks.has(asked)) emit({ type: 'task_end', taskId: asked, stopReason: 'error', message })
      else emit({ type: 'error', message })
    } finally {
      running.delete(asked)
    }
  }

  async function cancel() {
    broker.cancelAll(sessionId)
    if (!connection || !sessionId) return
    try {
      await connection.cancel({ sessionId })
    } catch (err) {
      console.error('[acp-bridge] cancel failed:', describeError(err))
    }
  }

  /**
   * Leaves the current session for `targetSessionId` (a reopened conversation), or for a fresh one when null.
   * @param {string | null} targetSessionId @param {string} [targetCwd] its directory, when not the current one
   */
  async function switchSession(targetSessionId, targetCwd = sessionCwd) {
    await cancel()
    questions.declineAll()
    config?.closeAll()
    steering.closeAll()
    forking.closeAll()
    try {
      await connection.closeSession({ sessionId })
    } catch (err) {
      console.error('[acp-bridge] closeSession failed, switching anyway:', describeError(err))
    }
    try {
      return await resumeOrOpen(targetSessionId, targetCwd)
    } catch (err) {
      throw new Error(describeError(err, stderrTail))
    }
  }

  /**
   * Goes back to before the `before`-th user message (everything so far when omitted), optionally in another
   * directory, and goes on there: the plugin writes the new session, this side resumes it. The session left
   * behind stays as it was.
   * Or to before the turn where the user said `words` (the `occurrence`-th such turn from the end, 0 the last).
   * @param {{ before?: number, words?: string, occurrence?: number, cwd?: string }} [request]
   * @returns {Promise<{ ok: boolean, reason?: string, info?: object }>}
   */
  async function fork({ before, words, occurrence, cwd: targetCwd } = {}) {
    const result = await forking.fork({ before, words, occurrence, cwd: targetCwd })
    if (!result.ok) return result
    return { ok: true, info: await switchSession(result.sessionId, targetCwd ?? sessionCwd) }
  }

  /**
   * The turn running in the main conversation goes on in the background as a task (its session stays open,
   * nothing stops); the main conversation goes on from before that turn, in a session forked there, found by
   * the words that started it (the viva-fork plugin).
   * @param {{ words: string }} request
   * @returns {Promise<{ ok: boolean, reason?: string, taskId?: string, info?: object }>}
   */
  async function spinOff({ words }) {
    const taskId = sessionId
    if (!taskId || !running.has(taskId)) return { ok: false, reason: 'idle' }
    const forked = await forking.fork({ words, occurrence: 0 })
    if (!forked.ok) return forked
    tasks.set(taskId, { cwd: sessionCwd, config: configNow })
    questions.moveToTask(taskId, taskId)
    try {
      return { ok: true, taskId, info: await resumeOrOpen(forked.sessionId, sessionCwd) }
    } catch (err) {
      throw new Error(describeError(err, stderrTail))
    }
  }

  /**
   * Undoes spinOff: the session the main conversation went on in is left (closed, what it asked declined) and
   * the task is the main conversation again, its turn still running; its questions come back to the window.
   * @returns {Promise<{ ok: boolean, reason?: string, info?: object }>}
   */
  async function mergeBack(taskId) {
    const task = tasks.get(taskId)
    if (!task) return { ok: false, reason: 'missing' }
    const leaving = sessionId
    questions.declineAll()
    broker.cancelAll(leaving)
    try {
      if (running.has(leaving)) await connection.cancel({ sessionId: leaving })
      await connection.closeSession({ sessionId: leaving })
    } catch (err) {
      console.error('[acp-bridge] leaving the forked session failed, going back anyway:', describeError(err))
    }
    tasks.delete(taskId)
    sessionId = taskId
    sessionCwd = task.cwd
    questions.moveToMain(taskId)
    return { ok: true, info: { ...infoFrom(task.config), resumed: true } }
  }

  /** Stops what a task is doing; it stays, answered as cancelled (task_end). */
  async function cancelTask(taskId) {
    if (!tasks.has(taskId)) return
    broker.cancelAll(taskId)
    try {
      await connection.cancel({ sessionId: taskId })
    } catch (err) {
      console.error('[acp-bridge] cancelling a task failed:', describeError(err))
    }
  }

  /** The task is done with: its session closes, whatever it still asked goes unanswered. */
  async function closeTask(taskId) {
    if (!tasks.has(taskId)) return
    await cancelTask(taskId)
    questions.declineTask(taskId)
    tasks.delete(taskId)
    try {
      await connection.closeSession({ sessionId: taskId })
    } catch (err) {
      console.error('[acp-bridge] closing a task failed:', describeError(err))
    }
  }

  /** Words for the turn a task is on (the viva-steer plugin), as steer() is for the main conversation's. */
  const steerTask = (taskId, text) => (tasks.has(taskId) ? steering.steer(text, taskId) : Promise.resolve({ ok: false, reason: 'missing' }))

  const newSession = () => switchSession(null)
  /** Reattaches the current session, so a changed list of MCP servers takes effect without losing context. */
  const reloadSession = () => switchSession(sessionId)

  /**
   * Hands `text` to the turn that is running. Not ok with reason 'idle' when the turn has just ended (the
   * caller asks it as a new question), else when it could not be sent (steer-channel.js NO_PLUGIN, or the
   * plugin's reasons).
   * @returns {Promise<{ ok: boolean, reason?: string }>}
   */
  const steer = (text) => steering.steer(text)

  function respondPermission(requestId, optionId) {
    return broker.resolve(requestId, optionId)
  }

  /** @returns {boolean} false when the question is no longer waiting; throws when the answer does not fit it */
  const answerQuestion = (questionId, answers) => questions.answer(questionId, answers)
  /** @returns {boolean} false when no key is asked for any more; throws when the values do not fit */
  const provideSecrets = (requestId, values) => config?.provideSecrets(requestId, values) ?? false

  /**
   * Ends what dsh started too (MCP servers): on Windows a signal reaches only the one process, so the
   * tree goes through taskkill; elsewhere dsh ends its own children on SIGTERM.
   */
  function endTree(target) {
    if (!isRunning(target)) return
    if (platform === 'win32' && target.pid) spawnFn('taskkill', ['/pid', String(target.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on?.('error', () => target.kill())
    else target.kill('SIGTERM')
  }

  /** Asks dsh to stop (closing its input, then ending its tree, then killing it); resolves once it has exited. */
  function dispose() {
    disposed = true
    broker.cancelAll()
    steering.closeAll()
    if (!child || !isRunning(child)) return Promise.resolve()
    const target = child
    const exited = new Promise((resolve) => target.once('exit', resolve))
    target.stdin?.end()
    setTimeout(() => endTree(target), SHUTDOWN_GRACE_MS).unref?.()
    setTimeout(() => isRunning(target) && target.kill('SIGKILL'), SHUTDOWN_GRACE_MS * 2).unref?.()
    return exited
  }

  /** dsh's process id while it runs (the smoke run uses it to check recovery from a crash). */
  const pid = () => (child && isRunning(child) ? child.pid : null)

  return { start, prompt, steer, fork, spinOff, mergeBack, cancelTask, closeTask, steerTask, cancel, newSession, switchSession, reloadSession, setConfig, respondPermission, answerQuestion, provideSecrets, dispose, pid }
}

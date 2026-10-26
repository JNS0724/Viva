import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import type { AcpServer } from './mcp-config.ts'
import fs from 'node:fs'
import { Readable, Writable } from 'node:stream'
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import type { McpServer, RequestPermissionRequest, SessionNotification } from '@agentclientprotocol/sdk'
import { dshLaunch } from './config.ts'
import { createPermissionBroker } from './permission-broker.ts'
import { createConfigDesk } from './config-channel.ts'
import { createSteerDesk } from './steer-channel.ts'
import { createForkDesk } from './fork-channel.ts'
import { createFollowupDesk, type PrepareCall, type Prepared } from './followup-channel.ts'
import { createMessagesDesk } from './messages-channel.ts'
import type { ReadRequest } from './message-reader.ts'
import { createQuestionDesk } from './question-channel.ts'
import { stopInTime } from './stop-in-time.ts'
import { describeConfig, describeError } from './session-info.ts'
import pkg from '../../package.json' with { type: 'json' }

const STDERR_TAIL_LIMIT = 4000
/** dsh gets this long to finish after its input closes, then its process tree is ended; then killed outright. */
const SHUTDOWN_GRACE_MS = 1500
// The version the app was built as, so it cannot fall behind a release (package.json ships in the app).
const CLIENT_INFO = { name: 'viva', version: pkg.version }
const CLIENT_CAPABILITIES = { fs: { readTextFile: false, writeTextFile: false }, terminal: false }
/** dsh decides at launch, from the model it starts on, whether its prompts take pictures. */
const NO_IMAGES = '这个模型看不了图片（DeepSeek 里只有 V41-Flash 能看），图片没有发出去'
/** A task let go when it would not stop (cancelTask): what dsh started for it may still be running. */
const STOPPED_ANYWAY = '已停下。它之前开始的命令没有响应停止，可能还在电脑上运行；需要的话在任务管理器（活动监视器）里结束它。'
const NO_MCP = (): AcpServer[] => []
type PromptBlocks = Parameters<ClientSideConnection['prompt']>[0]['prompt']
/** One of a session's choices (model, effort), as dsh lists them; only these fields are read here. */
type ConfigOption = { id: string, currentValue?: any, [field: string]: any }
/** A background task's session: where it runs, and its choices as they were last reported. */
type TaskSession = { cwd: string, config: ConfigOption[] | null }
/** What the bridge tells its owner (main.ts): the agent's events, as plain objects. */
type Emit = (event: { type: string, [field: string]: unknown }) => void

/** The session a call to dsh is for; one asked for before any session is open is refused here, not by dsh. */
function opened(id: string | null): string {
  if (!id) throw new Error('no session is open')
  return id
}

/**
 * dsh rejects the whole session when one MCP server cannot start, naming it as `mcp-client(<name>)`
 * or by its position (`mcpServers[2]`). Returns that server, or null when the error is about something else.
 */
export function failingMcpServer<S extends { name: string }>(err: any, servers: readonly S[]): S | null {
  const text = `${err?.message ?? ''} ${JSON.stringify(err?.data ?? '')}`
  const byName = /mcp-client\(([^)]+)\)/.exec(text)?.[1]
  if (byName) return servers.find((server) => server.name === byName) ?? null
  const byIndex = /mcpServers\[(\d+)\]/.exec(text)?.[1]
  return byIndex === undefined ? null : servers[Number(byIndex)] ?? null
}

/** spawn reports a missing working directory as ENOENT too, so that is checked before blaming the program. */
function launchError(err: NodeJS.ErrnoException, { command, nodeBin, cwd }: { command: string, nodeBin: string, cwd: string }) {
  if (err.code !== 'ENOENT') return `无法启动 dsh：${err.message}`
  if (!fs.existsSync(cwd)) return `工作目录不存在：${cwd}`
  return command === nodeBin
    ? `找不到 Node.js（${nodeBin}）：dsh 需要它才能运行，请先安装 Node.js，或用 DSH_NODE 指定路径`
    : `找不到 dsh：${command}`
}

/** Not yet exited. A finished process's id may already belong to another one, so it is never signalled. */
const isRunning = (target: Pick<ChildProcess, 'exitCode' | 'signalCode'>) => (target.exitCode ?? target.signalCode ?? null) === null

/**
 * Drives `dsh --profile <profile>` over stdio. Everything the agent reports is forwarded through `emit`
 * as plain objects: ready / update / config / permission / question / question_closed / turn_end / error.
 * Questions come from the app's dsh plugin over an IPC channel beside stdio (question-channel.js).
 * `mcpServers()` lists the MCP servers to attach to each session (read again on every new or resumed session).
 * `onExit`, when given, hears about dsh ending on its own (a crash) instead of the window getting an error,
 * so the owner can start it again.
 */
export function createAcpBridge({
  dshBin, nodeBin = 'node', profile, cwd, env = process.env, emit, spawnFn = spawn, mcpServers = NO_MCP,
  onExit = null as ((exit: { code: number | null, signal: string | null, message: string }) => void) | null,
  platform = process.platform, configActions = null as Parameters<typeof createConfigDesk>[0]['actions'] | null,
  messageActions = null as { read: (request: ReadRequest) => Promise<string> } | null,
}: {
  dshBin: string, nodeBin?: string, profile: string, cwd: string, env?: NodeJS.ProcessEnv, emit: Emit,
  spawnFn?: typeof spawn, mcpServers?: () => AcpServer[],
  onExit?: ((exit: { code: number | null, signal: string | null, message: string }) => void) | null,
  platform?: string, configActions?: Parameters<typeof createConfigDesk>[0]['actions'] | null,
  /** What the message sources brought in, for viva_messages_read; null leaves the tool saying there are none. */
  messageActions?: { read: (request: ReadRequest) => Promise<string> } | null,
}) {
  const broker = createPermissionBroker()
  let mcp: { active: string[], dropped: Array<{ name: string, reason: string }> } = { active: [], dropped: [] }
  let child: ChildProcess | null = null
  let connection: ClientSideConnection | null = null
  let sessionId: string | null = null
  /** The working directory of the session in use: dsh's own at first, another one once a fork moved it. */
  let sessionCwd = cwd
  let canResume = false
  /** Whether the model dsh started on reads pictures (dsh asks the model's catalog entry). */
  let seesImages = false
  let stderrTail = ''
  let disposed = false
  const toPlugins = (message: object) => {
    if (child?.connected) child.send(message)
  }
  /**
   * Background tasks (phase 3): sessions that went on in the background, by id (the task's id is its
   * session's). They stay open beside the main conversation; what they report reaches the window as task_*.
   */
  const tasks = new Map<string, TaskSession>()
  /** Sessions with a turn running (a prompt not yet answered). */
  const running = new Set<string | null>()
  /** Tasks whose turn did not stop when asked and was let go (stop-in-time.ts): its late end is not told again. */
  const letGo = new Set<string>()
  const taskOf = (id: string) => (tasks.has(id) ? id : null)
  const isTask = (id: string | null) => id !== null && tasks.has(id)
  const questions = createQuestionDesk({ send: toPlugins, emit, sessionId: () => sessionId, taskOf })
  // MCP servers and skills set up from the conversation (the viva-config plugin); the app performs them.
  const config = configActions ? createConfigDesk({ send: toPlugins, emit, sessionId: () => sessionId, actions: configActions }) : null
  // What the user says while a turn runs goes to that turn (the viva-steer plugin), not to a new prompt.
  const steering = createSteerDesk({ send: toPlugins, sessionId: () => sessionId })
  // Going back to an earlier point, or on in another directory (the viva-fork plugin, prototype).
  const forking = createForkDesk({ send: toPlugins, sessionId: () => sessionId })
  // Follow-ups proposed in a conversation, and background preparation's tool-less model calls (viva-followups).
  const followupDesk = createFollowupDesk({ send: toPlugins, emit })
  // The messages the sources brought in, read from the conversation (viva-messages).
  const messagesDesk = createMessagesDesk({ send: toPlugins, read: messageActions?.read ?? null })

  /** The model options of the session in use, kept so a task taken back to the main conversation keeps its own. */
  let configNow: ConfigOption[] | null = null
  const infoFrom = (configOptions: ConfigOption[] | null | undefined) => {
    configNow = configOptions ?? configNow
    return { mode: 'live', cwd: sessionCwd, reason: '', sessionId, mcp, ...describeConfig(configNow) }
  }

  const client = {
    async sessionUpdate(params: SessionNotification) {
      if (tasks.has(params.sessionId)) return emit({ type: 'task_update', taskId: params.sessionId, update: params.update })
      if (params.sessionId !== sessionId) return
      if (params.update?.sessionUpdate === 'config_option_update') {
        emit({ type: 'config', info: infoFrom(params.update.configOptions) })
        return
      }
      // The session goes with it: the window tells the turn it undid a move for from the one it left (task-actions.js).
      emit({ type: 'update', sessionId: params.sessionId, update: params.update })
    },
    async requestPermission(params: RequestPermissionRequest) {
      const { requestId, promise } = broker.create(params)
      const taskId = taskOf(params.sessionId)
      emit({ type: 'permission', requestId, sessionId: params.sessionId, toolCall: params.toolCall, options: params.options, ...(taskId ? { taskId } : {}) })
      return promise
    },
  }

  function spawnRuntime() {
    const { command, args } = dshLaunch(dshBin, nodeBin, profile)
    const proc = spawnFn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] })
    child = proc
    proc.on('message', (message) => {
      questions.receive(message)
      config?.receive(message)
      steering.receive(message)
      forking.receive(message)
      followupDesk.receive(message)
      messagesDesk.receive(message)
    })
    proc.stderr?.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL_LIMIT)
    })
    proc.on('error', (err) => emit({ type: 'error', message: launchError(err, { command, nodeBin, cwd }) }))
    proc.on('exit', (code, signal) => {
      followupDesk.close()
      if (disposed) return
      const message = describeError(`dsh 已退出（${code ?? signal}）`, stderrTail)
      if (onExit) onExit({ code, signal, message })
      else emit({ type: 'error', message })
    })
    // stdin and stdout are pipes, as asked for above.
    return ndJsonStream(Writable.toWeb(proc.stdin as Writable), Readable.toWeb(proc.stdout as Readable) as ReadableStream<Uint8Array>)
  }

  /** The connection to dsh, which start() opens before anything else is asked of it. */
  function live(): ClientSideConnection {
    if (!connection) throw new Error('dsh is not started')
    return connection
  }

  /** Sends `request` with the MCP servers, leaving out each one dsh reports as failing until the rest work. */
  async function withMcpServers<R>(request: (servers: McpServer[]) => Promise<R>): Promise<R> {
    // Built as ACP's session/new takes them (mcp-config.ts toAcpServers).
    let servers = mcpServers() as McpServer[]
    const dropped: Array<{ name: string, reason: string }> = []
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
    const response = await withMcpServers((servers) => live().newSession({ cwd: sessionCwd, mcpServers: servers }))
    sessionId = response.sessionId
    return { ...infoFrom(response.configOptions), resumed: false }
  }

  /**
   * Reattaches to a session from an earlier launch (`session/resume`); dsh keeps its context, nothing is replayed.
   * @param targetCwd the session's directory, when not the current one
   */
  async function resumeOrOpen(resumeSessionId: string | null, targetCwd = sessionCwd) {
    sessionCwd = targetCwd
    if (!resumeSessionId || !canResume) return openSession()
    try {
      const response = await withMcpServers((servers) => live().resumeSession({ sessionId: resumeSessionId, cwd: targetCwd, mcpServers: servers }))
      sessionId = resumeSessionId
      return { ...infoFrom(response.configOptions), resumed: true }
    } catch (err) {
      console.error('[acp-bridge] could not resume the saved session, starting a new one:', describeError(err))
      return openSession()
    }
  }

  /** Changes the model or reasoning effort; dsh applies it from the next turn. */
  async function setConfig(configId: string, value: string) {
    try {
      const response = await live().setSessionConfigOption({ sessionId: opened(sessionId), configId, value })
      return infoFrom(response.configOptions)
    } catch (err) {
      throw new Error(describeError(err, stderrTail))
    }
  }

  async function start({ resumeSessionId = null as string | null } = {}) {
    connection = new ClientSideConnection(() => client, spawnRuntime())
    try {
      const init = await live().initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: CLIENT_CAPABILITIES,
        clientInfo: CLIENT_INFO,
      })
      canResume = Boolean(init.agentCapabilities?.sessionCapabilities?.resume)
      seesImages = Boolean(init.agentCapabilities?.promptCapabilities?.image)
      return await resumeOrOpen(resumeSessionId)
    } catch (err) {
      throw new Error(describeError(err, stderrTail))
    }
  }

  /**
   * Its end is the main conversation's, or (once the turn went to the background) its task's.
   * @param images pictures pasted with it, base64
   */
  async function prompt(text: string, images: Array<{ data: string, mimeType: string }> = []) {
    if (images.length && !seesImages) {
      emit({ type: 'error', message: NO_IMAGES })
      return
    }
    const asked = sessionId
    running.add(asked)
    // Let go when stopped (cancelTask): it has ended on screen, and the task may be running a new turn by now.
    let released = false
    try {
      const blocks: PromptBlocks = [
        ...images.map(({ data, mimeType }) => ({ type: 'image' as const, data, mimeType })),
        ...(text ? [{ type: 'text' as const, text }] : []),
      ]
      const response = await live().prompt({ sessionId: opened(asked), prompt: blocks })
      if ((released = wasLetGo(asked))) return
      if (isTask(asked)) emit({ type: 'task_end', taskId: asked, stopReason: response.stopReason })
      else if (asked === sessionId) emit({ type: 'turn_end', stopReason: response.stopReason })
    } catch (err) {
      if ((released = wasLetGo(asked))) return
      const message = describeError(err, stderrTail)
      // Viva quitting ends a task's turn too: it is not over, and the next launch offers it (task-store.js).
      if (isTask(asked)) {
        if (!disposed) emit({ type: 'task_end', taskId: asked, stopReason: 'error', message })
      } else emit({ type: 'error', message })
    } finally {
      if (!released) running.delete(asked)
    }
  }

  async function cancel() {
    broker.cancelAll(sessionId)
    if (!connection || !sessionId) return
    try {
      await live().cancel({ sessionId })
    } catch (err) {
      console.error('[acp-bridge] cancel failed:', describeError(err))
    }
  }

  /**
   * Leaves the current session for `targetSessionId` (a reopened conversation), or for a fresh one when null.
   * @param targetCwd its directory, when not the current one
   */
  async function switchSession(targetSessionId: string | null, targetCwd = sessionCwd) {
    await cancel()
    questions.declineAll()
    config?.closeAll()
    steering.closeAll()
    forking.closeAll()
    try {
      await live().closeSession({ sessionId: opened(sessionId) })
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
   */
  async function fork({ before, words, occurrence, cwd: targetCwd }: { before?: number, words?: string, occurrence?: number, cwd?: string } = {}): Promise<
    { ok: false, reason: string } | { ok: true, info: Awaited<ReturnType<typeof switchSession>> }
  > {
    const result = await forking.fork({ before, words, occurrence, cwd: targetCwd })
    if (!result.ok) return result
    return { ok: true, info: await switchSession(result.sessionId, targetCwd ?? sessionCwd) }
  }

  /**
   * The turn running in the main conversation goes on in the background as a task (its session stays open,
   * nothing stops); the main conversation goes on from before that turn, in a session forked there, found by
   * the words that started it (the viva-fork plugin).
   */
  async function spinOff({ words }: { words: string }) {
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
   */
  async function mergeBack(taskId: string) {
    const task = tasks.get(taskId)
    if (!task) return { ok: false, reason: 'missing' }
    const leaving = sessionId
    questions.declineAll()
    broker.cancelAll(leaving)
    try {
      if (running.has(leaving)) await live().cancel({ sessionId: opened(leaving) })
      await live().closeSession({ sessionId: opened(leaving) })
    } catch (err) {
      console.error('[acp-bridge] leaving the forked session failed, going back anyway:', describeError(err))
    }
    tasks.delete(taskId)
    sessionId = taskId
    sessionCwd = task.cwd
    questions.moveToMain(taskId)
    return { ok: true, info: { ...infoFrom(task.config), resumed: true } }
  }

  /**
   * A task from an earlier launch, taken up again (task-ipc.js task:resume): its session is reattached beside the
   * main conversation's, as a task, with all it had; promptTask then asks it to go on.
   */
  async function resumeTask({ taskId, cwd = sessionCwd }: { taskId: string, cwd?: string }): Promise<{ ok: boolean, reason?: string }> {
    if (!canResume) return { ok: false, reason: 'unavailable' }
    try {
      const response = await withMcpServers((servers) => live().resumeSession({ sessionId: taskId, cwd, mcpServers: servers }))
      tasks.set(taskId, { cwd, config: response.configOptions ?? configNow })
      return { ok: true }
    } catch (err) {
      console.error('[acp-bridge] could not take up the task again:', describeError(err))
      return { ok: false, reason: 'missing' }
    }
  }

  /** The task's session takes the choices the main conversation has now (its model, its effort) where they differ. */
  async function matchMainConfig(taskId: string, taskOptions: readonly ConfigOption[]) {
    for (const option of configNow ?? []) {
      const theirs = taskOptions.find((item) => item.id === option.id)
      if (option.currentValue === undefined || theirs?.currentValue === option.currentValue) continue
      const response = await live().setSessionConfigOption({ sessionId: taskId, configId: option.id, value: option.currentValue })
      const task = tasks.get(taskId)
      if (task) tasks.set(taskId, { ...task, config: response.configOptions ?? task.config })
    }
  }

  /**
   * 后台做 (task-ipc.js task:start): a task of its own, beside the main conversation, in a session forked from it
   * as it is, or from before the turn running in it (named by its `words`), so it knows what was said; with
   * nothing said yet, in a fresh session. promptTask then asks it.
   */
  async function startTask({ words }: { words?: string } = {}): Promise<{ ok: boolean, reason?: string, taskId?: string }> {
    if (!sessionId) return { ok: false, reason: 'missing' }
    const forked = await forking.fork(words ? { words, occurrence: 0 } : {})
    if (forked.ok) {
      const taken = await resumeTask({ taskId: forked.sessionId, cwd: sessionCwd })
      if (!taken.ok) return taken
      // A fork of a conversation with nothing said yet starts on the profile's defaults too.
      await matchMainConfig(forked.sessionId, tasks.get(forked.sessionId)?.config ?? [])
      return { ok: true, taskId: forked.sessionId }
    }
    try {
      const response = await withMcpServers((servers) => live().newSession({ cwd: sessionCwd, mcpServers: servers }))
      tasks.set(response.sessionId, { cwd: sessionCwd, config: response.configOptions ?? configNow })
      // A fresh session starts on the profile's defaults: the model picked here may be another (or the only one with a key).
      await matchMainConfig(response.sessionId, response.configOptions ?? [])
      return { ok: true, taskId: response.sessionId }
    } catch (err) {
      console.error('[acp-bridge] could not start a task:', describeError(err))
      return { ok: false, reason: 'missing' }
    }
  }

  /** A turn in a task's session: what it says arrives as task_update, its end as task_end (as for a spun-off turn). */
  async function promptTask(taskId: string, text: string) {
    if (!tasks.has(taskId)) return
    running.add(taskId)
    let released = false
    try {
      const response = await live().prompt({ sessionId: taskId, prompt: [{ type: 'text', text }] })
      if ((released = wasLetGo(taskId))) return
      if (tasks.has(taskId)) emit({ type: 'task_end', taskId, stopReason: response.stopReason })
    } catch (err) {
      if ((released = wasLetGo(taskId))) return
      // As in prompt(): ended because Viva is quitting, it is not over.
      if (tasks.has(taskId) && !disposed) emit({ type: 'task_end', taskId, stopReason: 'error', message: describeError(err, stderrTail) })
    } finally {
      if (!released) running.delete(taskId)
    }
  }

  /** Whether `id`'s turn was let go when stopped (and so already ended on screen); forgets it either way. */
  function wasLetGo(id: string | null) {
    if (id === null || !letGo.has(id)) return false
    letGo.delete(id)
    return true
  }

  /**
   * Stops what a task is doing; it stays, answered as cancelled (task_end). A turn that does not stop is let
   * go after a while (stop-in-time.ts), so 停下 always ends it on screen; what dsh started may still be running.
   */
  async function cancelTask(taskId: string) {
    if (!tasks.has(taskId)) return
    broker.cancelAll(taskId)
    await stopInTime({
      cancel: () => live().cancel({ sessionId: taskId }),
      stillRunning: () => running.has(taskId) && !letGo.has(taskId) && !disposed,
      giveUp: () => {
        letGo.add(taskId)
        running.delete(taskId)
        emit({ type: 'task_end', taskId, stopReason: 'cancelled', message: STOPPED_ANYWAY })
      },
    })
  }

  /** The task is done with: its session closes, whatever it still asked goes unanswered. */
  async function closeTask(taskId: string) {
    if (!tasks.has(taskId)) return
    await cancelTask(taskId)
    questions.declineTask(taskId)
    tasks.delete(taskId)
    try {
      await live().closeSession({ sessionId: taskId })
    } catch (err) {
      console.error('[acp-bridge] closing a task failed:', describeError(err))
    }
  }

  /** Words for the turn a task is on (the viva-steer plugin), as steer() is for the main conversation's. */
  const steerTask = (taskId: string, text: string) => (tasks.has(taskId) ? steering.steer(text, taskId) : Promise.resolve({ ok: false, reason: 'missing' }))

  const newSession = () => switchSession(null)
  /** Reattaches the current session, so a changed list of MCP servers takes effect without losing context. */
  const reloadSession = () => switchSession(sessionId)

  /**
   * Hands `text` to the turn that is running. Not ok with reason 'idle' when the turn has just ended (the
   * caller asks it as a new question), else when it could not be sent (steer-channel.js NO_PLUGIN, or the
   * plugin's reasons).
   */
  const steer = (text: string) => steering.steer(text)

  /** optionId: the option picked, or null to turn it down without one. */
  function respondPermission(requestId: string, optionId: string | null) {
    return broker.resolve(requestId, optionId)
  }

  /** @returns false when the question is no longer waiting; throws when the answer does not fit it */
  const answerQuestion = (questionId: string, answers: unknown): boolean => questions.answer(questionId, answers)
  /** @returns false when no key is asked for any more; throws when the values do not fit */
  const provideSecrets = (requestId: string, values: Record<string, unknown> | null) => config?.provideSecrets(requestId, values) ?? false

  /**
   * Ends what dsh started too (MCP servers): on Windows a signal reaches only the one process, so the
   * tree goes through taskkill; elsewhere dsh ends its own children on SIGTERM.
   */
  function endTree(target: ChildProcess) {
    if (!isRunning(target)) return
    if (platform === 'win32' && target.pid) spawnFn('taskkill', ['/pid', String(target.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on?.('error', () => target.kill())
    else target.kill('SIGTERM')
  }

  /** Asks dsh to stop (closing its input, then ending its tree, then killing it); resolves once it has exited. */
  function dispose() {
    disposed = true
    broker.cancelAll()
    steering.closeAll()
    followupDesk.close()
    if (!child || !isRunning(child)) return Promise.resolve()
    const target = child
    const exited = new Promise((resolve) => target.once('exit', resolve))
    target.stdin?.end()
    setTimeout(() => endTree(target), SHUTDOWN_GRACE_MS).unref?.()
    setTimeout(() => isRunning(target) && target.kill('SIGKILL'), SHUTDOWN_GRACE_MS * 2).unref?.()
    return exited
  }

  /** Background tasks working right now: a turn running, not waiting on the user's permission. */
  const workingTasks = (): number => {
    const waiting = broker.waitingSessions()
    return [...running].filter((id): id is string => isTask(id) && !waiting.has(id as string)).length
  }

  /** Background preparation: one model call with no tools, from the followups plugin; nothing while dsh is down. */
  function prepareText(call: PrepareCall, signal?: AbortSignal): Promise<Prepared> {
    if (!child?.connected) return Promise.resolve({ ok: false, problem: '助手还没准备好', called: false })
    return followupDesk.prepare(call, signal)
  }

  /** dsh's process id while it runs (the smoke run uses it to check recovery from a crash). */
  const pid = () => (child && isRunning(child) ? child.pid : null)

  return { start, prompt, steer, fork, spinOff, mergeBack, resumeTask, startTask, promptTask, cancelTask, closeTask, steerTask, cancel, newSession, switchSession, reloadSession, setConfig, respondPermission, answerQuestion, provideSecrets, prepareText, workingTasks, dispose, pid }
}

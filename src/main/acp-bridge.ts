import { onLocaleChange } from '../shared/i18n/locale.ts'
import { t } from '../shared/i18n/translate.ts'
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
import { createTasksDesk } from './tasks-channel.ts'
import { createHistoryDesk, type HistoryRead, type HistorySearch } from './history-channel.ts'
import type { TaskRead } from './tasks-channel.ts'
import type { ReadRequest } from './message-reader.ts'
import { createQuestionDesk } from './question-channel.ts'
import { ResumeError, resumeReason } from './resume-failure.ts'
import { stopInTime } from './stop-in-time.ts'
import { createAssistantStream } from './assistant-stream.ts'
import { createFreshSessions } from './fresh-sessions.ts'
import { sessionTiming, type SessionTiming } from './session-timing.ts'
import { describeConfig, describeError } from './session-info.ts'
import pkg from '../../package.json' with { type: 'json' }

const STDERR_TAIL_LIMIT = 4000
export const SWITCHING = t("merge.switching.conversations.wait.before.sending.0")
/** dsh gets this long to finish after its input closes, then its process tree is ended; then killed outright. */
const SHUTDOWN_GRACE_MS = 1500
// The version the app was built as, so it cannot fall behind a release (package.json ships in the app).
const CLIENT_INFO = { name: 'viva', version: pkg.version }
const CLIENT_CAPABILITIES = { fs: { readTextFile: false, writeTextFile: false }, terminal: false }
/** dsh decides at launch, from the model it starts on, whether its prompts take pictures. */
let NO_IMAGES = t("main.acp-bridge.this.model.cannot.read.images.among.deepseek")
/** A task let go when it would not stop (cancelTask): what dsh started for it may still be running. */
let STOPPED_ANYWAY = t("main.acp-bridge.stopped.a.command.started.earlier.did.not")
const NO_MCP = (): AcpServer[] => []
export const MCP_RETRY_MS = 30_000
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
  if (err.code !== 'ENOENT') return t("main.acp-bridge.could.not.start.dsh", { message: err.message })
  if (!fs.existsSync(cwd)) return t("main.acp-bridge.working.directory.does.not.exist", { cwd: cwd })
  return command === nodeBin
    ? t("main.acp-bridge.node.js.not.found.dsh.requires.node", { nodeBin: nodeBin })
    : t("main.acp-bridge.dsh.not.found", { command: command })
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
  messageActions = null as { read: (request: ReadRequest) => Promise<string> } | null, taskRead = null, historySearch = null, historyRead = null, prewarmSessions = false, onTiming,
}: {
  dshBin: string, nodeBin?: string, profile: string, cwd: string, env?: NodeJS.ProcessEnv, emit: Emit,
  spawnFn?: typeof spawn, mcpServers?: () => AcpServer[],
  onExit?: ((exit: { code: number | null, signal: string | null, message: string }) => void) | null,
  platform?: string, configActions?: Parameters<typeof createConfigDesk>[0]['actions'] | null,
  /** What the message sources brought in, for viva_messages_read; null leaves the tool saying there are none. */
  messageActions?: { read: (request: ReadRequest) => Promise<string> } | null,
  taskRead?: TaskRead | null,
  /** What was said in the timeline before, for search_conversations (viva-history); null leaves it saying there is none. */
  historySearch?: HistorySearch | null,
  /** The messages around one found, for read_conversation (viva-history). */
  historyRead?: HistoryRead | null,
  prewarmSessions?: boolean,
  onTiming?: (sample: SessionTiming) => void,
}) {
  const broker = createPermissionBroker()
  let mcp: { active: string[], dropped: Array<{ name: string, reason: string }> } = { active: [], dropped: [] }
  const failedMcp = new Map<string, { until: number, reason: string }>()
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
  let switching = false
  const closing = new Map<string, Promise<unknown>>()
  const failedCloses = new Set<string>()
  const toPlugins = (message: object) => {
    if (child?.connected) child.send(message)
  }
  /**
   * Background tasks (phase 3): sessions that went on in the background, by id (the task's id is its
   * session's). They stay open beside the main conversation; what they report reaches the window as task_*.
   */
  const tasks = new Map<string, TaskSession>()
  /** Sessions with a turn running (a prompt not yet answered). */
  type Running = { released: boolean, stream?: Awaited<ReturnType<typeof streams.begin>> }
  const running = new Map<string | null, Running>()
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
  const followupDesk = createFollowupDesk({ send: toPlugins, emit: event => {
    if (event.type === 'followup_propose' && event.sessionId !== sessionId && !tasks.has(String(event.sessionId))) return
    emit(event)
  } })
  // The messages the sources brought in, read from the conversation (viva-messages).
  const messagesDesk = createMessagesDesk({ send: toPlugins, read: messageActions?.read ?? null })
  const tasksDesk = createTasksDesk({ send: toPlugins, read: taskRead, authorized: id => id === sessionId || tasks.has(id) })
  const historyDesk = createHistoryDesk({ send: toPlugins, search: historySearch, read: historyRead, authorized: id => id === sessionId || tasks.has(id) })
  const streams = createAssistantStream({ send: toPlugins, emit: (id, update) => {
    if (!running.has(id) || running.get(id)?.released) return
    if (tasks.has(id)) emit({ type: 'task_update', taskId: id, update })
    else if (id === sessionId) emit({ type: 'update', sessionId: id, update })
  } })

  /** The model options of the session in use, kept so a task taken back to the main conversation keeps its own. */
  let configNow: ConfigOption[] | null = null
  const infoFrom = (configOptions: ConfigOption[] | null | undefined) => {
    configNow = configOptions ?? configNow
    return { mode: 'live', cwd: sessionCwd, reason: '', sessionId, mcp, ...describeConfig(configNow) }
  }

  const client = {
    async sessionUpdate(params: SessionNotification) {
      if (running.get(params.sessionId)?.released) return
      if (streams.suppress(params.sessionId, params.update)) return
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
      if (params.sessionId !== sessionId && !tasks.has(params.sessionId)) return { outcome: { outcome: 'cancelled' as const } }
      const { requestId, promise } = broker.create(params)
      const taskId = taskOf(params.sessionId)
      emit({ type: 'permission', requestId, sessionId: params.sessionId, toolCall: params.toolCall, options: params.options, ...(taskId ? { taskId } : {}) })
      return promise.finally(() => {
        const currentTask = taskOf(params.sessionId)
        if (currentTask) emit({ type: 'task_permission_closed', taskId: currentTask, requestId })
      })
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
      tasksDesk.receive(message)
      historyDesk.receive(message)
      streams.receive(message)
    })
    proc.stderr?.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL_LIMIT)
    })
    proc.on('error', (err) => emit({ type: 'error', message: launchError(err, { command, nodeBin, cwd }) }))
    proc.on('exit', (code, signal) => {
      fresh.dispose()
      streams.close()
      followupDesk.close()
      if (disposed) return
      const message = describeError(t("main.acp-bridge.dsh.exited", { value1: String(code ?? signal) }), stderrTail)
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
  async function withMcpServers<R>(request: (servers: McpServer[]) => Promise<R>, speculative = false, status?: (value: typeof mcp) => void): Promise<R> {
    // Built as ACP's session/new takes them (mcp-config.ts toAcpServers).
    const configured = mcpServers() as McpServer[]
    const keys = new Set(configured.map(server => JSON.stringify(server)))
    if (!speculative) for (const [key, failure] of failedMcp) if (!keys.has(key) || failure.until <= Date.now()) failedMcp.delete(key)
    const failureOf = (server: McpServer) => {
      const failure = failedMcp.get(JSON.stringify(server))
      return failure && failure.until > Date.now() ? failure : null
    }
    let servers = configured.filter(server => !failureOf(server))
    const dropped = configured.flatMap(server => {
      const failure = failureOf(server)
      return failure ? [{ name: server.name, reason: failure.reason }] : []
    })
    for (;;) {
      try {
        const response = await request(servers)
        status?.({ active: servers.map(server => server.name), dropped })
        if (!speculative) mcp = { active: servers.map((server) => server.name), dropped }
        return response
      } catch (err) {
        // A second MCP instance may conflict with the active one. Discard this spare, without treating
        // its failure as evidence that the user's real connection is unavailable.
        if (speculative) throw err
        const failing = failingMcpServer(err, servers)
        if (!failing) throw err
        console.error(`[acp-bridge] MCP server "${failing.name}" failed, retrying without it:`, describeError(err))
        const reason = describeError(err)
        failedMcp.set(JSON.stringify(failing), { until: Date.now() + MCP_RETRY_MS, reason })
        dropped.push({ name: failing.name, reason })
        servers = servers.filter((server) => server !== failing)
      }
    }
  }

  const fresh = createFreshSessions({
    open: async (targetCwd: string, speculative: boolean) => {
      let status = mcp
      const response = await sessionTiming(onTiming)('session.create-and-mcp', () => withMcpServers(
        servers => live().newSession({ cwd: targetCwd, mcpServers: servers }), speculative, value => { status = value },
      ), speculative ? 'speculative' : 'requested')
      return { response, status }
    },
    close: entry => live().closeSession({ sessionId: entry.response.sessionId }),
  })
  // The fingerprint stays in memory; changing a server/secret or directory discards the untouched spare.
  const freshKey = (targetCwd: string) => JSON.stringify([targetCwd, mcpServers(), [...failedMcp].filter(([, failure]) => failure.until > Date.now()).map(([key, failure]) => [key, failure.until])])
  const prepareFresh = () => {
    if (prewarmSessions && !disposed && !closing.size && !failedCloses.size) fresh.prepare(freshKey(sessionCwd), sessionCwd)
    else fresh.clear()
  }

  async function openSession(beforeOpen?: () => Promise<unknown>) {
    const measure = sessionTiming(onTiming)
    let source = 'cold'
    const { response, status } = await measure('session.acquire', () => fresh.take(freshKey(sessionCwd), sessionCwd, {
      beforeOpen, onUse: value => { source = value },
    }))
    await measure('session.source', async () => {}, source)
    mcp = status
    sessionId = response.sessionId
    prepareFresh()
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
      prepareFresh()
      return { ...infoFrom(response.configOptions), resumed: true }
    } catch (err) {
      console.error('[acp-bridge] could not resume the saved session, starting a new one:', describeError(err))
      return openSession()
    }
  }

  /**
   * Goes over to exactly that session, in its own directory, or throws why not (resume-failure.ts), the agent left
   * as it was: the session is resumed first, beside the one in use (dsh holds several, as it does tasks), and only
   * then is the one in use left. So a failure, or a session that will not close, never leaves the conversation on
   * screen without its session, nor puts a new one in its place.
   */
  async function switchExactly(targetSessionId: string, targetCwd: string, measure: ReturnType<typeof sessionTiming>) {
    const leaving = sessionId
    if (targetSessionId === leaving) return { ...infoFrom(configNow ?? undefined), resumed: true }
    if (!canResume) throw new ResumeError('gone', t("merge.this.assistant.version.cannot.resume.earlier.sessions.1"))
    let response
    try {
      // Closed earlier (撤销 a new topic goes back to the session just left): that close finishes first.
      await closing.get(targetSessionId)?.catch(() => {})
      response = await withMcpServers((servers) => live().resumeSession({ sessionId: targetSessionId, cwd: targetCwd, mcpServers: servers }))
    } catch (err) {
      console.error('[acp-bridge] could not resume the topic\'s session; staying where it was:', describeError(err))
      throw new ResumeError(resumeReason(err), describeError(err, stderrTail))
    }
    questions.declineAll()
    config?.closeAll()
    steering.closeAll()
    forking.closeAll()
    if (leaving) {
      broker.cancelAll(leaving)
      retire(leaving, measure)
    }
    sessionId = targetSessionId
    sessionCwd = targetCwd
    prepareFresh()
    return { ...infoFrom(response.configOptions), resumed: true }
  }

  /** Changes the model or reasoning effort; dsh applies it from the next turn. */
  async function setConfig(configId: string, value: string) {
    try {
      const id = opened(sessionId)
      if (configNow?.find(option => option.id === configId)?.currentValue === value) return infoFrom(configNow)
      const response = await sessionTiming(onTiming)('session.set-config', () => live().setSessionConfigOption({ sessionId: id, configId, value }), configId)
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
      const info = await resumeOrOpen(resumeSessionId)
      prepareFresh()
      return info
    } catch (err) {
      throw new Error(describeError(err, stderrTail))
    }
  }

  /**
   * Its end is the main conversation's, or (once the turn went to the background) its task's.
   * @param images pictures pasted with it, base64
   */
  async function prompt(text: string, images: Array<{ data: string, mimeType: string }> = []) {
    // Mid-switch (or while one is prepared) it would go to the session about to be left, cut off when that closes.
    if (isSwitching()) throw new Error(SWITCHING)
    if (images.length && !seesImages) {
      emit({ type: 'error', message: NO_IMAGES })
      return
    }
    const asked = sessionId
    const operation: Running = { released: false }
    running.set(asked, operation)
    // Let go when stopped (cancelTask): it has ended on screen, and the task may be running a new turn by now.
    try {
      operation.stream = await streams.begin(opened(asked))
      const blocks: PromptBlocks = [
        ...images.map(({ data, mimeType }) => ({ type: 'image' as const, data, mimeType })),
        ...(text ? [{ type: 'text' as const, text }] : []),
      ]
      const response = await live().prompt({ sessionId: opened(asked), prompt: blocks })
      if (operation.released) return
      await streams.complete(operation.stream)
      if (operation.released) return
      if (isTask(asked)) emit({ type: 'task_end', taskId: asked, stopReason: response.stopReason })
      else if (asked === sessionId) emit({ type: 'turn_end', stopReason: response.stopReason })
    } catch (err) {
      if (operation.released) return
      if (operation.stream) await streams.complete(operation.stream)
      if (operation.released) return
      const message = describeError(err, stderrTail)
      // Viva quitting ends a task's turn too: it is not over, and the next launch offers it (task-store.js).
      if (isTask(asked)) {
        if (!disposed) emit({ type: 'task_end', taskId: asked, stopReason: 'error', message })
      } else if (asked === sessionId) emit({ type: 'error', message })
    } finally {
      if (running.get(asked) === operation) running.delete(asked)
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

  function retire(id: string, measure: ReturnType<typeof sessionTiming>) {
    if (closing.has(id)) return
    const cleanup = (async () => {
      if (running.has(id)) {
        try { await measure('session.cancel', () => live().cancel({ sessionId: id })) }
        catch (err) { console.error('[acp-bridge] cancel failed; still closing session:', describeError(err)) }
      }
      await measure('session.close', () => live().closeSession({ sessionId: id }))
    })()
    closing.set(id, cleanup)
    void cleanup.then(() => {
      closing.delete(id)
      failedCloses.delete(id)
      if (!switching && sessionId) prepareFresh()
    }, err => {
      closing.delete(id)
      failedCloses.add(id)
      console.error('[acp-bridge] session cleanup failed; will retry before another cold session:', describeError(err))
    })
  }

  /**
   * Leaves the current session for `targetSessionId` (a reopened conversation), or for a fresh one when null.
   * @param targetCwd its directory, when not the current one
   * @param exactly that session or none (继续这个话题, switchExactly): when it cannot be resumed, the agent stays
   *   on the session it is on (nothing is lost by trying) and a ResumeError says why
   */
  async function switchSession(targetSessionId: string | null, targetCwd = sessionCwd, { exactly = false } = {}) {
    if (switching) throw Error(t("main.acp-bridge.preparing.the.session.please.wait"))
    switching = true
    const measure = sessionTiming(onTiming)
    try {
      if (targetSessionId && exactly) return await measure('session.switch', () => switchExactly(targetSessionId, targetCwd, measure))
      return await measure('session.switch', async () => {
        const leaving = sessionId
        questions.declineAll()
        config?.closeAll()
        steering.closeAll()
        forking.closeAll()
        if (leaving) broker.cancelAll(leaving)
        // Detach immediately: a closing session must never update the new topic or ask for permission.
        sessionId = null
        configNow = null
        for (const id of failedCloses) retire(id, measure)
        if (leaving) retire(leaving, measure)
        const barriers = [...closing.values()]
        const released = () => measure('session.wait-for-close', () => Promise.all(barriers))
        if (targetSessionId) {
          await released()
          return resumeOrOpen(targetSessionId, targetCwd)
        }
        sessionCwd = targetCwd
        // One old foreground session may drain in parallel, never an unbounded pile after rapid clicks.
        if (closing.size > 1) await released()
        // A prepared session already acquired its MCP resources. A cold MCP start must wait for old ones.
        return openSession(mcpServers().length ? released : undefined)
      })
    } catch (err) {
      if (err instanceof ResumeError) throw err
      throw new Error(describeError(err, stderrTail))
    } finally { switching = false; if (sessionId) prepareFresh() }
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
    return preparingSwitch(async () => {
      const result = await forking.fork({ before, words, occurrence, cwd: targetCwd })
      if (!result.ok) return result
      return { ok: true as const, info: await switchSession(result.sessionId, targetCwd ?? sessionCwd) }
    })
  }

  /**
   * How many switches are being prepared (a session forked before switching to it): from the start, as the switch
   * itself, no question goes in (isSwitching), else it would go to the session about to be left.
   */
  let preparing = 0
  async function preparingSwitch<T>(work: () => Promise<T>): Promise<T> {
    preparing += 1
    try {
      return await work()
    } finally {
      preparing -= 1
    }
  }

  /**
   * The turn running in the main conversation goes on in the background as a task (its session stays open,
   * nothing stops); the main conversation goes on from before that turn, in a session forked there, found by
   * the words that started it (the viva-fork plugin).
   */
  const spinOff = ({ words }: { words: string }) => preparingSwitch(() => spinningOff({ words }))
  async function spinningOff({ words }: { words: string }) {
    const taskId = sessionId
    if (!taskId || !running.has(taskId)) return { ok: false, reason: 'idle' }
    const forked = await forking.fork({ words, occurrence: 0 })
    if (!forked.ok) return forked
    tasks.set(taskId, { cwd: sessionCwd, config: configNow })
    for (const requestId of broker.pendingFor(taskId)) emit({ type: 'task_permission_waiting', taskId, requestId })
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
  async function matchMainConfig(taskId: string, taskOptions: readonly ConfigOption[], source = configNow) {
    for (const option of source ?? []) {
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
    const originCwd = sessionCwd
    const originConfig = configNow
    const forked = await forking.fork(words ? { words, occurrence: 0 } : {})
    if (forked.ok) {
      const taken = await resumeTask({ taskId: forked.sessionId, cwd: originCwd })
      if (!taken.ok) return taken
      // A fork of a conversation with nothing said yet starts on the profile's defaults too.
      await matchMainConfig(forked.sessionId, tasks.get(forked.sessionId)?.config ?? [], originConfig)
      return { ok: true, taskId: forked.sessionId }
    }
    try {
      const { response } = await fresh.take(freshKey(originCwd), originCwd)
      prepareFresh()
      tasks.set(response.sessionId, { cwd: originCwd, config: response.configOptions ?? originConfig })
      // A fresh session starts on the profile's defaults: the model picked here may be another (or the only one with a key).
      await matchMainConfig(response.sessionId, response.configOptions ?? [], originConfig)
      return { ok: true, taskId: response.sessionId }
    } catch (err) {
      console.error('[acp-bridge] could not start a task:', describeError(err))
      return { ok: false, reason: 'missing' }
    }
  }

  /** A turn in a task's session: what it says arrives as task_update, its end as task_end (as for a spun-off turn). */
  async function promptTask(taskId: string, text: string) {
    if (!tasks.has(taskId)) return
    const operation: Running = { released: false }
    running.set(taskId, operation)
    try {
      operation.stream = await streams.begin(taskId)
      const response = await live().prompt({ sessionId: taskId, prompt: [{ type: 'text', text }] })
      if (operation.released) return
      await streams.complete(operation.stream)
      if (operation.released) return
      if (tasks.has(taskId)) emit({ type: 'task_end', taskId, stopReason: response.stopReason })
    } catch (err) {
      if (operation.released) return
      if (operation.stream) await streams.complete(operation.stream)
      if (operation.released) return
      // As in prompt(): ended because Viva is quitting, it is not over.
      if (tasks.has(taskId) && !disposed) emit({ type: 'task_end', taskId, stopReason: 'error', message: describeError(err, stderrTail) })
    } finally {
      if (running.get(taskId) === operation) running.delete(taskId)
    }
  }

  /**
   * Stops what a task is doing; it stays, answered as cancelled (task_end). A turn that does not stop is let
   * go after a while (stop-in-time.ts), so 停下 always ends it on screen; what dsh started may still be running.
   */
  async function cancelTask(taskId: string) {
    if (!tasks.has(taskId)) return
    const operation = running.get(taskId)
    if (!operation) return
    broker.cancelAll(taskId)
    await stopInTime({
      cancel: () => live().cancel({ sessionId: taskId }),
      stillRunning: () => running.get(taskId) === operation && !operation.released && !disposed,
      giveUp: () => {
        if (operation.stream) streams.finish(operation.stream)
        operation.released = true
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
  const reloadSession = () => { failedMcp.clear(); fresh.reset(); return switchSession(sessionId) }

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
    fresh.dispose()
    streams.close()
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
    return [...running.keys()].filter(id => isTask(id) && !running.get(id)?.released && !waiting.has(id as string)).length
  }

  /** Background preparation: one model call with no tools, from the followups plugin; nothing while dsh is down. */
  function prepareText(call: PrepareCall, signal?: AbortSignal): Promise<Prepared> {
    if (!child?.connected) return Promise.resolve({ ok: false, problem: t("main.acp-bridge.the.assistant.is.not.ready.yet"), called: false })
    return followupDesk.prepare(call, signal)
  }

  /** dsh's process id while it runs (the smoke run uses it to check recovery from a crash). */
  const pid = () => (child && isRunning(child) ? child.pid : null)

  /** Whether the main session is being switched (a topic taken up, a new one, going back): no question goes in meanwhile. */
  const isSwitching = () => switching || preparing > 0
  return { start, prompt, steer, fork, spinOff, mergeBack, resumeTask, startTask, promptTask, cancelTask, closeTask, steerTask, cancel, newSession, switchSession, reloadSession, setConfig, respondPermission, answerQuestion, provideSecrets, prepareText, workingTasks, isSwitching, dispose, pid }
}

onLocaleChange(() => {
  NO_IMAGES = t("main.acp-bridge.this.model.cannot.read.images.among.deepseek")
  STOPPED_ANYWAY = t("main.acp-bridge.stopped.a.command.started.earlier.did.not")
})

import type { SessionWaits } from '../shared/ipc-results.ts'
import { diagnosticHub } from '../diagnostics/node/hub.ts'
import type { ConversationContext } from '../shared/conversation-context.ts'
import { objectOf } from '../shared/unknown-value.ts'
import { t } from '../shared/i18n/translate.ts'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { McpServerEntry } from '../shared/mcp-channel.ts'
import { createMcpDesk } from './mcp-desk.ts'
import fs from 'node:fs'
import { Readable, Writable } from 'node:stream'
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import type { RequestPermissionRequest, SessionNotification, SessionConfigOption } from '@agentclientprotocol/sdk'
import { dshLaunch } from './config.ts'
import { createPermissionBroker } from './permission-broker.ts'
import { createConfigDesk } from './config-channel.ts'
import { createSteerDesk, interjection, NO_PLUGIN } from './steer-channel.ts'
import { createRemoteMemoryChannel } from './remote-memory-channel.ts'
import { createRoutingDesk, type RoutingHandlers } from './routing-channel.ts'
import { withRequestSource } from '../shared/request-routing/header.ts'
import { withTaskRequestSource } from '../shared/request-routing/task-header.ts'
import { createForkDesk } from './fork-channel.ts'
import { createTasksDesk } from './tasks-channel.ts'
import { createHistoryDesk, type HistoryRead, type HistorySearch } from './history-channel.ts'
import { createPluginsDesk, type PluginsOp, type PluginsResult } from './plugins-channel.ts'
import type { TaskAct, TaskRead } from './tasks-channel.ts'
import { createQuestionDesk } from './question-channel.ts'
import { ResumeError, resumeReason } from './resume-failure.ts'
import { ForegroundRequestRetired } from './foreground-requests.ts'
import { createAcpOperations } from './acp-operations.ts'
import { createAcpTaskSessions } from './acp-task-sessions.ts'
import { createAssistantStream } from './assistant-stream.ts'
import { createFreshSessions } from './fresh-sessions.ts'
import { sessionTiming, type SessionTiming } from './session-timing.ts'
import { describeConfig, describeError } from './session-info.ts'
import pkg from '../../package.json' with { type: 'json' }

import { createToolBudgetWatchdog } from './tool-budget-watchdog.ts'

const STDERR_TAIL_LIMIT = 4000
export const switchingMessage = () => t("session.switching")
/** dsh gets this long to finish after its input closes, then its process tree is ended; then killed outright. */
const SHUTDOWN_GRACE_MS = 1500
// The version the app was built as, so it cannot fall behind a release (package.json ships in the app).
const CLIENT_INFO = { name: 'viva', version: pkg.version }
const CLIENT_CAPABILITIES = { fs: { readTextFile: false, writeTextFile: false }, terminal: false }
/** dsh decides at launch, from the model it starts on, whether its prompts take pictures. */
const noImagesMessage = () => t("main.acp-bridge.this.model.cannot.read.images.among.deepseek")
/** A task let go when it would not stop (cancelTask): what dsh started for it may still be running. */
const stoppedMessage = () => t("main.acp-bridge.stopped.a.command.started.earlier.did.not")
const NO_MCP = (): McpServerEntry[] => []
type PromptBlocks = Parameters<ClientSideConnection['prompt']>[0]['prompt']
/** One of a session's choices (model, effort), as dsh lists them; only these fields are read here. */
type ConfigOption = SessionConfigOption
/** What the bridge tells its owner (main.ts): the agent's events, as plain objects. */
type Emit = (event: { type: string, [field: string]: unknown }) => void

/** The session a call to dsh is for; one asked for before any session is open is refused here, not by dsh. */
function opened(id: string | null): string {
  if (!id) throw new Error('no session is open')
  return id
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
 * `mcpServers()` lists the user's MCP servers; viva-mcp registers them once for the whole dsh with its MCP manager
 * (mcp-desk.ts), so no session waits on them: sessions open with none of their own.
 * `onExit`, when given, hears about dsh ending on its own (a crash) instead of the window getting an error,
 * so the owner can start it again.
 */
export function createAcpBridge({
  dshBin, nodeBin = 'node', profile, overlay = null as string | null, cwd, env = process.env, emit, spawnFn = spawn, mcpServers = NO_MCP,
  onExit = null as ((exit: { code: number | null, signal: string | null, message: string }) => void) | null,
  platform = process.platform, configActions = null as Parameters<typeof createConfigDesk>[0]['actions'] | null,
  taskRead = null, taskAct = null, historySearch = null, historyRead = null, prewarmSessions = false, onTiming, conversationContext,
  launch = null as object | null, routing, onQuestionAnswer, admitTaskWaitResume, onSessionCreated, projectMatches, readyMemory, memoryStateChanged, memoryNotice, memoryContextUsed,
  allowGeneralQuestion, recordSource,
}: {
  dshBin: string, nodeBin?: string, profile: string,
  /** Sent to dsh first, over IPC, for the app's entry to take before dsh boots (dsh-launch.ts); never in its environment. */
  launch?: object | null,
  /** The app's layer over the profile (dsh-profile.ts vivaLayerFile); none for the stock fallback profile. */
  overlay?: string | null, cwd: string, env?: NodeJS.ProcessEnv, emit: Emit,
  spawnFn?: typeof spawn, mcpServers?: () => McpServerEntry[],
  onExit?: ((exit: { code: number | null, signal: string | null, message: string }) => void) | null,
  platform?: string, configActions?: Parameters<typeof createConfigDesk>[0]['actions'] | null,
  recordSource?: (input: { session: string, text: string, wireText: string, sourceId?: string,
    wireSpans?: Array<{ start: number, end: number }>, task?: boolean }) => void,
  taskRead?: TaskRead | null,
  /** Schedule actions from viva-tasks. */
  taskAct?: TaskAct | null,
  /** What was said in the timeline before, for search_conversations (viva-history); null leaves it saying there is none. */
  historySearch?: HistorySearch | null,
  /** The messages around one found, for read_conversation (viva-history). */
  historyRead?: HistoryRead | null,
  prewarmSessions?: boolean,
  onTiming?: (sample: SessionTiming) => void,
  conversationContext?: (sessionId: string) => ConversationContext | null,
  allowGeneralQuestion?: (session: string, turn: string | undefined, questions: readonly import('./question-channel.ts').Question[], stillWaiting: () => boolean, phase?: 'show' | 'check') =>
    import('./question-channel.ts').QuestionAdmission | Promise<import('./question-channel.ts').QuestionAdmission>,
  readyMemory?: () => void,
  memoryContextUsed?: (notice: import('../memory/contracts/host.ts').MemoryOwnerContextUsed) => void,
  memoryNotice?: (notice: import('../memory/contracts/host.ts').MemoryOwnerChange) => void,
  memoryStateChanged?: (state: import('../memory/contracts/host.ts').MemoryOwnerState) => void,
  onSessionCreated?: (id: string, cwd: string) => void,
  projectMatches?: (id: string, cwd: string) => boolean,
  onQuestionAnswer?: Parameters<typeof createQuestionDesk>[0]['onAnswer'],
  admitTaskWaitResume?: (kind: 'permission' | 'answer', id: string) => boolean,
  /**
   * The request runtime (request-runtime.ts): the user's words to the main conversation are each a request, taken
   * here as they are sent; the routing plugin's decisions and failures go to it (routing-channel.ts).
   */
  routing: RoutingHandlers,
}) {
  const broker = createPermissionBroker()
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
  let recoveryRequired = false
  const toolWatchdog = createToolBudgetWatchdog({
    currentTurn: id => id === sessionId ? operations.turn(id) : undefined,
    onStuck: id => { if (id === sessionId) void cancel() },
  })

  const toPlugins = (message: object) => {
    if (child?.connected) child.send(message)
  }
  /**
   * Background tasks (phase 3): sessions that went on in the background, by id (the task's id is its
   * session's). They stay open beside the main conversation; what they report reaches the window as task_*.
   */
  const taskOf = (id: string) => taskSessions.taskOf(id)
  const isTask = (id: string | null) => id !== null && taskSessions.has(id)
  const scoped = (context: ConversationContext | null | undefined) => context ? { context } : {}
  const contextFor = (id: string | null) => id ? conversationContext?.(id) ?? null : null
  const requestContext = conversationContext ? (id: string) => operations.turn(id) ? operations.context(id) : null : undefined
  let currentProfileDeletionGen: number | undefined
  let currentMemoryOwnerPid: number | null = null
  const questions = createQuestionDesk({ send: toPlugins, emit, sessionId: () => sessionId, taskOf, conversationContext: requestContext, onAnswer: onQuestionAnswer,
    profileDeletionGen: () => currentProfileDeletionGen,
    allowGeneralQuestion: async (session, cards, waiting, phase) => {
      if (taskSessions.isUnattended(session)) return false
      if (!allowGeneralQuestion) return true
      const operation = operations.turn(session)
      if (!operation) return false
      const stillWaiting = () => waiting() && !disposed && operations.turn(session) === operation
      const result = allowGeneralQuestion(session, operation, cards, stillWaiting, phase)
      const bound = (allowed: import('./question-channel.ts').QuestionAdmission) => allowed === false ? false
        : () => stillWaiting() && (typeof allowed !== 'function' || allowed())
      return typeof result === 'object' ? result.then(bound) : bound(result)
    },
  })
  // MCP servers and skills set up from the conversation (the viva-config plugin); the app performs them.
  const config = configActions ? createConfigDesk({ send: toPlugins, emit, sessionId: () => sessionId, actions: configActions, conversationContext: requestContext }) : null
  // What the user says while a turn runs goes to that turn (the viva-steer plugin), not to a new prompt.
  // Background tasks' results go the same way, at most once; the plugin says when one is read or lost.
  const steering = createSteerDesk({ send: toPlugins, sessionId: () => sessionId, onReport: (event) => emit(event),
    onRunning: session => {
      if (session === sessionId && operations.userTurn(session)) emit({ type: 'human_turn_running', sessionId: session })
    } })
  // Going back to an earlier point, or on in another directory (the viva-fork plugin, prototype).
  const forking = createForkDesk({ send: toPlugins, sessionId: () => sessionId })
  // The plugins page, through dsh's plugin manager (viva-plugins).
  const pluginsDesk = createPluginsDesk({ send: toPlugins })
  // The user's MCP servers, for viva-mcp: sent when it starts and when they change; how each stands comes back.
  const mcpDesk = createMcpDesk({ send: toPlugins, servers: mcpServers, onStatus: (mcp) => emit({ type: 'mcp_status', mcp }) })
  const activeToolSession = (id: string) => (id === sessionId && !recoveryRequired) || taskSessions.has(id)
  const tasksDesk = createTasksDesk({ send: toPlugins, read: taskRead, act: taskAct, authorized: activeToolSession })
  const historyDesk = createHistoryDesk({ send: toPlugins, search: historySearch, read: historyRead, authorized: activeToolSession })
  const streams = createAssistantStream({ send: toPlugins, emit: (id, update) => operations.forwardStream(id, update) })
  const ownerChannel = createRemoteMemoryChannel({
    send: toPlugins,
    onReady: readyMemory,
    onChanged: state => {
      if (state.profileDeletionGen !== undefined) currentProfileDeletionGen = state.profileDeletionGen
      currentMemoryOwnerPid = state.state === 'unavailable' ? null : (state.pid ?? currentMemoryOwnerPid)
      memoryStateChanged?.(state)
    },
    onNotice: memoryNotice,
    onContextUsed: memoryContextUsed,
  })
  const memory = {
    call: ownerChannel.call,
    callIntake: ownerChannel.callIntake,
    state: ownerChannel.state,
    readBatch: ownerChannel.readBatch,
    ready: ownerChannel.ready,
    waitReady: ownerChannel.waitReady,
    receive: ownerChannel.receive,
  }
  // The main conversation routes every request (the viva-routing plugin); its role is bound before each prompt.
  const routingDesk = createRoutingDesk({ send: toPlugins, handlers: routing })
  /** The user's words as the main agent reads them: under the header of the request they are taken as. */
  const asRequest = (words: string, session: string, kind: 'prompt' | 'interjection', sourceId?: string, sourceText = words) => {
    const context = contextFor(session)
    const requestId = randomUUID()
    const request = { id: requestId, sessionId: session, conversationId: context?.conversationId ?? null, cwd: sessionCwd, kind, sourceId }
    return { requestId, ...withRequestSource(words, requestId, sourceText), register: () => routing.receive(request) }
  }
  const operations = createAcpOperations({
    connection: live, streams,
    cancelPermissions: id => broker.cancelAll(id),
    streamUpdate: (id, update, context) => {
      if (taskSessions.has(id)) emit({ type: 'task_update', taskId: id, update })
      else if (id === sessionId) emit({ type: 'update', sessionId: id, update, ...scoped(context) })
    },
  })


  /** The model options of the session in use, kept so a task taken back to the main conversation keeps its own. */
  let configNow: ConfigOption[] | null = null
  const infoFrom = (configOptions: ConfigOption[] | null | undefined) => {
    configNow = configOptions ?? configNow
    return { mode: 'live', cwd: sessionCwd, reason: '', sessionId, mcp: mcpDesk.status(), ...describeConfig(configNow) }
  }

  const client = {
    async sessionUpdate(params: SessionNotification) {
      if (disposed || (recoveryRequired && params.sessionId === sessionId) || operations.isReleased(params.sessionId)) return
      if (streams.suppress(params.sessionId, params.update)) return
      if (taskSessions.has(params.sessionId)) return emit({ type: 'task_update', taskId: params.sessionId, update: params.update })
      if (params.sessionId !== sessionId) return
      if (params.update?.sessionUpdate === 'config_option_update') {
        emit({ type: 'config', info: infoFrom(params.update.configOptions), ...scoped(contextFor(params.sessionId)) })
        return
      }
      // The session goes with it: the window tells the turn it undid a move for from the one it left (task-actions.js).
      const context = operations.context(params.sessionId)
      if (conversationContext && !context) return
      emit({ type: 'update', sessionId: params.sessionId, update: params.update, ...scoped(context) })
    },
    async requestPermission(params: RequestPermissionRequest) {
      if (disposed || !activeToolSession(params.sessionId)) return { outcome: { outcome: 'cancelled' as const } }
      const turn = operations.turn(params.sessionId)
      // Nobody is there to answer unattended requests.
      if (taskSessions.isUnattended(params.sessionId)) return { outcome: { outcome: 'cancelled' as const } }
      if (disposed || !activeToolSession(params.sessionId) || conversationContext && !taskSessions.has(params.sessionId)
        && (!requestContext?.(params.sessionId) || operations.turn(params.sessionId) !== turn)) return { outcome: { outcome: 'cancelled' as const } }
      const { requestId, promise } = broker.create(params)
      const taskId = taskOf(params.sessionId)
      emit({ type: 'permission', requestId, sessionId: params.sessionId, toolCall: params.toolCall, options: params.options, ...(taskId ? { taskId } : scoped(operations.context(params.sessionId) ?? contextFor(params.sessionId))) })
      return promise.finally(() => {
        const currentTask = taskOf(params.sessionId)
        if (currentTask) emit({ type: 'task_permission_closed', taskId: currentTask, requestId })
      })
    },
  }

  function spawnRuntime() {
    const { command, args } = dshLaunch(dshBin, nodeBin, profile, overlay)
    const proc = spawnFn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] })
    child = proc
    const diagnostics = diagnosticHub()?.attach('dsh', (message, settled) => {
      if (proc.connected && proc.send) proc.send(message, settled)
      else settled(new Error('Diagnostic child disconnected'))
    })
    // A channel already closed (dsh failed to start) says so through 'exit'.
    if (launch) proc.send?.(launch, (err) => { if (err) console.error('[dsh] launch not sent:', err.message) })
    proc.on('message', (message) => {
      if (diagnostics?.receive(message)) return
      if (disposed || toolWatchdog.receive(message)) return
      if (ownerChannel.receive(message)) return
      const traceMessage = objectOf(message)
      if (traceMessage?.type === 'trace_model_call' && traceMessage.version === 1 && typeof traceMessage.sessionId === 'string') {
        const id = traceMessage.sessionId
        const update = { sessionUpdate: 'viva_model_call', call: traceMessage.call }
        if (taskSessions.has(id)) emit({ type: 'task_update', taskId: id, update })
        else if (id === sessionId && !recoveryRequired && !operations.isReleased(id)) {
          const context = operations.context(id) ?? contextFor(id)
          if (!conversationContext || context) emit({ type: 'update', sessionId: id, update, ...scoped(context) })
        }
        return
      }
      void questions.receive(message).catch(error => { console.error('[questions] owner authorization failed', error); questions.declineAll() })
      config?.receive(message)
      steering.receive(message)
      forking.receive(message)
      tasksDesk.receive(message)
      void historyDesk.receive(message)
      pluginsDesk.receive(message)
      streams.receive(message)
      routingDesk.receive(message)
      mcpDesk.receive(message)
    })
    proc.stderr?.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL_LIMIT)
    })
    proc.on('error', (err) => emit({ type: 'error', message: launchError(err, { command, nodeBin, cwd }) }))
    proc.on('exit', (code, signal) => {
      diagnostics?.close()
      toolWatchdog.clear()
      fresh.dispose()
      operations.dispose()
      currentMemoryOwnerPid = null
      ownerChannel.processExited()
      ownerChannel.close()
      taskSessions.dispose()
      pluginsDesk.close()
      routingDesk.close()
      if (disposed) return
      disposed = true
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

  const fresh = createFreshSessions({
    // No MCP servers of its own: viva-mcp has them for the whole dsh, so a slow or broken one never holds a session up.
    open: async (targetCwd: string, speculative: boolean) => ({
      response: await sessionTiming(onTiming)('session.create', () => live().newSession({ cwd: targetCwd, mcpServers: [] }), speculative ? 'speculative' : 'requested'),
    }),
    close: entry => live().closeSession({ sessionId: entry.response.sessionId }),
  })
  const freshKey = (targetCwd: string) => targetCwd
  const prepareFresh = () => {
    if (prewarmSessions && !disposed && !closing.size && !failedCloses.size) fresh.prepare(freshKey(sessionCwd), sessionCwd)
    else fresh.clear()
  }

  const taskSessions = createAcpTaskSessions({
    connection: live,
    acquire: {
      resume: (sessionId, cwd) => live().resumeSession({ sessionId, cwd, mcpServers: [] }),
      fresh: async cwd => {
        const { response } = await fresh.take(freshKey(cwd), cwd)
        onSessionCreated?.(response.sessionId, cwd)
        return response
      },
    },
    foreground: () => ({ sessionId, cwd: sessionCwd, config: configNow }), canResume: () => canResume, prepareFresh,
    operations, permissions: broker, questions,
    preparePrompt: async (id, text) => {
      const wrapped = withTaskRequestSource(text, randomUUID())
      recordSource?.({ session: id, text, wireText: wrapped.text, wireSpans: wrapped.spans, task: true })
      return wrapped.text
    },
    steer: async (id, text) => {
      const wrapped = withTaskRequestSource(text, randomUUID())
      recordSource?.({ session: id, text, wireText: wrapped.text, wireSpans: wrapped.spans, task: true })
      return steering.steer(wrapped.text, id)
    },
    emit, describeError: error => describeError(error, stderrTail),
    goneMessage: () => t('main.acp-bridge.task.session.gone'), stoppedMessage,
  })
  const { resumeTask, startTask, startUnattendedTask, promptTask, cancelTask, closeTask, steerTask } = taskSessions

  async function openSession(beforeOpen?: () => Promise<unknown>) {
    const measure = sessionTiming(onTiming)
    let source = 'cold'
    const { response } = await measure('session.acquire', () => fresh.take(freshKey(sessionCwd), sessionCwd, {
      beforeOpen, onUse: value => { source = value },
    }))
    await measure('session.source', async () => {}, source)
    sessionId = response.sessionId
    onSessionCreated?.(sessionId, sessionCwd)
    prepareFresh()
    return { ...infoFrom(response.configOptions), resumed: false }
  }

  /**
   * Reattaches to a session from an earlier launch (`session/resume`); dsh keeps its context, nothing is replayed.
   * @param targetCwd the session's directory, when not the current one
   */
  async function resumeOrOpen(resumeSessionId: string | null, targetCwd = sessionCwd) {
    sessionCwd = targetCwd
    if (!resumeSessionId || !canResume || projectMatches?.(resumeSessionId, targetCwd) === false) return openSession()
    let response
    try {
      response = await live().resumeSession({ sessionId: resumeSessionId, cwd: targetCwd, mcpServers: [] })
    } catch (err) {
      if (resumeReason(err) !== 'gone') throw err
      console.error('[acp-bridge] could not resume the saved session, starting a new one:', describeError(err))
      return openSession()
    }
    sessionId = resumeSessionId
    onSessionCreated?.(sessionId, sessionCwd)
    prepareFresh()
    return { ...infoFrom(response.configOptions), resumed: true }
  }

  /**
   * Goes over to exactly that session, in its own directory, or throws why not (resume-failure.ts), the agent left
   * as it was: the session is resumed first, beside the one in use (dsh holds several, as it does tasks), and only
   * then is the one in use left. So a failure, or a session that will not close, never leaves the conversation on
   * screen without its session, nor puts a new one in its place.
   */
  async function switchExactly(targetSessionId: string, targetCwd: string, measure: ReturnType<typeof sessionTiming>) {
    const leaving = sessionId
    if (projectMatches?.(targetSessionId, targetCwd) === false) throw new ResumeError('gone', t('session.resume.unsupported'))
    if (targetSessionId === leaving) {
      return { ...infoFrom(configNow ?? undefined), resumed: true }
    }
    if (!canResume) throw new ResumeError('gone', t("session.resume.unsupported"))
    let response
    try {
      // Closed earlier (撤销 a new topic goes back to the session just left): that close finishes first.
      await closing.get(targetSessionId)?.catch(() => {})
      response = await live().resumeSession({ sessionId: targetSessionId, cwd: targetCwd, mcpServers: [] })
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
   * Its end is the main conversation's, or (once the turn went to the background) its task's. The session is bound as
   * the main conversation before the prompt goes (routing-channel.ts).
   * @param images pictures pasted with it, base64
   * @param request whether these are the user's words, a request of their own; a task's result coming back is not
   */
  async function prompt(text: string, images: Array<{ data: string, mimeType: string }> = [], { request = true, userTurn = request, onStart, sourceId, sourceText, held }: {
    request?: boolean, userTurn?: boolean, onStart?: () => void, sourceId?: string, sourceText?: string, held?: () => boolean,
  } = {}) {
    // Mid-switch (or while one is prepared) it would go to the session about to be left, cut off when that closes.
    if (recoveryRequired) throw new Error(t('conversation.stop.unconfirmed'))
    if (isSwitching()) throw new Error(switchingMessage())
    if (images.length && !seesImages) {
      emit({ type: 'error', message: noImagesMessage(), ...scoped(contextFor(sessionId)) })
      return
    }
    const asked = sessionId
    if (asked !== sessionId || isSwitching() || disposed) throw new Error(switchingMessage())
    if (held && !held()) throw new Error(t('main.memory.context.stale'))
    const origin = contextFor(asked), context = origin ? { ...origin } : null
    const effectiveSourceText = sourceText !== undefined ? sourceText : text
    const routed = request && asked ? asRequest(text, asked, 'prompt', sourceId, effectiveSourceText) : null
    const words = routed?.text ?? text
    if (asked && request) recordSource?.({ session: asked, sourceId, text: effectiveSourceText, wireText: words, wireSpans: routed?.spans })
    if (held && !held()) throw new ForegroundRequestRetired()
    if (asked !== sessionId || isSwitching() || disposed || recoveryRequired) throw new Error(switchingMessage())
    routed?.register()
    const blocks: PromptBlocks = [
      ...images.map(({ data, mimeType }) => ({ type: 'image' as const, data, mimeType })),
      ...(words ? [{ type: 'text' as const, text: words }] : []),
    ]
    await operations.run({
      sessionId: asked, prompt: blocks, context, userTurn, held, onStart,
      prepare: asked ? () => routingDesk.bind(asked) : undefined,
      onEnd: (response, finalReply) => {
        if (asked === sessionId) toolWatchdog.clear()
        if (isTask(asked)) emit({ type: 'task_end', taskId: asked, stopReason: response.stopReason })
        else if (asked === sessionId) emit({ type: 'turn_end', stopReason: response.stopReason,
          ...(response.stopReason === 'end_turn' && finalReply !== undefined ? { finalReply } : {}), ...scoped(context) })
      },
      onError: error => {
        if (asked === sessionId) toolWatchdog.clear()
        const message = describeError(error, stderrTail)
        if (isTask(asked)) { if (!disposed) emit({ type: 'task_end', taskId: asked, stopReason: 'error', message }) }
        else if (asked === sessionId) emit({ type: 'error', message, ...scoped(context) })
      },
    })
  }

  async function cancel(expectedSession = sessionId) {
    const asked = sessionId
    if (!connection || !asked || expectedSession !== asked) return false
    const context = operations.context(asked)
    const settle = (stopReason: 'cancelled' | 'cancel_unconfirmed') => {
      if (asked === sessionId && !disposed) emit({ type: 'turn_end', stopReason, ...scoped(context) })
    }
    return operations.cancelInTime(asked, () => {
      if (asked !== sessionId || disposed) return
      recoveryRequired = true
      settle('cancel_unconfirmed')
    }, {
      onRequested() {
        emit({ type: 'turn_stopping', ...scoped(context) })
        toolWatchdog.clear()
        operations.endUserTurn(asked)
        endRequestsOf(asked)
        questions.declineAll()
        config?.closeAll()
      },
      onPreparingCancelled: () => settle('cancelled'),
    })
  }

  /**
   * A main session's turn stopped (the user's Stop) or left: what it left undecided fails as cancelled, and a decision
   * still being carried out sends nothing more (request-runtime.ts), at once rather than once the turn winds down.
   */
  function endRequestsOf(id: string) {
    try { routing.endTurn({ sessionId: id, reason: 'cancelled' }) }
    catch (err) { console.error('[acp-bridge] could not end the requests of a stopped session:', describeError(err)) }
  }

  function retire(id: string, measure: ReturnType<typeof sessionTiming>) {
    if (closing.has(id)) return
    // Its turn, if one runs, ends here: what it said reaches nothing from now on, its turn_end included.
    endRequestsOf(id)
    const cleanup = (async () => {
      if (operations.has(id)) {
        try { if (!operations.cancelPreparing(id, () => {})) await measure('session.cancel', () => live().cancel({ sessionId: id })) }
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
    if (recoveryRequired) throw new Error(t('conversation.stop.unconfirmed'))
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
        return openSession()
      })
    } catch (err) {
      if (err instanceof ResumeError) throw err
      throw new Error(describeError(err, stderrTail))
    } finally { switching = false; if (sessionId) prepareFresh() }
  }

  /**
   * Goes back to before the `before`-th user message (every turn that ended when omitted), optionally in another
   * directory, and goes on there: the plugin writes the new session, this side resumes it. The session left
   * behind stays as it was.
   * Or to before the turn where the user said `words` (the `occurrence`-th such turn from the end, 0 the last).
   */
  async function fork({ before, words, occurrence, cwd: targetCwd }: { before?: number, words?: string, occurrence?: number, cwd?: string } = {}): Promise<
    { ok: false, reason: string } | { ok: true, info: Awaited<ReturnType<typeof switchSession>> }
  > {
    return preparingSwitch(async () => {
      const directory = targetCwd ?? sessionCwd
      if (sessionId && projectMatches?.(sessionId, directory) === false) return { ok: false as const, reason: 'missing' }
      const result = await forking.fork({ before, words, occurrence, cwd: targetCwd })
      if (!result.ok) return result
      onSessionCreated?.(result.sessionId, directory)
      return { ok: true as const, info: await switchSession(result.sessionId, directory, { exactly: true }) }
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

  const newSession = () => switchSession(null)
  /** Reattaches the current session, keeping its context. */
  const reloadSession = () => { fresh.reset(); return switchSession(sessionId) }

  /**
   * Hands `text` to the turn that is running. Not ok with reason 'idle' when the turn has just ended (the
   * caller asks it as a new question), else when it could not be sent (steer-channel.js NO_PLUGIN, or the
   * plugin's reasons).
   */
  /**
   * The user's words into the running turn of the conversation on screen, marked as said mid-turn, a request of their
   * own; one that reached no turn fails, since the window asks the words anew.
   */
  async function steer(text: string, sourceId?: string, held: () => boolean = () => true,
    retiredReason: () => 'idle' | 'unavailable' = () => 'unavailable', onDispatch?: () => void) {
    const retired = () => ({ ok: false as const, reason: retiredReason(), delivery: 'not-sent' as const })
    if (!held()) return retired()
    if (!sessionId || recoveryRequired) return { ok: false as const, reason: 'unavailable', delivery: 'not-sent' as const }
    const asked = sessionId
    if (!held()) return retired()
    if (asked !== sessionId || isSwitching() || disposed) return { ok: false as const, reason: 'unavailable', delivery: 'not-sent' as const }
    const request = asRequest(text, asked, 'interjection', sourceId)
    const wrapped = interjection(request.text)
    const prefixLength = wrapped.length - request.text.length
    const spans = request.spans.map(({ start, end }) => ({ start: start + prefixLength, end: end + prefixLength }))
    const undelivered = () => routing.fail({ requestId: request.requestId, sessionId: asked, reason: 'undelivered' })
    recordSource?.({ session: asked, sourceId, text, wireText: wrapped, wireSpans: spans })
    if (!held()) return retired()
    if (asked !== sessionId || isSwitching() || disposed) return { ok: false as const, reason: 'unavailable', delivery: 'not-sent' as const }
    request.register()
    onDispatch?.()
    const result = await steering.steer(wrapped, asked, { fast: true })
    // A lost transport receipt leaves the request routable if the native inbox took it.
    if (!result.ok && result.reason !== NO_PLUGIN) {
      undelivered()
    }
    return result
  }
  /** A background task's result into the running turn of `session`, at most once (task-reports.ts). */
  const deliverReport = async (session: string, reportId: string, token: string, text: string, held: () => boolean = () => true) => {
    if (recoveryRequired || !held()) return 'unavailable' as const
    if (!held() || session !== sessionId || isSwitching() || disposed) return 'unavailable' as const
    return steering.report(session, reportId, token, text)
  }
  /** How a background task's result stands in `session`: read, pending, or nowhere. */
  const reportStatus = (session: string, reportId: string, token: string) => steering.reportStatus(session, reportId, token)
  /** The main conversation's session, as dsh knows it; null while there is none. */
  const currentSession = (): string | null => sessionId

  /** optionId: the option picked, or null to turn it down without one. */
  function respondPermission(requestId: string, optionId: string | null) {
    return broker.resolve(requestId, optionId)
  }

  /** @returns false when the question is no longer waiting; throws when the answer does not fit it */
  const answerQuestion = (questionId: string, answers: unknown, operation?: string, options?: { recordMemory?: boolean }): Promise<boolean> =>
    questions.answer(questionId, answers, operation, options)
  /** What a background task waits on the user for, still: its approvals and its questions (a reloaded window shows them). */
  const taskWaits = taskSessions.waits
  /**
   * What the conversation on screen waits on the user for, still: its approvals, its questions and the keys a server
   * asks for, each as it was
   * asked, for a window that opens meanwhile (a reload on the same dsh), which shows them to be answered.
   */
  const sessionWaits = (): SessionWaits => (sessionId
    ? { permissions: broker.pendingFor(sessionId), questions: questions.pendingOf(null), secrets: config?.pendingSecrets() ?? [] }
    : { permissions: [], questions: [], secrets: [] })
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
    toolWatchdog.clear()
    fresh.dispose()
    operations.dispose()
    currentMemoryOwnerPid = null
    ownerChannel.close()
    taskSessions.dispose()
    broker.cancelAll()
    steering.closeAll()
    routingDesk.close()
    pluginsDesk.close()
    if (!child || !isRunning(child)) return Promise.resolve()
    const target = child
    const exited = new Promise((resolve) => target.once('exit', resolve))
    target.stdin?.end()
    setTimeout(() => endTree(target), SHUTDOWN_GRACE_MS).unref?.()
    setTimeout(() => isRunning(target) && target.kill('SIGKILL'), SHUTDOWN_GRACE_MS * 2).unref?.()
    return exited
  }

  /** Background tasks working right now: a turn running, not waiting on the user's permission. */
  const workingTasks = taskSessions.workingCount

  /** One call to dsh's plugin manager for the plugins page; refused while dsh is not running. */
  function plugins(op: PluginsOp, args: Record<string, unknown> = {}): Promise<PluginsResult> {
    if (!child?.connected) return Promise.resolve({ ok: false, problem: 'disconnected' })
    return pluginsDesk.call(op, args)
  }

  /** dsh's process id while it runs (the smoke run uses it to check recovery from a crash). */
  const pid = () => (child && isRunning(child) ? child.pid : null)
  const memoryOwnerPid = () => (child && isRunning(child) ? currentMemoryOwnerPid : null)

  /** Whether the main session is being switched (a topic taken up, a new one, going back): no question goes in meanwhile. */
  const isSwitching = () => switching || preparing > 0
  /** The MCP servers changed: viva-mcp takes the new set at once, no session is reopened. */
  const applyMcp = () => mcpDesk.push()
  /** 重试 on a server that stopped trying. */
  const restartMcp = (name: string) => mcpDesk.restart(name)

  /** Binds an unattended feed source session to verified read-only tools owned by `pluginName`. */
  async function bindFeedSourceSession(
    targetSessionId: string,
    binding: { pluginName: string, ownerEntryIds: readonly string[], allowedTools: readonly string[] },
  ): Promise<{ ok: true } | { ok: false, reason: string }> {
    if (!child?.connected) return { ok: false, reason: 'disconnected' }
    try {
      await routingDesk.bindSource(targetSessionId, binding)
      return { ok: true }
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) }
    }
  }

  return { applyMcp, restartMcp, start, prompt, steer, deliverReport, reportStatus, currentSession, fork, resumeTask, startTask, startUnattendedTask, bindFeedSourceSession, promptTask, cancelTask, closeTask, steerTask, cancel, newSession, switchSession, reloadSession, setConfig, respondPermission, answerQuestion, taskWaits, sessionWaits, provideSecrets, plugins, workingTasks, needsRecovery: () => recoveryRequired, isSwitching, dispose, pid, memoryOwnerPid, memory }
}

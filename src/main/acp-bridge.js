import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { Readable, Writable } from 'node:stream'
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { dshLaunch } from './config.js'
import { createPermissionBroker } from './permission-broker.js'
import { describeConfig, describeError } from './session-info.js'

const STDERR_TAIL_LIMIT = 4000
const SHUTDOWN_GRACE_MS = 1500
const CLIENT_INFO = { name: 'viva', version: '0.1.0' }
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

/**
 * Drives `dsh --profile <profile>` over stdio. Everything the agent reports is forwarded through `emit`
 * as plain objects: ready / update / config / permission / turn_end / error.
 * `mcpServers()` lists the MCP servers to attach to each session (read again on every new or resumed session).
 */
export function createAcpBridge({
  dshBin, nodeBin = 'node', profile, cwd, env = process.env, emit, spawnFn = spawn, mcpServers = NO_MCP,
}) {
  const broker = createPermissionBroker()
  let mcp = { active: [], dropped: [] }
  let child = null
  let connection = null
  let sessionId = null
  let canResume = false
  let stderrTail = ''
  let disposed = false

  const infoFrom = (configOptions) => ({ mode: 'live', cwd, reason: '', sessionId, mcp, ...describeConfig(configOptions) })

  const client = {
    async sessionUpdate(params) {
      if (params.sessionId !== sessionId) return
      if (params.update?.sessionUpdate === 'config_option_update') {
        emit({ type: 'config', info: infoFrom(params.update.configOptions) })
        return
      }
      emit({ type: 'update', update: params.update })
    },
    async requestPermission(params) {
      const { requestId, promise } = broker.create(params)
      emit({ type: 'permission', requestId, toolCall: params.toolCall, options: params.options })
      return promise
    },
  }

  function spawnRuntime() {
    const { command, args } = dshLaunch(dshBin, nodeBin, profile)
    child = spawnFn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    child.stderr?.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL_LIMIT)
    })
    child.on('error', (err) => emit({ type: 'error', message: launchError(err, { command, nodeBin, cwd }) }))
    child.on('exit', (code, signal) => {
      if (!disposed) emit({ type: 'error', message: describeError(`dsh 已退出（${code ?? signal}）`, stderrTail) })
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
    const response = await withMcpServers((servers) => connection.newSession({ cwd, mcpServers: servers }))
    sessionId = response.sessionId
    return { ...infoFrom(response.configOptions), resumed: false }
  }

  /** Reattaches to a session from an earlier launch (`session/resume`); dsh keeps its context, nothing is replayed. */
  async function resumeOrOpen(resumeSessionId) {
    if (!resumeSessionId || !canResume) return openSession()
    try {
      const response = await withMcpServers((servers) => connection.resumeSession({ sessionId: resumeSessionId, cwd, mcpServers: servers }))
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

  async function prompt(text) {
    try {
      const response = await connection.prompt({ sessionId, prompt: [{ type: 'text', text }] })
      emit({ type: 'turn_end', stopReason: response.stopReason })
    } catch (err) {
      emit({ type: 'error', message: describeError(err, stderrTail) })
    }
  }

  async function cancel() {
    broker.cancelAll()
    if (!connection || !sessionId) return
    try {
      await connection.cancel({ sessionId })
    } catch (err) {
      console.error('[acp-bridge] cancel failed:', describeError(err))
    }
  }

  /** Leaves the current session for `targetSessionId` (a reopened conversation), or for a fresh one when null. */
  async function switchSession(targetSessionId) {
    await cancel()
    try {
      await connection.closeSession({ sessionId })
    } catch (err) {
      console.error('[acp-bridge] closeSession failed, switching anyway:', describeError(err))
    }
    try {
      return await resumeOrOpen(targetSessionId)
    } catch (err) {
      throw new Error(describeError(err, stderrTail))
    }
  }

  const newSession = () => switchSession(null)
  /** Reattaches the current session, so a changed list of MCP servers takes effect without losing context. */
  const reloadSession = () => switchSession(sessionId)

  function respondPermission(requestId, optionId) {
    return broker.resolve(requestId, optionId)
  }

  function dispose() {
    disposed = true
    broker.cancelAll()
    if (!child) return
    child.stdin?.end()
    setTimeout(() => child.kill('SIGTERM'), SHUTDOWN_GRACE_MS).unref?.()
  }

  return { start, prompt, cancel, newSession, switchSession, reloadSession, setConfig, respondPermission, dispose }
}

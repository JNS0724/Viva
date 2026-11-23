import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import { ChildProcess } from 'node:child_process'
import { ownerRpcFrame } from '../../src/memory/contracts/owner-rpc.ts'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { TestContext } from 'node:test'
import { createAcpBridge } from '../../src/backend/acp-bridge.ts'
import { createDesktopMemoryOwner } from '../../src/backend/desktop-memory-owner.ts'
import { installedDshVersion, PERSONA, resolvePlugins } from '../../src/backend/app-plugins.ts'
import { DSH_PROFILE } from '../../src/backend/config.ts'
import { ensureDshProfile, vivaLayerFile } from '../../src/backend/dsh-profile.ts'
import { dshEnv, dshRuntime } from '../../src/backend/dsh-runtime.ts'
import { pnpmLauncher } from '../../src/backend/pnpm-launcher.ts'
import { removeTree } from '../../src/backend/remove-tree.ts'
import { startFakeLlm } from './fake-llm.ts'
import { testRequests } from './request-routing.ts'
import { objectOf } from '../../src/shared/unknown-value.ts'

/**
 * The app's plugins inside the real dsh: the app's bridge, the app's profile (persona and every plugin that
 * passes the compatibility check), and a fake Messages endpoint in place of DeepSeek, so every request the
 * model would get can be inspected. Everything lives in a temporary directory removed after the test.
 */
export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const DSH_BIN = path.join(ROOT, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
/** The app's runtime: this test process is the app's Electron running as Node (or DSH_NODE). */
const RUNTIME = dshRuntime({ env: process.env, execPath: process.execPath })
export const DSH_TIMEOUT_MS = 60_000
type Bridge = ReturnType<typeof createAcpBridge>
type BridgeOptions = Parameters<typeof createAcpBridge>[0]
type Event = Parameters<BridgeOptions['emit']>[0]
type Profile = Parameters<typeof ensureDshProfile>[0]
type Options = {
  mcpServers?: ReturnType<NonNullable<BridgeOptions['mcpServers']>>
  prewarmSessions?: boolean
  allow?: boolean
  models?: (llm: Awaited<ReturnType<typeof startFakeLlm>>) => Profile['models']
  env?: Record<string, string | undefined>
  configActions?: BridgeOptions['configActions']
  imagesDir?: (dir: string) => string
  permission?: string
  decideFirst?: ((request: never) => object | null) | null
  tasks?: NonNullable<Parameters<typeof testRequests>[0]>['tasks']
}

/**
 *   mcpServers: declared on every session;
 *   allow: answer every approval request with "allow once" (otherwise they stay pending);
 *   imagesDir: Viva's pictures folder (dsh-profile.js), given the temporary directory; permission: the level picked (viva-permission);
 *   models: the profile's model section (see dsh-profile.js), given the fake Messages endpoint; env: added to dsh's
 *   environment; decideFirst: the fake model's answers tried before its rules (fake-llm.ts), null to use the rules
 *   tasks: what the app's request runtime does with a decision's task actions (none by default: each fails)
 * Whatever the test opens in the directory (a database) is closed through `defer`, before the directory goes.
 * `requests` is the app's request runtime every bridge of the harness routes through (request-runtime.ts).
 */
export async function startHarness(t: TestContext, { mcpServers = [], prewarmSessions = false, allow = false, models, env: extraEnv = {}, configActions = null, imagesDir, permission, decideFirst = null, tasks }: Options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-harness-'))
  const dshHome = path.join(dir, 'dsh-home')
  const workspace = path.join(dir, 'workspace')
  fs.mkdirSync(workspace)
  const userData = path.join(dir, 'userData')
  const { plugins, problems } = resolvePlugins({ codeRoot: ROOT, userData, dshVersion: installedDshVersion(ROOT), permission })
  assert.deepEqual(problems, [], 'every app plugin passes the compatibility check')
  const llm = await startFakeLlm({ decideFirst: decideFirst ? request => decideFirst(request as never) : null })
  const requests = testRequests({ tasks })
  // As the app does at every launch (main.ts prepareProfile), with the pnpm the app ships for the plugin manager.
  const pnpmCommand = pnpmLauncher({ dir: path.join(dir, 'bin'), appRoot: ROOT, runtime: RUNTIME })
  const writeProfile = () => ensureDshProfile({ dshHome, profile: DSH_PROFILE, plugins, persona: PERSONA, models: models?.(llm), imagesDir: imagesDir?.(dir), pnpmCommand })
  writeProfile()
  const memoryOwner = createDesktopMemoryOwner({ root: path.join(userData, 'memory'), dailyNotes: true }, {})
  const bridges: Bridge[] = []
  const closers: Array<() => void> = []
  t.after(async () => {
    // dsh runs in the workspace: on Windows it cannot go until the process has exited.
    try {
      await Promise.all(bridges.map((bridge) => bridge.dispose()))
      await memoryOwner.close()
      for (const close of [...closers].reverse()) close()
      await llm.close()
    } finally {
      await removeEventually(dir)
    }
  })
  const defer = (close: () => void) => { closers.push(close) }
  const events: Event[] = []
  function bridge(options: Partial<BridgeOptions> = {}) {
    const created = createAcpBridge({
      routing: requests,
      dshBin: DSH_BIN,
      nodeBin: RUNTIME.nodeBin,
      profile: DSH_PROFILE,
      overlay: vivaLayerFile(dshHome),
      cwd: workspace,
      env: dshEnv({ base: process.env, dshHome, runtime: RUNTIME, settings: { DEEPSEEK_API_KEY: 'test-fake-key', DEEPSEEK_BASE_URL: llm.url, ...extraEnv } }),
      mcpServers: () => mcpServers,
      prewarmSessions,
      configActions,
      memoryOwner,
      memoryRequired: true,
      emit: (event) => {
        events.push(event)
        const requestId = event.requestId
        if (allow && event.type === 'permission' && typeof requestId === 'string') setImmediate(() => created.respondPermission(requestId, 'allow-once'))
      },
      ...options,
    })
    const start = created.start
    created.start = async input => {
      await memoryOwner.prepare()
      return start(input)
    }
    bridges.push(created)
    return created
  }
  /** The profile written again, as the app's next launch does. */
  const relaunch = writeProfile
  return { dir, dshHome, userData, workspace, llm, events, requests, bridge, defer, relaunch, profileDir: path.join(dshHome, 'profiles', DSH_PROFILE) }
}

/** On Windows what dsh started (an image worker, or a virus scanner looking at what it wrote) may hold the folder a while after it exits. */
const REMOVE_PATIENCE_MS = 15_000
const REMOVE_PAUSE_MS = 500

async function removeEventually(dir: string) {
  const deadline = Date.now() + REMOVE_PATIENCE_MS
  for (;;) {
    try {
      removeTree(dir)
      return
    } catch (err) {
      const code = objectOf(err)?.code
      if ((code !== 'EPERM' && code !== 'EBUSY') || Date.now() > deadline) throw err
      await new Promise((resolve) => setTimeout(resolve, REMOVE_PAUSE_MS))
    }
  }
}

/** The assistant's visible text, in order. */
export const replies = (events: readonly Event[]) => events.flatMap(event => {
  const update = objectOf(event.update)
  if (update?.sessionUpdate === 'agent_message_chunk') {
    const words = objectOf(update.content)?.text
    return typeof words === 'string' ? [words] : []
  }
  if (update?.sessionUpdate !== 'viva_stream' || update.kind !== 'settle' || !Array.isArray(update.blocks)) return []
  return update.blocks.flatMap(block => {
    const part = objectOf(block)
    return part?.type === 'text' && typeof part.text === 'string' ? [part.text] : []
  })
})

/** The background pass writes after a turn; wait for what it writes. */
export async function eventually<T>(read: () => T, { timeoutMs = 15_000, intervalMs = 100 } = {}): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = read()
    if (value || Date.now() > deadline) return value
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

/** Simulate a slow owner receipt without delaying ACP output, turn completion, or other RPCs. */
export function delayNativeOutputReceipts(t: TestContext, pid: () => number | null | undefined, delayMs: number) {
  const emit = ChildProcess.prototype.emit
  let count = 0
  t.mock.method(ChildProcess.prototype, 'emit', function (this: ChildProcess, event: string | symbol, ...args: unknown[]) {
    const frame = this.pid === pid() && event === 'message' ? ownerRpcFrame(args[0]) : null
    const method = frame?.kind === 'request' && frame.method === 'adapter' ? objectOf(frame.input)?.method : null
    if (method === 'finishNativeOutput') {
      count++
      setTimeout(() => Reflect.apply(emit, this, [event, ...args]), delayMs)
      return true
    }
    return Reflect.apply(emit, this, [event, ...args]) as boolean
  })
  return () => count
}

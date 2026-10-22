import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAcpBridge } from '../../src/main/acp-bridge.js'
import { installedDshVersion, PERSONA, resolvePlugins } from '../../src/main/app-plugins.js'
import { DSH_PROFILE } from '../../src/main/config.js'
import { ensureDshProfile } from '../../src/main/dsh-profile.js'
import { dshEnv, dshRuntime } from '../../src/main/dsh-runtime.js'
import { removeTree } from '../../src/main/remove-tree.js'
import { startFakeLlm } from './fake-llm.js'

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

/**
 * @param {import('node:test').TestContext} t
 * @param {{ memoryFile?: string, mcpServers?: object[], allow?: boolean, models?: (llm: object) => object, env?: Record<string, string>, configActions?: object }} [options]
 *   memoryFile: where the memory plugin's store goes; mcpServers: declared on every session;
 *   allow: answer every approval request with "allow once" (otherwise they stay pending);
 *   imagesDir: Viva's pictures folder (dsh-profile.js), given the temporary directory; permission: the level picked (viva-permission);
 *   models: the profile's model section (see dsh-profile.js), given the fake Messages endpoint; env: added to dsh's
 * Whatever the test opens in the directory (a database) is closed through `defer`, before the directory goes.
 */
export async function startHarness(t, { memoryFile, mcpServers = [], allow = false, models, env: extraEnv = {}, configActions = null, imagesDir, permission } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-harness-'))
  const dshHome = path.join(dir, 'dsh-home')
  const workspace = path.join(dir, 'workspace')
  fs.mkdirSync(workspace)
  const userData = path.join(dir, 'userData')
  const { plugins, problems } = resolvePlugins({ codeRoot: ROOT, userData, dshVersion: installedDshVersion(ROOT), permission })
  assert.deepEqual(problems, [], 'every app plugin passes the compatibility check')
  const file = memoryFile ?? path.join(userData, 'memory.db')
  const withFile = plugins.map((plugin) => (plugin.name === 'viva-memory' ? { ...plugin, config: { file } } : plugin))
  const llm = await startFakeLlm()
  ensureDshProfile({ dshHome, profile: DSH_PROFILE, plugins: withFile, persona: PERSONA, models: models?.(llm), imagesDir: imagesDir?.(dir) })
  const bridges = []
  const closers = []
  t.after(async () => {
    // dsh runs in the workspace and holds memory.db: on Windows neither can go until it has exited.
    try {
      await Promise.all(bridges.map((bridge) => bridge.dispose()))
      for (const close of [...closers].reverse()) close()
      await llm.close()
    } finally {
      await removeEventually(dir)
    }
  })
  const defer = (close) => { closers.push(close) }
  const events = []
  function bridge() {
    const created = createAcpBridge({
      dshBin: DSH_BIN,
      nodeBin: RUNTIME.nodeBin,
      cwd: workspace,
      env: dshEnv({ base: process.env, dshHome, runtime: RUNTIME, settings: { DEEPSEEK_API_KEY: 'test-fake-key', DEEPSEEK_BASE_URL: llm.url, ...extraEnv } }),
      mcpServers: () => mcpServers,
      configActions,
      emit: (event) => {
        events.push(event)
        if (allow && event.type === 'permission') setImmediate(() => created.respondPermission(event.requestId, 'allow-once'))
      },
    })
    bridges.push(created)
    return created
  }
  return { dir, dshHome, userData, workspace, file, llm, events, bridge, defer }
}

/** On Windows what dsh started (an image worker, or a virus scanner looking at what it wrote) may hold the folder a while after it exits. */
const REMOVE_PATIENCE_MS = 15_000
const REMOVE_PAUSE_MS = 500

async function removeEventually(dir) {
  const deadline = Date.now() + REMOVE_PATIENCE_MS
  for (;;) {
    try {
      removeTree(dir)
      return
    } catch (err) {
      if ((err.code !== 'EPERM' && err.code !== 'EBUSY') || Date.now() > deadline) throw err
      await new Promise((resolve) => setTimeout(resolve, REMOVE_PAUSE_MS))
    }
  }
}

/** The assistant's visible text, in order. */
export const replies = (events) => events
  .filter((e) => e.update?.sessionUpdate === 'agent_message_chunk')
  .map((e) => e.update.content.text)

/** The background pass writes after a turn; wait for what it writes. */
export async function eventually(read, { timeoutMs = 15_000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = read()
    if (value || Date.now() > deadline) return value
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

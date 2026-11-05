import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAcpBridge } from '../src/backend/acp-bridge.ts'
import { installedDshVersion, PERSONA, resolvePlugins } from '../src/backend/app-plugins.ts'
import { ensureDshProfile, vivaLayerFile } from '../src/backend/dsh-profile.ts'
import { dshEnv, dshRuntime } from '../src/backend/dsh-runtime.ts'
import { noteFor } from '../src/backend/task-reports.ts'
import { startFakeLlm } from './fixtures/fake-llm.js'

/**
 * A background task's result into the main conversation, on the real dsh with Viva's plugins (system-design §12.4):
 * steered into the running turn and confirmed read once written and flushed; lost when the turn stops before its
 * next step; and a turn of its own named by the note, confirmed the same way. Never sent twice.
 */

const SLOW = '慢一点回答'
const note = (reportId: string) => noteFor([{ taskId: reportId.split(':')[0], title: '整理发布说明', status: 'done', host: 'c1', output: '写好了', reportId }], { inTurn: true })
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))
type Event = { type: string, reportId?: string }

async function harness(t: TestContext) {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viva-steer-reports-'))
  const workspace = path.join(dir, 'workspace')
  fs.mkdirSync(workspace)
  // The slow question's first answer takes 3 s: time to steer into it, and to stop it, while it is out.
  const llm = await startFakeLlm({ decideFirst: (raw: object) => {
    const said = JSON.stringify((raw as { messages?: unknown[] }).messages)
    return said.includes(SLOW) && !said.includes('第一段回答') && !said.includes('回报编号') ? { text: '第一段回答', delayMs: 3000 } : null
  } })
  const dshHome = path.join(dir, 'dsh-home')
  const { plugins, problems } = resolvePlugins({ codeRoot: root, userData: path.join(dir, 'userData'), dshVersion: installedDshVersion(root) })
  assert.deepEqual(problems, [])
  const profile = 'viva-steer-reports-test'
  ensureDshProfile({ dshHome, profile, plugins, persona: PERSONA })
  const runtime = dshRuntime({ env: process.env, execPath: process.execPath })
  const events: Event[] = []
  const bridge = createAcpBridge({ dshBin: path.join(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), nodeBin: runtime.nodeBin, cwd: workspace, profile,
    overlay: vivaLayerFile(dshHome), prewarmSessions: false,
    env: dshEnv({ base: process.env, dshHome, runtime, settings: { DEEPSEEK_API_KEY: 'test-fake-key', DEEPSEEK_BASE_URL: llm.url } }),
    emit: (event: Event) => { events.push(event) },
  })
  t.after(async () => {
    await bridge.dispose()
    await llm.close()
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })
  await bridge.start()
  /** Waits until the plugin said this of a report. */
  async function heard(type: string, reportId: string, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (events.some((event) => event.type === type && event.reportId === reportId)) return true
      await sleep(50)
    }
    return false
  }
  /** How many of the model's requests carried the report. */
  const carrying = (reportId: string) => llm.requests.filter((request) => JSON.stringify(request).includes(`回报编号：${reportId}`)).length
  return { bridge, events, heard, carrying, llm }
}

test('real dsh: a report steered into the running turn is read once written and flushed, and never sent twice', { timeout: 90_000 }, async (t) => {
  const { bridge, heard, carrying } = await harness(t)
  const reportId = 'task-0001:run-1'
  assert.equal(await bridge.reportStatus(reportId), 'none')
  const turn = bridge.prompt(SLOW)
  await sleep(1000)
  assert.equal(await bridge.deliverReport(reportId, note(reportId)), 'steered')
  assert.equal(await bridge.deliverReport(reportId, note(reportId)), 'pending', 'asked again while it waits: not sent again')
  await turn
  assert.ok(await heard('report_read', reportId), 'read: written in the history and flushed')
  assert.equal(await bridge.reportStatus(reportId), 'read')
  assert.equal(await bridge.deliverReport(reportId, note(reportId)), 'read', 'there already: confirmed, not sent again')
  assert.ok(carrying(reportId) >= 1, 'the model was given it in that turn')
})

test('real dsh: a report steered in, then the turn stopped before its next step, is lost and said so', { timeout: 90_000 }, async (t) => {
  const { bridge, heard } = await harness(t)
  const reportId = 'task-0002:run-1'
  const turn = bridge.prompt(SLOW)
  await sleep(1000)
  assert.equal(await bridge.deliverReport(reportId, note(reportId)), 'steered')
  await bridge.cancel()
  await turn
  assert.ok(await heard('report_dropped', reportId), 'dropped: the app sends it again')
  assert.equal(await bridge.reportStatus(reportId), 'none')
})

test('real dsh: a turn of its own, named by its note, is read the same way; idle, steering gives way to it', { timeout: 90_000 }, async (t) => {
  const { bridge, heard } = await harness(t)
  const reportId = 'task-0003:run-1'
  assert.equal(await bridge.deliverReport(reportId, note(reportId)), 'idle', 'no turn running: the app opens one')
  await bridge.prompt(noteFor([{ taskId: 'task-0003', title: '核对发票', status: 'done', host: 'c1', output: '三张金额不符', reportId }]))
  assert.ok(await heard('report_read', reportId))
  assert.equal(await bridge.reportStatus(reportId), 'read')
})

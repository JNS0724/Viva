/** Real diagnostics controls do not travel through the business HTTP/effects queue. */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect } from '@playwright/test'
import { startFakeLlm } from '../test/fixtures/fake-llm.ts'
import { launchSmokeApplication, configureFakeProvider } from '../test/smoke/application.ts'
import { createOwnedProfile, disposeOwnedProfile } from '../test/smoke/owned-profile.ts'

if (process.platform !== 'darwin') throw new Error('This native pause check requires macOS; Windows needs its own process-pause fixture')
const root = await mkdtemp(path.join(tmpdir(), 'viva-diagnostic-controls-'))
const output = path.resolve('smoke/l1c-controls')
await mkdir(output, { recursive: true })
const profile = createOwnedProfile(root, 'controls')
const model = await startFakeLlm()
const running = await launchSmokeApplication({ profile, outputDirectory: path.join(output, 'application'), model, bridge: 'real' })
const diagnostics = path.join(profile.userData, 'diagnostics')
const records = async () => (await Promise.all((await readdir(diagnostics)).filter(file => file.endsWith('.jsonl')).map(file => readFile(path.join(diagnostics, file), 'utf8'))))
  .join('').trim().split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line) as Record<string, unknown>] } catch { return [] } })
let stopped: number | undefined
try {
  await configureFakeProvider(running, model)
  await expect.poll(() => running.page.evaluate(async () => {
    try { return Boolean((await window.agent.getMemory()).profile) } catch { return false }
  }), { timeout: 15_000 }).toBe(true)
  const before = JSON.parse(await readFile(path.join(diagnostics, 'identity.json'), 'utf8')) as { runId: string, salt: string }
  const backend = await running.hooks.backendPid(), owner = await running.hooks.agentPid()
  assert.ok(backend && owner)
  await running.page.evaluate(async () => {
    await window.agent.debugDiagnostics(true)
    window.agent.reportDiagnostic({ event: 'state.changed', operation: 'diagnostics', debug: true })
  })
  await expect.poll(async () => (await records()).some(record => record.component === 'renderer' && record.level === 20)).toBe(true)
  process.kill(backend, 'SIGSTOP'); stopped = backend
  await expect.poll(async () => (await records()).some(record => record.component === 'shell' && record.event === 'health' && record.reason === 'timeout'), { timeout: 22_000 }).toBe(true)
  const first = await running.page.evaluate(async () => {
    const started = performance.now(), result = await window.agent.clearDiagnostics()
    return { result, milliseconds: performance.now() - started }
  })
  assert.equal(first.result.status, 'cleanup_pending')
  assert.ok(first.milliseconds < 3_500)
  assert.equal((JSON.parse(await readFile(path.join(diagnostics, 'identity.json'), 'utf8')) as { runId: string }).runId, before.runId,
    'salt/run rotation waits for actual close acknowledgments')
  process.kill(backend, 'SIGCONT'); stopped = undefined
  await expect.poll(() => running.page.evaluate(async () => (await window.agent.clearDiagnostics()).status), { timeout: 15_000 }).toBe('cleared')
  const after = JSON.parse(await readFile(path.join(diagnostics, 'identity.json'), 'utf8')) as { runId: string, salt: string }
  assert.notEqual(after.runId, before.runId); assert.notEqual(after.salt, before.salt)
  assert.equal(await running.hooks.backendPid(), backend); assert.equal(await running.hooks.agentPid(), owner)
  assert.ok((await running.page.evaluate(() => window.agent.getMemory())).profile)
  await running.page.screenshot({ path: path.join(output, 'after-clear.png') })
  const result = { supervisedBackendSilence: true, debugMetadataWritten: true, first, resumedClear: true, saltRotated: true,
    backendAndOwnerUnchanged: true, memoryGetAfterClear: true, localModelRequests: model.requests.length }
  await writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result))
} finally {
  if (stopped) { try { process.kill(stopped, 'SIGCONT') } catch { /* Owned process already exited. */ } }
  await running.close(); await model.close(); disposeOwnedProfile(profile)
  await rm(root, { recursive: true, force: true })
}

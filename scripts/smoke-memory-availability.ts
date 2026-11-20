/** A stalled owner respects foreground deadlines and is replaced without restarting dsh. */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect } from '@playwright/test'
import { startFakeLlm } from '../test/fixtures/fake-llm.ts'
import { launchSmokeApplication, configureFakeProvider } from '../test/smoke/application.ts'
import { createOwnedProfile, disposeOwnedProfile } from '../test/smoke/owned-profile.ts'
import { pauseOwnedProcess } from '../test/fixtures/diagnostics-process-pause.ts'
import type { PausedProcess } from '../test/fixtures/diagnostics-process-pause.ts'

const root = await mkdtemp(path.join(tmpdir(), 'viva-memory-availability-'))
const output = path.resolve('smoke/l1b-availability')
await mkdir(output, { recursive: true })
const profile = createOwnedProfile(root, 'availability')
await writeFile(path.join(profile.userData, 'preferences.json'), JSON.stringify({ language: 'zh-CN' }))
const model = await startFakeLlm()
const running = await launchSmokeApplication({ profile, outputDirectory: path.join(output, 'application'), model, bridge: 'real' })
let stopped: PausedProcess | undefined
let retired = false
try {
  await configureFakeProvider(running, model)
  await expect.poll(() => running.page.evaluate(async () => {
    try { return Boolean((await window.agent.getMemory()).profile) } catch { return false }
  }), { timeout: 15_000 }).toBe(true)
  const owner = await running.hooks.memoryOwnerPid(), dsh = await running.hooks.agentPid()
  assert.ok(owner && dsh && owner !== dsh)
  stopped = await pauseOwnedProcess(owner)
  const first = running.page.evaluate(async () => {
    const started = performance.now()
    try { await window.agent.getMemory(); return { ok: true, milliseconds: performance.now() - started, error: '' } }
    catch (error) { return { ok: false, milliseconds: performance.now() - started, error: String(error) } }
  })
  await running.page.locator('#composer-input').fill('故障期间保留的草稿')
  const file = path.join(profile.workspace, 'retained-attachment.txt')
  await writeFile(file, 'synthetic attachment')
  await running.page.evaluate(async file => {
    const draft = await window.agent.getDraft()
    await window.agent.appendDraftFiles(draft.key, [file])
  }, file)
  await expect(running.page.locator('.composer-shared-files')).toContainText('retained-attachment.txt')
  // UI navigation must remain responsive while the first owner request has no response.
  await running.page.locator('#open-profile').click()
  await running.page.locator('.hub-nav[data-page="settings"]').click()
  await expect(running.page.locator('#settings-root')).toBeVisible()
  await running.page.locator('#hub-back').click()
  await expect(running.page.locator('#composer-input')).toHaveValue('故障期间保留的草稿')
  await expect(running.page.locator('.composer-shared-files')).toContainText('retained-attachment.txt')
  const firstResult = await first
  assert.equal(firstResult.ok, false)
  assert.match(firstResult.error, /超时|恢复|不可用|timed out|unavailable/i)
  assert.ok(firstResult.milliseconds < 13_000)
  await writeFile(path.join(output, 'result.json'), JSON.stringify({ firstResult, recovered: false }, null, 2))
  await running.page.locator('#open-profile').click()
  await running.page.locator('.hub-nav[data-page="profile"]').click()
  await expect.poll(async () => {
    const current = await running.hooks.memoryOwnerPid()
    if (current !== owner) return true
    return running.page.evaluate(() => window.agent.getMemory({ budgetMs: 250 })
      .then(() => false, error => /恢复|不可用|unavailable/i.test(String(error))))
  }, { timeout: 15_000 }).toBe(true)
  // Release the debugger after the supervisor has fenced the old process so
  // Windows can finish reporting its exit. The replacement must still appear.
  retired = true
  await stopped.resume().catch(() => {})
  stopped = undefined
  await expect.poll(async () => {
    const replacement = await running.hooks.memoryOwnerPid()
    return Boolean(replacement && replacement !== owner)
  }, { timeout: 15_000 }).toBe(true)
  await expect.poll(() => running.page.evaluate(() => window.agent.getMemory().then(memory => !!memory.profile, () => false)),
    { timeout: 10_000 }).toBe(true)
  assert.equal(await running.hooks.agentPid(), dsh)
  const retry = running.page.locator('#profile-root .form-error').getByRole('button', { name: /重新加载|Reload/, exact: true })
  if (await retry.isVisible()) await retry.click()
  await expect(running.page.locator('#profile-root .form-error')).toHaveCount(0)
  await running.page.locator('#hub-back').click()
  await expect(running.page.locator('#composer-input')).toHaveValue('故障期间保留的草稿')
  await running.page.screenshot({ path: path.join(output, 'recovered.png') })
  const result = { platform: process.platform, firstResult, recovered: true, dshRetained: true, draftRetained: true, attachmentRetained: true }
  await writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result))
} finally {
  try { await stopped?.resume().catch(error => { if (!retired) throw error }) }
  finally {
    try { await running.close() }
    finally { await model.close(); disposeOwnedProfile(profile); await rm(root, { recursive: true, force: true }) }
  }
}

/** Real owner suspension: two ten-second caller deadlines, bounded execution and a fresh successful retry. */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect } from '@playwright/test'
import { startFakeLlm } from '../test/fixtures/fake-llm.ts'
import { launchSmokeApplication, configureFakeProvider } from '../test/smoke/application.ts'
import { createOwnedProfile, disposeOwnedProfile } from '../test/smoke/owned-profile.ts'

if (process.platform !== 'darwin') throw new Error('This owner suspension check uses macOS SIGSTOP')
const root = await mkdtemp(path.join(tmpdir(), 'viva-memory-availability-'))
const output = path.resolve('smoke/l1b-availability')
await mkdir(output, { recursive: true })
const profile = createOwnedProfile(root, 'availability')
await writeFile(path.join(profile.userData, 'preferences.json'), JSON.stringify({ language: 'zh-CN' }))
const model = await startFakeLlm()
const running = await launchSmokeApplication({ profile, outputDirectory: path.join(output, 'application'), model, bridge: 'real' })
let stopped: number | undefined
try {
  await configureFakeProvider(running, model)
  await expect.poll(() => running.page.evaluate(async () => {
    try { return Boolean((await window.agent.getMemory()).profile) } catch { return false }
  }), { timeout: 15_000 }).toBe(true)
  const owner = await running.hooks.agentPid()
  assert.ok(owner && owner > 0)
  process.kill(owner, 'SIGSTOP'); stopped = owner
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
  assert.match(firstResult.error, /超时|timed out/)
  assert.ok(firstResult.milliseconds >= 9_000 && firstResult.milliseconds < 13_000)
  const secondResult = await running.page.evaluate(async () => {
    const started = performance.now()
    try { await window.agent.getMemory(); return { ok: true, milliseconds: performance.now() - started, error: '' } }
    catch (error) { return { ok: false, milliseconds: performance.now() - started, error: String(error) } }
  })
  assert.equal(secondResult.ok, false); assert.match(secondResult.error, /超时|timed out/)
  const busy = await running.page.evaluate(async () => {
    const started = performance.now()
    try { await window.agent.getMemory(); return { error: '', milliseconds: performance.now() - started } }
    catch (error) { return { error: String(error), milliseconds: performance.now() - started } }
  })
  assert.match(busy.error, /两个|busy/); assert.ok(busy.milliseconds < 2_000)
  await writeFile(path.join(output, 'result.json'), JSON.stringify({ firstResult, secondResult, busy, recovered: false }, null, 2))
  await running.page.locator('#open-profile').click()
  await running.page.locator('.hub-nav[data-page="profile"]').click()
  await expect(running.page.locator('#profile-root .form-error')).toContainText(/两个|busy/)
  await running.page.locator('#profile-root').getByRole('button', { name: /重新加载|Reload/, exact: true }).click()
  await expect(running.page.locator('#profile-root .form-error')).toContainText(/两个|busy/)
  await running.page.screenshot({ path: path.join(output, 'owner-busy.png') })
  process.kill(owner, 'SIGCONT'); stopped = undefined
  await expect.poll(() => running.page.evaluate(async () => {
    try { return Boolean((await window.agent.getMemory()).profile) } catch { return false }
  }), { timeout: 10_000 }).toBe(true)
  // A read terminal need not change owner readiness. Retry the page explicitly if it has not refreshed itself.
  await running.page.locator('#profile-root').getByRole('button', { name: /重新加载|Reload/, exact: true })
    .evaluateAll(buttons => { (buttons[0] as HTMLButtonElement | undefined)?.click() })
  await expect(running.page.locator('#profile-root .form-error')).toHaveCount(0)
  await running.page.locator('#hub-back').click()
  await expect(running.page.locator('#composer-input')).toHaveValue('故障期间保留的草稿')
  await running.page.screenshot({ path: path.join(output, 'recovered.png') })
  const result = { firstResult, secondResult, busy, recovered: true, manualRetryExposed: true, draftRetained: true, attachmentRetained: true }
  await writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result))
} finally {
  if (stopped) { try { process.kill(stopped, 'SIGCONT') } catch { /* Already exited. */ } }
  await running.close(); await model.close(); disposeOwnedProfile(profile)
  await rm(root, { recursive: true, force: true })
}

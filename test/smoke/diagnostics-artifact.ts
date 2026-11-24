import assert from 'node:assert/strict'
import { mkdir, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { expect } from '@playwright/test'
import { DIAGNOSTIC_LIMITS } from '../../src/diagnostics/contracts.ts'
import type { SmokeApplication } from './application.ts'

/** Exercise the installed child's exporter and its packaged dependencies, not repository resolution. */
export async function installedDiagnostics(app: SmokeApplication, output: string, forbiddenTexts: readonly string[]): Promise<void> {
  await mkdir(output, { recursive: true })
  const destination = path.join(output, 'diagnostics.zip')
  const directory = path.join(app.hooks.userData, 'diagnostics')
  const canary = 'SECRET_INSTALLED_DIAGNOSTIC_RESOURCE'
  const count = 24117
  const backend = await app.hooks.backendPid(), owner = await app.hooks.agentPid()
  assert.ok(backend && owner, 'the installed check must use actual backend and owner processes')
  await expect.poll(() => app.page.evaluate(async () => (await window.agent.diagnosticsStatus()).state)).toBe('ready')
  await app.page.evaluate(async ({ canary, count }) => {
    await window.agent.debugDiagnostics(true)
    window.agent.reportDiagnostic({ event: 'state.changed', operation: 'diagnostics', debug: true,
      identities: { resourceId: canary }, metrics: { count } })
  }, { canary, count })
  await expect.poll(async () => {
    const files = (await readdir(directory)).filter(file => /^renderer-[a-f0-9-]+\.jsonl$/.test(file))
    return (await Promise.all(files.map(file => readFile(path.join(directory, file), 'utf8'))))
      .some(text => text.includes(`"count":${count}`) && text.includes('"level":20'))
  }, { timeout: 10_000, message: 'the installed Renderer must persist the debug metadata before export' }).toBe(true)
  await app.application.evaluate(({ dialog }, destination) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: destination })
    dialog.showErrorBox = () => {} // Assert the returned failure instead of leaving a native modal open in CI.
  }, destination)
  expect((await app.page.evaluate(() => window.agent.exportDiagnostics())).status).toBe('saved')
  const archive = await readFile(destination)
  assert.equal(archive.readUInt32LE(), 0x04034b50)
  assert.ok(archive.length <= DIAGNOSTIC_LIMITS.exportOutputBytes)
  assert.ok(archive.includes(Buffer.from('manifest.json')))
  assert.ok(archive.includes(Buffer.from(`"count":${count}`)), 'the packaged exporter must include the observed metadata')
  const expectedBuildCommit = process.env.GITHUB_SHA
  if (expectedBuildCommit) {
    assert.match(expectedBuildCommit, /^[a-f0-9]{40}$/)
    assert.ok(archive.includes(Buffer.from(`"buildCommit":"${expectedBuildCommit}"`)), 'installed logs must identify the CI source revision')
  }
  for (const text of [canary, app.hooks.userData, JSON.stringify(app.hooks.userData).slice(1, -1), ...forbiddenTexts]) {
    assert.ok(!archive.includes(Buffer.from(text)), 'body, identity or local path escaped the installed privacy boundary')
  }
  await expect.poll(() => app.page.evaluate(async () => (await window.agent.clearDiagnostics()).status),
    { timeout: 15_000, message: 'the installed writers and exporter must actually settle before clear succeeds' }).toBe('cleared')
  expect((await app.page.evaluate(() => window.agent.diagnosticsStatus())).debugRemainingMs).toBe(0)
  assert.deepEqual(await readFile(destination), archive, 'clearing local logs cannot rewrite the already exported ZIP')
  assert.equal(await app.hooks.backendPid(), backend)
  assert.equal(await app.hooks.agentPid(), owner)
  assert.equal(typeof (await app.page.evaluate(() => window.agent.getMemory())).revision, 'number')
}

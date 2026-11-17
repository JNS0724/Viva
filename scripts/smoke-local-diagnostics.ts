/** Native export must remain usable with both the business process and Renderer suspended. */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect } from '@playwright/test'
import { launchSmokeApplication } from '../test/smoke/application.ts'
import { createOwnedProfile, disposeOwnedProfile } from '../test/smoke/owned-profile.ts'

if (process.platform !== 'darwin') throw new Error('This fault injection uses macOS SIGSTOP; Windows acceptance is a separate L1c check')
const directory = await mkdtemp(path.join(tmpdir(), 'viva-native-diagnostics-'))
const profile = createOwnedProfile(directory, 'diagnostics')
const running = await launchSmokeApplication({ profile, outputDirectory: path.join(directory, 'artifacts'), model: null, bridge: 'fake' })
const stopped: number[] = []
try {
  const destination = path.join(directory, 'diagnostics.zip')
  const backend = await running.hooks.backendPid()
  assert.ok(backend && backend > 0)
  process.kill(backend, 'SIGSTOP'); stopped.push(backend)
  // Start a real memory read, then make the Renderer unable to service any callback.
  await running.page.evaluate(() => { void window.agent.getMemory().catch(() => {}) })
  // Observe the asynchronous local batch before fixing the export cutoffs; do not wait on memory:get.
  await expect.poll(async () => {
    const directory = path.join(profile.userData, 'diagnostics')
    const files = (await readdir(directory)).filter(file => /^renderer-[a-f0-9-]+\.jsonl$/.test(file))
    return (await Promise.all(files.map(file => readFile(path.join(directory, file), 'utf8')))).some(text => text.includes('"operation":"memory.get"'))
  }, { timeout: 5000 }).toBe(true)
  const renderer = await running.application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/src/renderer/index.html'))!.webContents.getOSProcessId())
  process.kill(renderer, 'SIGSTOP'); stopped.push(renderer)
  await running.application.evaluate(({ dialog, Menu }, destination) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: destination })
    const item = Menu.getApplicationMenu()?.getMenuItemById('viva-diagnostics-export')
    if (!item) throw new Error('Native diagnostic export menu is missing')
    item.click(item, undefined, {})
  }, destination)
  await expect.poll(() => stat(destination).then(info => info.size, () => 0), { timeout: 15_000 }).toBeGreaterThan(0)
  const archive = await readFile(destination)
  assert.equal(archive.readUInt32LE(), 0x04034b50)
  assert.ok(archive.includes(Buffer.from('manifest.json')))
  assert.ok(archive.includes(Buffer.from('"component":"renderer"')), 'the preload diagnostic bridge must produce Renderer records')
  assert.ok(!archive.includes(Buffer.from(profile.userData)), 'local paths must not enter the archive')
  console.log(JSON.stringify({ nativeExportWithBackendAndRendererStopped: true, archiveBytes: archive.length }))
} finally {
  for (const pid of stopped.reverse()) { try { process.kill(pid, 'SIGCONT') } catch { /* Already exited. */ } }
  await running.close()
  disposeOwnedProfile(profile)
  await rm(directory, { recursive: true, force: true })
}

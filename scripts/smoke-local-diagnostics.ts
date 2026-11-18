/** Native export must remain usable with both the business process and Renderer suspended. */
import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect } from '@playwright/test'
import type { Menu as NativeMenu } from 'electron'
import { launchSmokeApplication } from '../test/smoke/application.ts'
import { createOwnedProfile, disposeOwnedProfile } from '../test/smoke/owned-profile.ts'
import { pauseOwnedProcess } from '../test/fixtures/diagnostics-process-pause.ts'
import type { PausedProcess } from '../test/fixtures/diagnostics-process-pause.ts'

const directory = await mkdtemp(path.join(tmpdir(), 'viva-native-diagnostics-'))
const output = path.resolve('smoke/l1c-export')
await mkdir(output, { recursive: true })
const profile = createOwnedProfile(directory, 'diagnostics')
const running = await launchSmokeApplication({ profile, outputDirectory: path.join(output, 'application'), model: null, bridge: 'fake' })
const stopped: PausedProcess[] = []
try {
  if (process.platform === 'win32') {
    // Observe the actual tray's public menu assignment, then refresh it through the existing language
    // control. No production automation API or replacement diagnostic menu is introduced.
    await running.application.evaluate(({ Tray }) => {
      const scope = globalThis as typeof globalThis & { vivaSmokeDiagnosticMenu?: NativeMenu }
      const original = Tray.prototype.setContextMenu
      Tray.prototype.setContextMenu = function(menu) {
        if (menu?.getMenuItemById('viva-diagnostics-export')) {
          scope.vivaSmokeDiagnosticMenu = menu
          Tray.prototype.setContextMenu = original
        }
        return original.call(this, menu)
      }
    })
    await running.page.evaluate(async () => { await window.agent.setLanguage((await window.agent.getLanguage()).language) })
    assert.equal(await running.application.evaluate(() => Boolean((globalThis as typeof globalThis & { vivaSmokeDiagnosticMenu?: NativeMenu })
      .vivaSmokeDiagnosticMenu?.getMenuItemById('viva-diagnostics-export'))), true)
  }
  const destination = path.join(directory, 'diagnostics.zip')
  const backend = await running.hooks.backendPid()
  assert.ok(backend && backend > 0)
  stopped.push(await pauseOwnedProcess(backend))
  // Start a real memory read, then make the Renderer unable to service any callback.
  await running.page.evaluate(() => { void window.agent.getMemory().catch(() => {}) })
  // Observe the asynchronous local batch before fixing the export cutoffs; do not wait on memory:get.
  await expect.poll(async () => {
    const directory = path.join(profile.userData, 'diagnostics')
    const files = (await readdir(directory)).filter(file => /^renderer-[a-f0-9-]+\.jsonl$/.test(file))
    return (await Promise.all(files.map(file => readFile(path.join(directory, file), 'utf8')))).some(text => text.includes('"operation":"memory.get"'))
  }, { timeout: 5000 }).toBe(true)
  const renderer = await running.application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/src/renderer/index.html'))!.webContents.getOSProcessId())
  stopped.push(await pauseOwnedProcess(renderer))
  await running.application.evaluate(({ dialog, Menu }, destination) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: destination })
    const menu = process.platform === 'win32' ? (globalThis as typeof globalThis & { vivaSmokeDiagnosticMenu?: NativeMenu }).vivaSmokeDiagnosticMenu : Menu.getApplicationMenu()
    const item = menu?.getMenuItemById('viva-diagnostics-export')
    if (!item) throw new Error('Native diagnostic export menu is missing')
    item.click(item, undefined, {})
  }, destination)
  await expect.poll(() => stat(destination).then(info => info.size, () => 0), { timeout: 15_000 }).toBeGreaterThan(0)
  const archive = await readFile(destination)
  assert.equal(archive.readUInt32LE(), 0x04034b50)
  assert.ok(archive.includes(Buffer.from('manifest.json')))
  assert.ok(archive.includes(Buffer.from('"component":"renderer"')), 'the preload diagnostic bridge must produce Renderer records')
  assert.ok(!archive.includes(Buffer.from(profile.userData)), 'local paths must not enter the archive')
  const result = { platform: process.platform, nativeExportWithBackendAndRendererStopped: true, archiveBytes: archive.length }
  await copyFile(destination, path.join(output, 'diagnostics.zip'))
  await writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result))
} finally {
  try { for (const suspension of stopped.reverse()) await suspension.resume() }
  finally {
    try { await running.close() }
    finally { disposeOwnedProfile(profile); await rm(directory, { recursive: true, force: true }) }
  }
}

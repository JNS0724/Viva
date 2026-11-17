/** Local settings controls use the real Shell and preserve the user's typed key across redraws. */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect } from '@playwright/test'
import { launchSmokeApplication } from '../test/smoke/application.ts'
import { createOwnedProfile, disposeOwnedProfile } from '../test/smoke/owned-profile.ts'

const root = await mkdtemp(path.join(tmpdir(), 'viva-diagnostic-settings-'))
const output = path.resolve('smoke/l3-settings')
await mkdir(output, { recursive: true })
const profile = createOwnedProfile(root, 'settings')
await writeFile(path.join(profile.userData, 'preferences.json'), JSON.stringify({ language: 'zh-CN' }))
const running = await launchSmokeApplication({ profile, outputDirectory: path.join(output, 'application'), model: null, bridge: 'fake' })
try {
  if (!await running.page.locator('#settings-root').isVisible()) {
    await running.page.locator('#open-profile').click()
    await running.page.locator('.hub-nav[data-page="settings"]').click()
  }
  const section = running.page.locator('[data-diagnostics]')
  await expect(section).toBeVisible()
  await expect(section).toContainText('日志：正常')
  const key = running.page.locator('#settings-key')
  await key.fill('SECRET_UNSAVED_SETTINGS_KEY')
  await section.getByRole('button', { name: '刷新状态', exact: true }).click()
  await expect(key).toHaveValue('SECRET_UNSAVED_SETTINGS_KEY')
  await section.screenshot({ path: path.join(output, 'diagnostics-wide.png') })
  await running.application.evaluate(({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/src/renderer/index.html'))
    if (!main) throw new Error('Main window unavailable')
    main.setContentSize(880, 600)
  })
  await section.scrollIntoViewIfNeeded()
  await expect.poll(() => section.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  await section.screenshot({ path: path.join(output, 'diagnostics-narrow.png') })
  const debug = section.locator('[name="diagnostics-debug"]')
  await debug.check()
  await expect(debug).toBeChecked()
  const destination = path.join(root, 'diagnostics.zip')
  await running.application.evaluate(({ dialog }, destination) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: destination }) }, destination)
  await section.getByRole('button', { name: '导出诊断包…', exact: true }).click()
  await expect(section).toContainText('诊断包已保存到本机')
  const archive = await readFile(destination)
  assert.equal(archive.readUInt32LE(), 0x04034b50)
  assert.equal(archive.includes(Buffer.from('SECRET_UNSAVED_SETTINGS_KEY')), false)
  assert.equal(archive.includes(Buffer.from(profile.userData)), false)
  await section.getByRole('button', { name: '清空本地诊断日志', exact: true }).click()
  await expect(section).toContainText('本地诊断日志已清空')
  assert.equal((await running.page.evaluate(() => window.agent.diagnosticsStatus())).debugRemainingMs, 0)
  await expect(debug).not.toBeChecked()
  await expect(key).toHaveValue('SECRET_UNSAVED_SETTINGS_KEY')
  await section.screenshot({ path: path.join(output, 'diagnostics-cleared.png') })
  console.log(JSON.stringify({ platform: process.platform, settingsControls: true, narrowWindow: true,
    debugEnabled: true, exported: true, cleared: true, unsavedInputPreserved: true, noSecretOrPathInArchive: true }))
} finally {
  await running.close(); disposeOwnedProfile(profile)
  await rm(root, { recursive: true, force: true })
}

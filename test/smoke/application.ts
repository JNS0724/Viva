import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { _electron, expect, type ElectronApplication, type Page } from '@playwright/test'
import { inspectArtifact } from './artifact.ts'
import { assertOwnedProfile, type OwnedProfile } from './owned-profile.ts'
import { electronWindow } from './electron-window.ts'
import { smokeHooks } from './hooks.ts'
import { applicationEnvironment } from './environment.ts'
import type { SmokeAppWindow, SmokeHooks, SmokeModel } from './smoke-kit.ts'

export const PROJECT_ROOT = path.resolve(import.meta.dirname, '..', '..')
const LAUNCH_TIMEOUT_MS = 30_000
const CLOSE_TIMEOUT_MS = 15_000
const require = createRequire(import.meta.url)

export interface ApplicationOptions {
  profile: OwnedProfile
  outputDirectory: string
  model: SmokeModel | null
  bridge: 'real' | 'fake'
  executable?: string
  apiKey?: string
  fullAccessibility?: boolean
  waitForAgent?: boolean
}

export interface SmokeApplication {
  application: ElectronApplication
  page: Page
  window: SmokeAppWindow
  hooks: SmokeHooks
  close: () => Promise<void>
}

async function bounded<T>(work: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Application cleanup exceeded ${milliseconds}ms`)), milliseconds)
      timer.unref()
    })])
  } finally { clearTimeout(timer) }
}

/** Fallback is a failure, never a passing teardown; verify a unique owned profile before terminating a PID. */
function terminateOwnedApplication(application: ElectronApplication, profile: OwnedProfile): void {
  const child = application.process(), pid = child.pid
  if (child.exitCode !== null || child.signalCode !== null) return
  if (!pid || !Number.isSafeInteger(pid)) throw new Error('Application has no owned PID')
  if (process.platform === 'win32') {
    const raw = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress`], { encoding: 'utf8', windowsHide: true, timeout: 5_000 }).replace(/^\uFEFF/, '').trim()
    if (!raw) return
    const processInfo = JSON.parse(raw) as { ProcessId: number, CommandLine: string }
    if (processInfo.ProcessId !== pid || !processInfo.CommandLine.includes(profile.userData) || !processInfo.CommandLine.includes('--enable-smoke-test-driver')) throw new Error('Refuse to terminate an unverified process')
    execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5_000 })
  } else {
    const command = execFileSync('ps', ['-ww', '-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 5_000 })
    if (!command.includes(profile.userData) || !command.includes('--enable-smoke-test-driver')) throw new Error('Refuse to terminate an unverified process')
    const group = Number(execFileSync('ps', ['-p', String(pid), '-o', 'pgid='], { encoding: 'utf8', timeout: 5_000 }).trim())
    process.kill(group === pid ? -pid : pid, 'SIGKILL')
  }
}

/** The runner owns process lifetime, credentials, logs and profiles; the application only exposes its driver. */
export async function launchSmokeApplication(options: ApplicationOptions): Promise<SmokeApplication> {
  assertOwnedProfile(options.profile)
  const output = path.resolve(options.outputDirectory)
  fs.mkdirSync(output, { recursive: true })
  const artifactPath = options.executable || process.env.VIVA_SMOKE_EXECUTABLE
  const artifact = artifactPath ? inspectArtifact(artifactPath) : null
  const executable = artifact?.executable || process.env.VIVA_SMOKE_ELECTRON || require('electron') as string
  const args = [
    ...(!artifact ? [PROJECT_ROOT] : []), '--enable-smoke-test-driver',
    `--user-data-dir=${options.profile.userData}`, '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
    ...(options.fullAccessibility ? ['--force-renderer-accessibility'] : []),
  ]
  const importHome = path.join(options.profile.root, 'dsh-import')
  const env = applicationEnvironment(process.env, { workspace: options.profile.workspace, projectRoot: PROJECT_ROOT, bridge: options.bridge, apiKey: options.apiKey, importHome })
  const redact = (message: string) => options.apiKey ? message.replaceAll(options.apiKey, '[REDACTED]') : message
  const receipt = { executable, args, profile: options.profile.userData, bridge: options.bridge, artifact, waitForAgent: options.waitForAgent ?? false, startedAt: new Date().toISOString() }
  fs.writeFileSync(path.join(output, 'launch.json'), JSON.stringify(receipt, null, 2))
  const application = await _electron.launch({ executablePath: executable, args, env, cwd: options.profile.workspace, timeout: LAUNCH_TIMEOUT_MS })
  const log = (kind: string, text: string) => fs.appendFileSync(path.join(output, 'application.log'), `[${kind}] ${redact(text).slice(0, 64_000)}\n`)
  application.process().stdout?.on('data', data => log('stdout', String(data)))
  application.process().stderr?.on('data', data => log('stderr', String(data)))
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    try { await bounded(application.close(), CLOSE_TIMEOUT_MS) }
    catch (error) {
      terminateOwnedApplication(application, options.profile)
      throw error
    }
  }
  try {
    await application.context().route(/https:\/\/fonts\.googleapis\.com\//, route => route.fulfill({ status: 200, contentType: 'text/css', body: '/* offline automation fixture */' }))
    const page = await application.firstWindow({ timeout: LAUNCH_TIMEOUT_MS })
    page.setDefaultTimeout(15_000)
    await page.waitForURL(/\/src\/renderer\/index\.html$/, { timeout: LAUNCH_TIMEOUT_MS })
    await page.waitForFunction(() => document.documentElement.dataset.languageLoading !== 'true' && Boolean(document.getElementById('composer-input')))
    // waitForFunction treats an async predicate's Promise as truthy in this Playwright version.
    // Poll the resolved IPC result in the runner instead.
    if (options.waitForAgent) await expect.poll(() => page.evaluate(async () => {
      const info = await window.agent.getInfo()
      return info.mode === 'live' && Boolean(info.sessionId) && !document.querySelector<HTMLTextAreaElement>('#composer-input')?.disabled
    }), { timeout: LAUNCH_TIMEOUT_MS, message: 'Agent session is ready' }).toBe(true)
    await page.waitForFunction(() => document.fonts.status === 'loaded')
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    const profile = await application.evaluate(({ app }) => app.getPath('userData'))
    if (path.resolve(profile) !== path.resolve(options.profile.userData)) throw new Error('Application did not use its owned profile')
    await application.evaluate(({ powerSaveBlocker }) => { powerSaveBlocker.start('prevent-app-suspension') })
    if (!await application.evaluate(() => Boolean(globalThis.vivaAutomation))) throw new Error('Application automation driver was not enabled')
    page.on('console', message => log(`renderer:${message.type()}`, message.text()))
    page.on('pageerror', error => log('renderer:error', error.stack || error.message))
    const appWindow = await electronWindow(application, page)
    fs.writeFileSync(path.join(output, 'ready.json'), JSON.stringify(await page.evaluate(async () => ({ at: new Date().toISOString(), info: await window.agent.getInfo() })), null, 2))
    const hooks = smokeHooks({ application, page, userData: options.profile.userData, importHome, cwd: options.profile.workspace, fixtures: path.join(PROJECT_ROOT, 'test', 'fixtures'), model: options.model })
    return { application, page, window: appWindow, hooks, close }
  } catch (error) {
    log('launch:error', error instanceof Error ? error.stack || error.message : String(error))
    await close()
    throw error
  }
}

/** Configure the ordinary model-provider UI; production dsh never receives a test-only endpoint override. */
export async function configureFakeProvider(session: SmokeApplication, model: SmokeModel): Promise<void> {
  const { page } = session
  await page.locator('#open-profile').click()
  await page.locator('.hub-nav[data-page="settings"]').click()
  await page.locator('#add-model').click()
  await page.locator('[name="model-name"]').fill('Smoke primary')
  await page.locator('[name="model-api"]').selectOption('anthropic-messages')
  await page.locator('[name="model-url"]').fill(model.url)
  await page.locator('[name="model-ids"]').fill('deepseek-chat')
  await page.locator('[name="model-key"]').fill('smoke-fake-key')
  await page.locator('form').filter({ has: page.locator('[name="model-name"]') }).locator('button[type="submit"]').click()
  await expect.poll(() => page.evaluate(async () => {
    const info = await window.agent.getInfo()
    return info.mode === 'live' && Boolean(info.sessionId)
  }), { timeout: LAUNCH_TIMEOUT_MS, message: 'Provider configuration connected the agent' }).toBe(true)
  await page.locator('#hub-back').click()
}

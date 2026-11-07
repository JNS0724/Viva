import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { TestInfo } from '@playwright/test'
import { Scenario } from './smoke/fixtures.ts'
import { disposeOwnedProfile } from './smoke/owned-profile.ts'
import type { SmokeApplication } from './smoke/application.ts'
import { runSmoke } from './smoke/smoke.ts'
import type { SmokeAppWindow, SmokeHooks } from './smoke/smoke-kit.ts'

test('the prepared application is consumed once and the next explicit start takes the restart path', async t => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'viva-smoke-fixture-'))
  // Only project identity and owned output paths are used by this lifecycle test.
  const info = { project: { name: 'integration' }, outputPath: (...segments: string[]) => path.join(output, ...segments) } as TestInfo
  const scenario = new Scenario(info, { phase: 'memory', bridge: 'real' })
  t.after(() => { disposeOwnedProfile(scenario.profile); fs.rmSync(output, { recursive: true }) })
  const session = { close: async () => {} } as SmokeApplication
  scenario.current = session
  Reflect.set(scenario, 'prepared', true)
  assert.equal(await scenario.start('memory'), session)
  assert.equal(Reflect.get(scenario, 'prepared'), false)
  assert.equal(fs.existsSync(path.join(output, '0-memory-reuse.json')), true)
  t.mock.method(scenario, 'closeCurrent', async () => { throw new Error('restart path reached') })
  await assert.rejects(scenario.start('resume'), /restart path reached/)
})

test('a failed memory prerequisite stops its dependent stages and package schedules', async t => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'viva-smoke-fail-fast-'))
  t.after(() => fs.rmSync(output, { recursive: true }))
  const stages: string[] = []
  const scripts: string[] = []
  const webContents = {
    on: () => {},
    executeJavaScript: async (code: string): Promise<unknown> => { scripts.push(code); return true },
  } as SmokeAppWindow['webContents']
  const win: SmokeAppWindow = {
    webContents, getSize: async () => [800, 600], setSize: async () => {}, center: async () => {},
  }
  // The stage throws before invoking its browser work. Later stages must never be scheduled.
  const hooks = { step: async <T>(name: string, _action: () => Promise<T>): Promise<T> => {
    stages.push(name)
    throw new Error('injected memory prerequisite failure')
  } } as SmokeHooks
  const failures = await runSmoke(win, { smokeOut: output, smokePhase: 'memory', includeSchedules: true }, hooks)
  assert.ok(failures.some(failure => failure.includes('injected memory prerequisite failure')))
  assert.deepEqual(stages, ['memory, capabilities and models'])
  assert.ok(!scripts.some(script => script.includes('周五下班前要交周报')))
})

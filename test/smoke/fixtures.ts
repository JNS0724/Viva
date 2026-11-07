import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test as base, expect, type TestInfo } from '@playwright/test'
import { startFakeLlm } from '../fixtures/fake-llm.js'
import { showcaseDecide } from '../fixtures/showcase-llm.js'
import { createOwnedProfile, disposeOwnedProfile, type OwnedProfile } from './owned-profile.ts'
import { configureFakeProvider, launchSmokeApplication, type SmokeApplication } from './application.ts'
import { failureDiagnostics, recordMemoryEvents } from './diagnostics.ts'
import { seedTimeline } from './smoke-timeline.ts'
import { seedPerf } from './smoke-perf.ts'
import { runSmoke } from './smoke.ts'
import { smokeStep, type SmokeModel } from './smoke-kit.ts'

export type SmokePhase = 'setup' | 'language' | 'walkthrough' | 'relaunch' | 'memory' | 'schedules' | 'resume-prepare' | 'resume' | 'timeline' | 'perf' | 'showcase' | 'live' | 'live-resume'
export interface ScenarioOptions { phase: SmokePhase, bridge: 'real' | 'fake', apiKey?: string }

/** A restart belongs to the same logical scenario; separate tests never depend on a previous test's files. */
export class Scenario {
  readonly profile: OwnedProfile
  readonly info: TestInfo
  readonly options: ScenarioOptions
  model: SmokeModel | null = null
  current: SmokeApplication | null = null
  private launches = 0
  private tracing = false
  private traces: string[] = []
  private prepared = false

  constructor(info: TestInfo, options: ScenarioOptions) {
    this.info = info; this.options = options
    this.profile = createOwnedProfile(path.join(os.tmpdir(), 'viva-smoke-profiles'), options.phase)
    if (options.phase !== 'language') fs.writeFileSync(path.join(this.profile.userData, 'preferences.json'), JSON.stringify({ language: 'zh-CN' }))
  }

  async prepare(): Promise<void> {
    if (!['setup', 'language'].includes(this.options.phase) && !this.options.apiKey) {
      this.model = await startFakeLlm({ decideFirst: this.options.phase === 'showcase' ? showcaseDecide : undefined })
      const initial = await this.start('bootstrap')
      await configureFakeProvider(initial, this.model, this.info.outputPath('model-picker.png'))
      // These seeds must be written while the app is closed. Installed checks keep their cold launch too.
      if (['timeline', 'perf'].includes(this.options.phase) || this.info.project.name === 'package') await this.closeCurrent()
      else this.prepared = true
    }
    if (this.options.phase === 'timeline') seedTimeline(this.profile.userData)
    if (this.options.phase === 'perf') seedPerf(this.profile.userData)
  }

  async start(label: string): Promise<SmokeApplication> {
    if (this.prepared && this.current) {
      this.prepared = false
      fs.writeFileSync(this.info.outputPath(`${this.launches}-${label}-reuse.json`), JSON.stringify({ at: new Date().toISOString(), launch: this.launches, label }))
      return this.current
    }
    await this.closeCurrent()
    const output = this.info.outputPath(`${++this.launches}-${label}`)
    this.current = await launchSmokeApplication({
      profile: this.profile, outputDirectory: output, model: this.model, bridge: this.options.bridge,
      apiKey: this.options.apiKey, fullAccessibility: this.options.phase === 'perf',
      waitForAgent: label !== 'bootstrap' && Boolean(this.model || this.options.apiKey),
    })
    this.current.hooks.step = (name, action) => base.step(name, action)
    if (!this.options.apiKey && this.options.phase !== 'perf') {
      // Playwright's DOM snapshot script cannot run in the app's deliberately scriptless search iframe.
      // Keep operation/network/screenshot traces in integration; public UI smoke also keeps DOM snapshots.
      await this.current.application.context().tracing.start({ screenshots: true, snapshots: this.info.project.name === 'smoke', sources: false })
      this.tracing = true
    }
    await recordMemoryEvents(this.current)
    return this.current
  }

  async run(phase: SmokePhase): Promise<void> {
    const session = await this.start(phase)
    const problems = await smokeStep(session.hooks, phase, () => runSmoke(session.window, {
      smokeOut: this.info.outputPath(phase), smokePhase: phase,
      includeSchedules: this.info.project.name === 'package' && phase === 'memory',
    }, session.hooks))
    await this.info.attach(`${phase}-assertions`, { body: JSON.stringify(problems, null, 2), contentType: 'application/json' })
    expect(problems, `${phase} legacy integration assertions`).toEqual([])
  }

  async closeCurrent(): Promise<void> {
    this.prepared = false
    if (!this.current) return
    const session = this.current
    this.current = null
    try {
      if (this.tracing) {
        const trace = this.info.outputPath(`trace-${this.launches}.zip`)
        try { await session.application.context().tracing.stop({ path: trace }); this.traces.push(trace) }
        finally { this.tracing = false }
      }
    } finally { await session.close() }
  }

  async dispose(failed: boolean): Promise<void> {
    try {
      if (failed) for (const file of await failureDiagnostics(this.current, this.profile, this.info.outputPath('diagnostics'))) {
        await this.info.attach(path.basename(file), { path: file })
      }
    } finally {
      try { await this.closeCurrent() }
      finally { await this.model?.close() }
    }
    for (const file of this.traces) {
      if (failed) await this.info.attach(path.basename(file), { path: file, contentType: 'application/zip' })
      else fs.rmSync(file)
    }
    if (!failed) disposeOwnedProfile(this.profile)
  }
}

type Factory = (options: ScenarioOptions) => Promise<Scenario>
export const test = base.extend<{ scenario: Factory }>({
  scenario: async ({}, use, info) => {
    const scenarios: Scenario[] = []
    try {
      await use(async options => {
        const scenario = new Scenario(info, options)
        scenarios.push(scenario)
        await scenario.prepare()
        return scenario
      })
    } finally {
      const errors: unknown[] = []
      for (const scenario of scenarios) {
        try { await scenario.dispose(info.status !== info.expectedStatus) } catch (error) { errors.push(error) }
      }
      if (errors.length) throw new AggregateError(errors, 'Scenario cleanup failed')
    }
  },
})
export { expect }

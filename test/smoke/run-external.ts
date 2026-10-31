import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startFakeLlm } from '../fixtures/fake-llm.js'
import { showcaseDecide } from '../fixtures/showcase-llm.js'
import { createOwnedProfile, disposeOwnedProfile } from './owned-profile.ts'
import { configureFakeProvider, launchSmokeApplication, type SmokeApplication } from './application.ts'
import { failureDiagnostics, recordMemoryEvents } from './diagnostics.ts'
import { runSmoke } from './smoke.ts'
import type { SmokePhase } from './fixtures.ts'
import type { SmokeModel } from './smoke-kit.ts'

/** Live checks and demo capture use the same external transport, with no Playwright test timeout or trace. */
export async function runExternalScenario(options: { phases: SmokePhase[], outputDirectory: string, executable?: string, apiKey?: string }): Promise<string[]> {
  const profile = createOwnedProfile(path.join(os.tmpdir(), 'viva-smoke-profiles'), options.phases[0])
  const output = path.resolve(options.outputDirectory)
  fs.mkdirSync(output, { recursive: true })
  fs.writeFileSync(path.join(profile.userData, 'preferences.json'), JSON.stringify({ language: 'zh-CN' }))
  let model: SmokeModel | null = null
  let session: SmokeApplication | null = null
  let succeeded = false
  const problems: string[] = []
  try {
    if (!options.apiKey) model = await startFakeLlm({ decideFirst: options.phases[0] === 'showcase' ? showcaseDecide : undefined })
    const start = (label: string) => launchSmokeApplication({ profile, model, bridge: 'real', apiKey: options.apiKey, executable: options.executable, waitForAgent: label !== 'bootstrap', outputDirectory: path.join(output, 'harness', label) })
    if (model) {
      session = await start('bootstrap')
      await configureFakeProvider(session, model)
      await session.close(); session = null
    }
    for (const phase of options.phases) {
      session = await start(phase)
      await recordMemoryEvents(session)
      const failures = await runSmoke(session.window, { smokeOut: output, smokePhase: phase }, session.hooks)
      problems.push(...failures)
      if (failures.length) await failureDiagnostics(session, profile, path.join(output, 'harness', phase, 'diagnostics'))
      await session.close(); session = null
    }
    succeeded = problems.length === 0
    return problems
  } catch (error) {
    await failureDiagnostics(session, profile, path.join(output, 'harness', 'failure'))
    throw error
  } finally {
    try { await session?.close() }
    finally { await model?.close() }
    if (succeeded) disposeOwnedProfile(profile)
  }
}

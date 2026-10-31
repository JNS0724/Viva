import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { BrowserWindow } from 'electron'
import type { LaunchConfig } from './config.ts'
import type { createDeskIsland } from './desk-island.ts'
import type { Followups } from './followups-main.ts'
import type { openSources } from './sources-main.ts'

export interface SmokeModel {
  url: string
  requests: unknown[]
  close: () => Promise<void>
}

/** Capabilities supplied only when an explicit smoke phase is running. Scenarios live outside the app. */
export interface SmokeHost {
  agentPid: () => number | null
  desk: () => ReturnType<typeof createDeskIsland> | null
  cwd: string
  userData: string
  fixtures: string
  model: () => SmokeModel | null
  pickSourceFolder: (dir: string) => void
  openTasksPage: () => void
  sources: () => ReturnType<typeof openSources> | null
  followups: () => Followups | null
}

export interface SmokeHarness {
  seed: (phase: string, userData: string) => void
  startModel: (options: { phase: string | null, fixtures: string, port: number }) => Promise<SmokeModel>
  run: (win: BrowserWindow, config: Pick<LaunchConfig, 'smokeOut' | 'smokePhase'>, quit: (code: number) => void, host: SmokeHost) => Promise<void>
}

/** No scenario imports on ordinary startup; packaged acceptance must explicitly supply the external harness. */
export async function loadSmokeHarness({ enabled, codeRoot, packaged, env = process.env }: {
  enabled: boolean, codeRoot: string, packaged: boolean, env?: NodeJS.ProcessEnv,
}): Promise<SmokeHarness | null> {
  if (!enabled) return null
  if (packaged && !env.SMOKE_TEST_ROOT) throw new Error('Packaged smoke requires SMOKE_TEST_ROOT pointing to the external compiled test/smoke harness')
  const entry = path.join(env.SMOKE_TEST_ROOT ? path.resolve(env.SMOKE_TEST_ROOT) : path.join(codeRoot, 'test', 'smoke'), 'entry.js')
  if (!fs.existsSync(entry)) throw new Error(`Smoke harness not found: ${entry}; run npm run build:smoke and set SMOKE_TEST_ROOT for an installed app`)
  const loaded: { smokeHarness: SmokeHarness } = await import(pathToFileURL(entry).href)
  return loaded.smokeHarness
}

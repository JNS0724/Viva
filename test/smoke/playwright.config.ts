import path from 'node:path'
import { defineConfig } from '@playwright/test'
import { integrationSpecs } from './suites.ts'

const root = path.resolve(import.meta.dirname, '..', '..')
const run = process.env.VIVA_SMOKE_RUN
if (run !== undefined && !/^[a-zA-Z0-9_-]+$/.test(run)) throw new Error('Invalid VIVA_SMOKE_RUN identifier')
const output = path.join(root, 'smoke', run ?? '')
export default defineConfig({
  testDir: import.meta.dirname,
  outputDir: path.join(output, 'test-results'),
  metadata: { revision: process.env.GITHUB_SHA, platform: process.platform, node: process.version, lane: process.env.VIVA_SMOKE_LANE ?? 'all', run },
  timeout: 300_000,
  expect: { timeout: 15_000 },
  retries: 0,
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  reporter: [['list'], ['html', { outputFolder: path.join(output, 'report'), open: 'never' }], ['junit', { outputFile: path.join(output, 'junit.xml') }]],
  projects: [
    { name: 'smoke', testMatch: 'critical.spec.ts' },
    { name: 'integration', testMatch: integrationSpecs(process.env.VIVA_SMOKE_LANE) },
    { name: 'package', testMatch: 'artifact.spec.ts' },
    { name: 'performance', testMatch: 'perf.spec.ts' },
  ],
})

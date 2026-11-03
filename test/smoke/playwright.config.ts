import path from 'node:path'
import { defineConfig } from '@playwright/test'

const root = path.resolve(import.meta.dirname, '..', '..')
export default defineConfig({
  testDir: import.meta.dirname,
  outputDir: path.join(root, 'smoke', 'test-results'),
  timeout: 300_000,
  expect: { timeout: 15_000 },
  retries: 0,
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  reporter: [['list'], ['html', { outputFolder: path.join(root, 'smoke', 'report'), open: 'never' }], ['junit', { outputFile: path.join(root, 'smoke', 'junit.xml') }]],
  projects: [
    { name: 'smoke', testMatch: 'critical.spec.ts' },
    { name: 'integration', testMatch: 'app.spec.ts' },
    { name: 'package', testMatch: 'artifact.spec.ts' },
    { name: 'performance', testMatch: 'perf.spec.ts' },
  ],
})

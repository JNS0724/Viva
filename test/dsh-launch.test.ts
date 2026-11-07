import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LAUNCH_TYPE, launchMessage, packageManagerOf } from '../src/backend/dsh-launch.ts'

/** What the app hands dsh at launch over IPC (dsh-launch.ts): the pnpm to install plugins with, and its own variables. */

test('the pnpm and the registry token go to dsh over IPC, for pnpm only', () => {
  const message = launchMessage({ pnpmCommand: '/app/bin/pnpm', registryToken: 'npm_example' })
  assert.deepEqual(message, { type: LAUNCH_TYPE, pnpm: { command: '/app/bin/pnpm', env: { VIVA_REGISTRY_TOKEN: 'npm_example' } } })
  assert.deepEqual(packageManagerOf(message), { command: '/app/bin/pnpm', args: [], env: { VIVA_REGISTRY_TOKEN: 'npm_example' } })
})

test('without a token pnpm gets no variable; without a shipped pnpm, the one on PATH', () => {
  assert.deepEqual(packageManagerOf(launchMessage({ pnpmCommand: null, registryToken: '' })), { command: 'pnpm', args: [], env: {} })
})

test('anything else is not taken for the launch: dsh starts as it would', () => {
  for (const other of [null, 'x', { type: 'questions_ask' }, { type: LAUNCH_TYPE }, { type: LAUNCH_TYPE, pnpm: { command: 1, env: {} } }, { type: LAUNCH_TYPE, pnpm: { command: 'p', env: { A: 1 } } }]) {
    assert.equal(packageManagerOf(other), undefined, JSON.stringify(other))
  }
})

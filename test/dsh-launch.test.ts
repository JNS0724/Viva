import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LAUNCH_TYPE, launchMessage, packageManagerOf } from '../src/backend/dsh-launch.ts'

/** What the app hands dsh at launch over IPC (dsh-launch.ts): the pnpm to install plugins with, and its own variables. */

const REGISTRY = 'https://npm.example.com/'
const TOKEN_SETTING = 'npm_config_//npm.example.com/:_authToken'

test('the pnpm and the registry token go to dsh over IPC, for pnpm only; every scope pnpm knows is sent to the registry', () => {
  const message = launchMessage({ pnpmCommand: '/app/bin/pnpm', registry: REGISTRY, registryToken: 'npm_example', scopes: ['@jsr', '@company'] })
  const args = [`--config.@jsr:registry=${REGISTRY}`, `--config.@company:registry=${REGISTRY}`]
  assert.deepEqual(message, { type: LAUNCH_TYPE, pnpm: { command: '/app/bin/pnpm', args, env: { [TOKEN_SETTING]: 'npm_example' } } })
  assert.deepEqual(packageManagerOf(message), { command: '/app/bin/pnpm', args, env: { [TOKEN_SETTING]: 'npm_example' } })
})

test('a registry without a token: its scopes, no variable; no registry: neither, and without a shipped pnpm the one on PATH', () => {
  assert.deepEqual(packageManagerOf(launchMessage({ pnpmCommand: '/app/bin/pnpm', registry: REGISTRY, registryToken: '', scopes: ['@a'] })),
    { command: '/app/bin/pnpm', args: [`--config.@a:registry=${REGISTRY}`], env: {} })
  assert.deepEqual(packageManagerOf(launchMessage({ pnpmCommand: null, registry: null, registryToken: 'stale', scopes: ['@a'] })), { command: 'pnpm', args: [], env: {} },
    'a token kept for no registry goes nowhere')
})

test('anything else is not taken for the launch: dsh starts as it would', () => {
  for (const other of [null, 'x', { type: 'questions_ask' }, { type: LAUNCH_TYPE }, { type: LAUNCH_TYPE, pnpm: { command: 1, args: [], env: {} } },
    { type: LAUNCH_TYPE, pnpm: { command: 'p', args: [], env: { A: 1 } } }, { type: LAUNCH_TYPE, pnpm: { command: 'p', args: [1], env: {} } },
    { type: LAUNCH_TYPE, pnpm: { command: 'p', args: 'x', env: {} } }]) {
    assert.equal(packageManagerOf(other), undefined, JSON.stringify(other))
  }
})

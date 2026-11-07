import { test } from 'node:test'
import assert from 'node:assert/strict'
import { authKey, authVariable, pinArgs, pnpmScopes, scopesIn } from '../src/backend/plugin-registry.ts'

/** The company's registry as pnpm 11 is made to take it (plugin-registry.ts): its token by a variable, every scope sent to it. */

const REGISTRY = 'https://npm.example.com:8443/repo/'

test('the token is named for its registry as npm names it, in the variable pnpm reads settings from', () => {
  assert.equal(authKey(REGISTRY), '//npm.example.com:8443/repo/')
  assert.equal(authVariable(REGISTRY), 'npm_config_//npm.example.com:8443/repo/:_authToken',
    'pnpm 11 expands no `${…}` in a project .npmrc, so the token goes in as a setting of its own, never into a file')
})

test('the scopes pnpm would ask a registry of their own, as `pnpm config list --json` has them', () => {
  const config = {
    registry: 'https://registry.npmjs.org/', '@jsr:registry': 'https://npm.jsr.io/', '@company:registry': 'https://public.example/',
    '//npm.example.com/:_authToken': '(protected)', 'store-dir': '/tmp/store', '@odd': 'x', ':registry': 'y',
  }
  assert.deepEqual(scopesIn(config), ['@jsr', '@company'], "pnpm's own scope counts too; anything else is not a scope's registry")
  assert.deepEqual([scopesIn(null), scopesIn([]), scopesIn('x')], [[], [], []])
})

test('each scope is sent to the company registry on the command line, the one place that wins over any .npmrc', () => {
  assert.deepEqual(pinArgs(REGISTRY, ['@jsr', '@company']), [`--config.@jsr:registry=${REGISTRY}`, `--config.@company:registry=${REGISTRY}`])
  assert.deepEqual(pinArgs(REGISTRY, []), [])
})

test('the scopes are read by the pnpm that installs, where it installs; on Windows its .cmd through the shell, quoted', () => {
  const calls: unknown[] = []
  const run = (command: string, args: readonly string[], options: Record<string, unknown>) => {
    calls.push({ command, args, cwd: options.cwd, shell: options.shell, env: options.env })
    return JSON.stringify({ '@company:registry': 'https://public.example/' })
  }
  const env = { HOME: '/Users/me' }
  assert.deepEqual(pnpmScopes({ command: '/app/bin/pnpm', cwd: '/dsh/profiles/viva', env, platform: 'darwin', run }), ['@company'])
  assert.deepEqual(pnpmScopes({ command: 'C:\\Users\\A B\\bin\\pnpm.cmd', cwd: 'C:\\dsh', env, platform: 'win32', run }), ['@company'])
  assert.deepEqual(calls, [
    { command: '/app/bin/pnpm', args: ['config', 'list', '--json'], cwd: '/dsh/profiles/viva', shell: false, env },
    { command: '"C:\\Users\\A B\\bin\\pnpm.cmd"', args: ['config', 'list', '--json'], cwd: 'C:\\dsh', shell: true, env },
  ])
})

test('settings pnpm cannot give are an error, not no scopes: the caller says so rather than install from them unseen', () => {
  assert.throws(() => pnpmScopes({ command: 'pnpm', cwd: '/x', env: {}, platform: 'darwin', run: () => 'not json' }))
  assert.throws(() => pnpmScopes({ command: 'pnpm', cwd: '/x', env: {}, platform: 'darwin', run: () => { throw new Error('ENOENT') } }), /ENOENT/)
})

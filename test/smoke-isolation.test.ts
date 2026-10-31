import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { applicationEnvironment } from './smoke/environment.ts'
import { assertOwnedProfile, createOwnedProfile, disposeOwnedProfile } from './smoke/owned-profile.ts'

test('scenario cleanup removes only the new owned root, preserving its base and sibling files', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'viva-profile-test-'))
  try {
    const sibling = path.join(base, 'keep.txt')
    fs.writeFileSync(sibling, 'user data')
    const profile = createOwnedProfile(base, 'restart')
    fs.writeFileSync(path.join(profile.workspace, 'history.txt'), 'synthetic')
    disposeOwnedProfile(profile)
    assert.equal(fs.existsSync(profile.root), false)
    assert.equal(fs.readFileSync(sibling, 'utf8'), 'user data')
  } finally { fs.rmSync(base, { recursive: true }) }
})

test('an incorrect owner cannot delete a profile; replacing its workspace with a junction is rejected', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'viva-profile-test-'))
  try {
    const profile = createOwnedProfile(base, 'ownership')
    assert.throws(() => disposeOwnedProfile({ ...profile, owner: 'foreign' }), /ownership/)
    assert.ok(fs.existsSync(profile.userData))
    const elsewhere = path.join(base, 'foreign')
    fs.mkdirSync(elsewhere)
    fs.rmdirSync(profile.workspace)
    fs.symlinkSync(elsewhere, profile.workspace, process.platform === 'win32' ? 'junction' : 'dir')
    assert.throws(() => assertOwnedProfile(profile), /escaped/)
    // Remove the link itself, then restore a normal owned workspace for disposal.
    fs.unlinkSync(profile.workspace)
    fs.mkdirSync(profile.workspace)
    disposeOwnedProfile(profile)
    assert.ok(fs.existsSync(elsewhere))
  } finally { fs.rmSync(base, { recursive: true }) }
})

const options = { workspace: path.resolve('/synthetic/workspace'), projectRoot: path.resolve('/repo'), importHome: path.resolve('/synthetic/import'), bridge: 'real' as const }
test('the fake-model child cannot inherit credentials, endpoint overrides or Node injection hooks', () => {
  const env = applicationEnvironment({ PATH: '/bin', SystemRoot: 'C:\\Windows', DEEPSEEK_API_KEY: 'real-secret', DEEPSEEK_BASE_URL: 'https://foreign', GITHUB_TOKEN: 'token', NODE_OPTIONS: '--require=foreign', ELECTRON_RUN_AS_NODE: '1', DSH_BIN: '/foreign', DSH_HOME: '/real-home', HTTPS_PROXY: 'http://foreign' }, options)
  assert.equal(env.DEEPSEEK_API_KEY, '')
  assert.equal(env.DSH_HOME, options.importHome)
  assert.equal(env.SystemRoot, 'C:\\Windows')
  for (const key of ['GITHUB_TOKEN', 'DEEPSEEK_BASE_URL', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'DSH_BIN', 'HTTPS_PROXY']) assert.equal(env[key], undefined, key)
  assert.equal(env.NO_PROXY, '127.0.0.1,localhost')
})

test('live credentials require explicit options and the fake bridge path is runner-owned', () => {
  const env = applicationEnvironment({ DEEPSEEK_API_KEY: 'inherited', HTTPS_PROXY: 'http://proxy' }, { ...options, apiKey: 'explicit', bridge: 'fake' })
  assert.equal(env.DEEPSEEK_API_KEY, 'explicit')
  assert.equal(env.HTTPS_PROXY, 'http://proxy')
  assert.equal(env.DSH_BIN, path.join(options.projectRoot, 'test', 'fixtures', 'fake-dsh.js'))
})

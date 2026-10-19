import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { adoptLegacyData } from '../src/main/legacy-data.js'

/** The first launch as Viva brings along what my-agent kept, without touching the old folder. */
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-data-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const legacyDir = path.join(root, 'my-agent')
  const userData = path.join(root, 'Viva')
  fs.mkdirSync(legacyDir)
  return { legacyDir, userData }
}

test('the databases and their write-ahead logs are copied; the old folder and the encrypted settings stay', (t) => {
  const { legacyDir, userData } = setup(t)
  for (const [name, text] of [['history.db', 'h'], ['history.db-wal', 'w'], ['memory.db', 'm'], ['settings.json', '{"deepseekApiKey":"…"}']]) {
    fs.writeFileSync(path.join(legacyDir, name), text)
  }

  assert.deepEqual(adoptLegacyData({ userData, legacyDir }), ['history.db', 'memory.db'])
  assert.deepEqual(fs.readdirSync(userData).sort(), ['history.db', 'history.db-wal', 'memory.db'])
  assert.equal(fs.readFileSync(path.join(userData, 'history.db-wal'), 'utf8'), 'w')
  assert.deepEqual(fs.readdirSync(legacyDir).sort(), ['history.db', 'history.db-wal', 'memory.db', 'settings.json'])
})

test('nothing is overwritten, and a second launch copies nothing', (t) => {
  const { legacyDir, userData } = setup(t)
  fs.writeFileSync(path.join(legacyDir, 'memory.db'), 'old')
  fs.mkdirSync(userData)
  fs.writeFileSync(path.join(userData, 'memory.db'), 'new')

  assert.deepEqual(adoptLegacyData({ userData, legacyDir }), [])
  assert.equal(fs.readFileSync(path.join(userData, 'memory.db'), 'utf8'), 'new')
})

test('no old folder, or the same folder, means nothing to do', (t) => {
  const { legacyDir, userData } = setup(t)
  assert.deepEqual(adoptLegacyData({ userData, legacyDir: path.join(legacyDir, 'missing') }), [])
  assert.deepEqual(adoptLegacyData({ userData: legacyDir, legacyDir }), [])
})

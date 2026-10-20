import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPreferences } from '../src/main/preferences.js'

const tempFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'viva-prefs-')), 'preferences.json')

test('preferences start from their defaults and keep what is set', () => {
  const file = tempFile()
  const prefs = createPreferences({ file })
  assert.deepEqual(prefs.get(), { deskIsland: true })
  assert.deepEqual(prefs.set('deskIsland', false), { deskIsland: false })
  assert.deepEqual(createPreferences({ file }).get(), { deskIsland: false }, 'kept across launches')
})

test('only known preferences of the right type are taken', () => {
  const prefs = createPreferences({ file: tempFile() })
  assert.throws(() => prefs.set('deskIsland', 'no'), /deskIsland/)
  assert.throws(() => prefs.set('apiKey', 'sk-x'), /unknown preference/)
})

test('a broken file falls back to the defaults and is reported', () => {
  const file = tempFile()
  fs.writeFileSync(file, '{not json')
  const problems = []
  assert.deepEqual(createPreferences({ file, onError: (err) => problems.push(err.message) }).get(), { deskIsland: true })
  assert.equal(problems.length, 1)
})

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
  const home = { last: null, places: {} }
  assert.deepEqual(prefs.get(), { deskIsland: true, deskPlaces: home })
  assert.deepEqual(prefs.set('deskIsland', false), { deskIsland: false, deskPlaces: home })
  const placed = { last: '1', places: { 1: { fx: 0.8, fy: 0.9 } } }
  prefs.set('deskPlaces', placed)
  assert.deepEqual(createPreferences({ file }).get(), { deskIsland: false, deskPlaces: placed }, 'kept across launches')
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
  assert.deepEqual(createPreferences({ file, onError: (err) => problems.push(err.message) }).get(), { deskIsland: true, deskPlaces: { last: null, places: {} } })
  assert.equal(problems.length, 1)
})

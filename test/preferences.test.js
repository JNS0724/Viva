import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPreferences } from '../src/main/preferences.ts'

const tempFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'viva-prefs-')), 'preferences.json')
const noDirs = { recent: [], trusted: [] }

test('preferences start from their defaults and keep what is set', () => {
  const file = tempFile()
  const prefs = createPreferences({ file })
  const home = { last: null, places: {} }
  const fresh = { workDirs: noDirs, imagesDir: '', permission: 'workspace-write', dshImportDir: '', openAtLogin: false, prepareSchedule: {} }
  assert.deepEqual(prefs.get(), { deskIsland: true, deskPlaces: home, deskCoached: false, ...fresh })
  assert.deepEqual(prefs.set('deskIsland', false), { deskIsland: false, deskPlaces: home, deskCoached: false, ...fresh })
  const placed = { last: '1', places: { 1: { fx: 0.8, fy: 0.9 } } }
  prefs.set('deskPlaces', placed)
  const dirs = { recent: ['/me/site'], trusted: ['/me/site'] }
  prefs.set('workDirs', dirs)
  prefs.set('imagesDir', '/me/Pictures/Viva 图片')
  prefs.set('permission', 'auto')
  prefs.set('dshImportDir', '/me/work/team-dsh/.dsh')
  prefs.set('openAtLogin', true)
  assert.deepEqual(createPreferences({ file }).get(), {
    deskIsland: false, deskPlaces: placed, deskCoached: false, workDirs: dirs, imagesDir: '/me/Pictures/Viva 图片', permission: 'auto',
    dshImportDir: '/me/work/team-dsh/.dsh', openAtLogin: true, prepareSchedule: {},
  }, 'kept across launches')
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
  assert.deepEqual(createPreferences({ file, onError: (err) => problems.push(err.message) }).get(), { deskIsland: true, deskPlaces: { last: null, places: {} }, deskCoached: false, workDirs: noDirs, imagesDir: '', permission: 'workspace-write', dshImportDir: '', openAtLogin: false, prepareSchedule: {} })
  assert.equal(problems.length, 1)
})

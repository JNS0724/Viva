import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPackage } from '@electron/asar'
import { finalAsarHash, refreshedWindowsIntegrity } from '../scripts/asar-integrity.ts'

test('repacked ASAR integrity uses the final header and replaces the old record without dropping other archives', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viva-asar-integrity-'))
  // Yield while retrying so asynchronous directory/file handles from the archive writer can close on Windows.
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  const source = path.join(dir, 'app')
  fs.mkdirSync(source)
  fs.writeFileSync(path.join(source, 'main.js'), 'before')
  // The bytes are ASAR; a neutral extension keeps Electron's automatic archive mount out of fixture cleanup.
  const archive = path.join(dir, 'app.archive')
  await createPackage(source, archive)
  const before = finalAsarHash(archive)
  const records = [{ file: 'resources\\app.asar', alg: 'SHA256', value: before }, { file: 'resources\\extra.asar', alg: 'SHA256', value: 'keep' }]
  fs.writeFileSync(path.join(source, 'main.js'), 'after: changed content and length')
  await createPackage(source, archive)
  const after = finalAsarHash(archive)
  assert.notEqual(after, before)
  const updated = refreshedWindowsIntegrity(records, after)
  assert.equal(updated[0].value, after)
  assert.deepEqual(updated[1], records[1])
  assert.equal(records[0].value, before, 'do not mutate the original diagnostic record')
  assert.throws(() => refreshedWindowsIntegrity([], after), /no integrity record/)
})

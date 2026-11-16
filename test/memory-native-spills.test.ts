import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { link, mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { saveTextFile, sessionDir } from '@deepseek-ai/dsh-spill-local'
import { createNativeSpills, type NativeSpillIntent } from '../src/memory/node/native-spills.ts'
import { reserveNativeSpill, publishGovernedNativeSpill } from '../plugins/memory/lib/native/governed-spills.ts'
import { eraseNativeSpill } from '../plugins/memory/lib/native/local-spills.ts'
import { scratch } from './fixtures/scratch.js'

const body = 'Private memory-derived spill content.'
for (const boundary of ['empty', 'partial', 'staged', 'linked', 'published', 'receipted'] as const) {
  test(`deterministic local spill erasure recovers the ${boundary} write boundary and preserves identical independent text`, async t => {
    const { dir, defer } = scratch(t, 'viva-native-spills-'), directory = join(dir, 'spill')
    await mkdir(directory, { mode: 0o700 })
    const root = await realpath(directory)
    const db = new DatabaseSync(join(dir, 'memory.db'))
    defer(() => db.close())
    const spills = createNativeSpills(db)
    const intent: NativeSpillIntent = { root, bytes: Buffer.byteLength(body), hash: createHash('sha256').update(body).digest('hex'),
      call: { id: randomUUID(), session: 'session', callId: 'ptc-leaf', generation: 0, turn: 1, step: 1, seq: 3, digest: 'a'.repeat(64) } }
    const independent = await saveTextFile({ root, sessionId: intent.call.session, suggestedName: 'independent.txt', content: body })
    const reserved = await reserveNativeSpill(intent, 'memory_read.txt'), id = spills.begin(reserved.intent)
    let file = null
    if (boundary === 'published' || boundary === 'receipted') {
      const saved = await publishGovernedNativeSpill(reserved.handle, reserved.intent, body, () => true)
      if (boundary === 'receipted') { file = saved.receipt; spills.finish(id, file) }
    } else {
      if (boundary !== 'empty') await reserved.handle.writeFile(boundary === 'partial' ? body.slice(0, 9) : body)
      await reserved.handle.sync()
      await reserved.handle.close()
      if (boundary === 'linked') await link(reserved.intent.publication!.stage.path, reserved.intent.publication!.target)
    }
    assert.doesNotMatch(JSON.stringify(db.prepare('SELECT * FROM owner_native_spills').all()), /Private memory-derived/u)
    const target = spills.affected([intent.call], [])[0]!
    assert.ok(target)
    assert.equal(await eraseNativeSpill(target, () => true), true)
    // The process can stop after the durable removal but before owner acknowledgement.
    assert.equal(await eraseNativeSpill(target, () => true), true)
    spills.complete(id)
    assert.deepEqual(spills.affected([intent.call], []), [])
    assert.equal(existsSync(reserved.intent.publication!.target), false)
    assert.equal(existsSync(reserved.intent.publication!.stage.path), false)
    assert.equal(await readFile(independent.path, 'utf8'), body)
  })
}

test('changed spill inode, unknown hardlink, and missing opaque path proof remain pending', async t => {
  const { dir, defer } = scratch(t, 'viva-native-spill-identity-'), directory = join(dir, 'spill')
  await mkdir(directory, { mode: 0o700 })
  const root = await realpath(directory)
  const db = new DatabaseSync(join(dir, 'memory.db')); defer(() => db.close())
  const spills = createNativeSpills(db)
  const intent: NativeSpillIntent = { root, bytes: Buffer.byteLength(body), hash: createHash('sha256').update(body).digest('hex'),
    call: { id: randomUUID(), session: 'session', callId: 'root', generation: 0, turn: 1, step: 1, seq: 3, digest: 'b'.repeat(64) } }
  const reserved = await reserveNativeSpill(intent, 'run_code.txt'), id = spills.begin(reserved.intent)
  const saved = await publishGovernedNativeSpill(reserved.handle, reserved.intent, body, () => true)
  spills.finish(id, saved.receipt)
  const target = spills.affected([intent.call], [])[0]!
  assert.equal(typeof saved.receipt.ino, 'string')
  const unknown = join(sessionDir(root, intent.call.session), 'unknown-independent-link')
  await link(saved.ref.locator, unknown)
  assert.equal(await eraseNativeSpill(target, () => true), false)
  await unlink(unknown)
  const replacement = join(sessionDir(root, intent.call.session), 'same-text-independent')
  await writeFile(replacement, body, { flag: 'wx', mode: 0o600 })
  await rename(replacement, saved.ref.locator)
  assert.equal(await eraseNativeSpill(target, () => true), false)
  assert.equal(await readFile(saved.ref.locator, 'utf8'), body)
  const opaque = spills.begin(intent), pending = spills.affected([intent.call], []).find(item => item.id === opaque)!
  assert.equal(await eraseNativeSpill(pending, () => true), false)
  assert.throws(() => spills.complete(opaque), /no verified file receipt/u)
  assert.equal(spills.affected([intent.call], []).length, 2)
})

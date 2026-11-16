import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { link, mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { saveTextFile, sessionDir } from '@deepseek-ai/dsh-spill-local'
import { createNativeSpills, type NativeSpillIntent } from '../src/memory/node/native-spills.ts'
import { openMemoryOwner } from '../src/memory/node/owner.ts'
import { openNativeOriginalMaintenance } from '../src/memory/node/native-original-maintenance.ts'
import { createNativeErasureReceipts } from '../src/memory/node/native-erasure-receipts.ts'
import { memoryFileDetail, memoryFileMutationResult } from '../src/memory/contracts/file-management.ts'
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

test('native catalog acknowledgement waits for affected spill retirement after tool result erasure', async t => {
  const { dir, defer } = scratch(t, 'viva-native-spill-participant-')
  const memoryRoot = join(dir, 'memory'), directory = join(dir, 'spill'), operationId = randomUUID()
  await mkdir(directory, { mode: 0o700 })
  const owner = openMemoryOwner({ root: memoryRoot, fileMode: true, hostNamespace: 'viva',
    compute: () => null, route: () => null, quiesce: async () => {} })
  let intent: NativeSpillIntent
  let spillId: string
  try {
    await owner.recover()
    owner.initializeSession({ sessionId: 'session' })
    const file = memoryFileMutationResult.parse(await owner.handleHost('createFile', { args: [{ operationId: randomUUID(), text: body }] }))
    const call = { id: randomUUID(), session: 'session', callId: 'memory-read', generation: 0,
      turn: 1, step: 1, seq: 3, digest: 'c'.repeat(64) }
    const result = owner.withNativeToolRead({ call, calls: [call], current: () => true },
      () => owner.runtime.handle({ op: 'file_read', session: call.session, id: file.identity.id }, owner.sessionContext(call.session)))
    assert.match(result ?? '', /Private memory-derived/u)
    const reserved = await reserveNativeSpill({ call, root: await realpath(directory),
      bytes: Buffer.byteLength(body), hash: createHash('sha256').update(body).digest('hex') }, 'memory_read.txt')
    intent = reserved.intent
    spillId = owner.beginNativeSpill(intent)
    const saved = await publishGovernedNativeSpill(reserved.handle, intent, body, () => true)
    owner.finishNativeSpill(spillId, saved.receipt)
    owner.finishNativeToolRead(call, { seq: 4, digest: 'd'.repeat(64) })
    const detail = memoryFileDetail.parse(await owner.handleHost('readFile', { args: [file.identity] }))
    await owner.handleHost('forgetFile', { args: [{ operationId, identity: file.identity, version: detail.version }] })
  } finally { await owner.close() }
  const maintenance = openNativeOriginalMaintenance(memoryRoot, 'viva')
  assert.ok(maintenance)
  defer(() => maintenance.close())
  const db = new DatabaseSync(join(memoryRoot, 'memory.db'))
  defer(() => db.close())
  const receipts = createNativeErasureReceipts(db)
  for (const operation of maintenance.toolResultOperations()) operation.journal.complete(operation.targets().map(target => target.id))
  maintenance.acknowledgeCatalog('e'.repeat(64), new Set())
  assert.equal(receipts.complete(operationId), false, 'the event log alone does not retire its spill')
  const operation = maintenance.spillOperations().find(item => item.operationId === operationId)
  assert.ok(operation)
  const target = operation.targets().find(item => item.id === spillId)
  assert.ok(target)
  assert.equal(target.publication?.target, intent.publication?.target)
  assert.equal(await eraseNativeSpill(target, () => true), true)
  maintenance.acknowledgeCatalog('e'.repeat(64), new Set())
  assert.equal(receipts.complete(operationId), false, 'durable removal must also settle its own receipt')
  operation.complete(target.id)
  maintenance.acknowledgeCatalog('e'.repeat(64), new Set())
  assert.equal(receipts.complete(operationId), true)
})

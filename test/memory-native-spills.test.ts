import { resumeLegacyFileErasure } from './fixtures/legacy-file-erasure.ts'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { link, mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolExecution, ToolExecutionToken, ResolvedToolSet } from '@deepseek-ai/dsh-tools'
import { saveTextFile, sessionDir } from '@deepseek-ai/dsh-spill-local'
import { createNativeSpills, type NativeSpillIntent } from '../src/memory/node/native-spills.ts'
import { openMemoryOwner } from '../src/memory/node/owner.ts'
import { openNativeOriginalMaintenance } from '../src/memory/node/native-original-maintenance.ts'
import { createNativeErasureReceipts } from '../src/memory/node/native-erasure-receipts.ts'
import { memoryFileDetail, memoryFileMutationResult } from '../src/memory/contracts/file-management.ts'
import type { HostMemoryApi } from '../src/memory/contracts/host.ts'
import { reserveNativeSpill, publishGovernedNativeSpill } from '../plugins/memory/lib/native/governed-spills.ts'
import { eraseNativeSpill } from '../plugins/memory/lib/native/local-spills.ts'
import { trackNativeSpillReads } from '../plugins/memory/lib/native/read-spills.ts'
import { trackNativeToolReads } from '../plugins/memory/lib/native/tool-reads.ts'
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
      if (boundary === 'receipted') { file = saved.receipt; spills.finish(id, file, intent.call.session) }
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
  assert.throws(() => spills.finish(id, saved.receipt, 'other'), /changed session/)
  spills.finish(id, saved.receipt, intent.call.session)
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
  const owner = openMemoryOwner({ root: memoryRoot, hostNamespace: 'viva',
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
    owner.finishNativeSpill(spillId, saved.receipt, intent.call.session)
    owner.finishNativeToolRead(call, { seq: 4, digest: 'd'.repeat(64) })
    const detail = memoryFileDetail.parse(await owner.handleHost('readFile', { args: [file.identity] }))
    await resumeLegacyFileErasure(owner, join(memoryRoot, 'memory.db'), { operationId, identity: file.identity, version: detail.version })
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

test('spill read-back archives its exact source proof before use and rejects a late or erased source', async t => {
  const { dir } = scratch(t, 'viva-native-spill-read-'), directory = join(dir, 'spill')
  await mkdir(directory, { mode: 0o700 })
  const owner = openMemoryOwner({ root: join(dir, 'memory'), hostNamespace: 'viva',
    compute: () => null, route: () => null, quiesce: async () => {} })
  try {
    await owner.recover()
    const created = await owner.handleHost('createFile', { args: [{ operationId: randomUUID(), text: body }] }) as HostMemoryApi['createFile']['output']
    owner.initializeSession({ sessionId: 'origin' }); owner.initializeSession({ sessionId: 'consumer' })
    const call = { id: randomUUID(), session: 'origin', callId: 'read', generation: 0, turn: 1, step: 1, seq: 3, digest: 'a'.repeat(64) }
    owner.withNativeToolRead({ call, calls: [call], current: () => true }, () =>
      owner.runtime.handle({ op: 'file_read', session: call.session, id: created.identity.id }, owner.sessionContext(call.session)))
    const reserved = await reserveNativeSpill({ call, root: await realpath(directory), hash: createHash('sha256').update(body).digest('hex'), bytes: Buffer.byteLength(body) }, 'memory_read.txt')
    const id = owner.beginNativeSpill(reserved.intent)
    const saved = await publishGovernedNativeSpill(reserved.handle, reserved.intent, body, () => true)
    owner.finishNativeSpill(id, saved.receipt, reserved.intent.call.session)
    function execution(name: string) {
      owner.initializeSession({ sessionId: name })
      const native = Session.create(SessionId(name)), tools: ResolvedToolSet = { dispose() {}, view: () => new Map() }
      const step = new AbortController(), body = new AbortController(), tracker = trackNativeToolReads(owner.finishNativeToolRead)
      tracker.assembly(native, step.signal, tools); tracker.step(native, 1, 1, step.signal)
      const callId = ToolCallId('read-back')
      const exec: ToolExecution = { callId, rootCallId: callId, name: 'read', arguments: {}, signal: step.signal, toolSet: tools, token: Symbol() as ToolExecutionToken }
      tracker.observe(native, native.append('tool/call', { turn: 1, step: 1, callId, name: 'read', arguments: '{}' }))
      tracker.bind(native, exec)
      return { scope: tracker.acquire(native, { ...exec, signal: body.signal }, 0)!, abort: () => body.abort() }
    }
    let run = execution('consumer'), scope = run.scope
    let permit = owner.admitNativeSpillRead(id, scope)
    assert.equal(permit.current(), true)
    assert.ok(owner.nativeToolEvidence([scope.call]).some(proof => proof.fileRanges.length > 0))
    assert.throws(() => owner.nativeToolEvidence([{ ...scope.call, session: 'other' }]), /changed call identity/)
    assert.ok(owner.dispatch.snapshot('consumer').files?.length)
    run.abort()
    assert.equal(permit.current(), false, 'an actual body cancellation retires read-back even without an FS signal')
    assert.throws(() => owner.admitNativeSpillRead(id, scope), /retired/u)
    run = execution('consumer-next'); scope = run.scope
    permit = owner.admitNativeSpillRead(id, scope)
    const ctx = new Context(), filesystem = await ctx.plugin(LocalFileSystem, { cwd: dir })
    let mode: 'valid' | 'changed' | 'held' = 'valid', exhausted = false
    let entered!: () => void, release!: () => void
    const started = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    ctx.fs.streamText = async () => (async function* () {
      yield mode === 'changed' ? 'Different' : body.slice(0, 9)
      if (mode === 'held') { entered(); await gate }
      yield body.slice(9)
      exhausted = true
    })()
    const unwrappedStream = Object.getOwnPropertyDescriptor(ctx.fs, 'streamText')
    const guard = await ctx.plugin({ inject: ['fs'], apply(scoped: Context) { trackNativeSpillReads(scoped, owner, () => scope) } })
    try {
      const target = await ctx.fs.resolve(saved.ref.locator)
      const snapshot = await ctx.fs.streamText(target)
      assert.equal(exhausted, true, 'even an early-stop consumer receives only a completely verified snapshot')
      let first = ''
      for await (const chunk of snapshot) { first = chunk; break }
      assert.equal(first, body.slice(0, 9))
      mode = 'changed'
      await assert.rejects(async () => {
        const unverified = await ctx.fs.streamText(target)
        for await (const _chunk of unverified) assert.fail('an unverified first chunk must not escape')
      }, /changed/u)
      mode = 'held'
      const delayed = ctx.fs.streamText(target)
      await started
      const detail = await owner.handleHost('readFile', { args: [created.identity] }) as HostMemoryApi['readFile']['output']; assert.ok(detail)
      await resumeLegacyFileErasure(owner, join(dir, 'memory', 'memory.db'), { operationId: randomUUID(), identity: created.identity, version: detail.version })
      release()
      await assert.rejects(delayed, /source changed/u)
    } finally {
      await guard.dispose()
      assert.deepEqual(Object.getOwnPropertyDescriptor(ctx.fs, 'streamText'), unwrappedStream, 'reloading the memory plugin restores the original public filesystem adapter')
      await filesystem.dispose()
    }
    run.abort()
    assert.equal(permit.current(), false, 'a delayed filesystem read cannot outlive its actual execution')
    assert.throws(() => owner.admitNativeSpillRead(id, scope), /retired/u)
    assert.equal(permit.current(), false, 'withdrawal invalidates in-flight reads before physical spill cleanup')
    assert.throws(() => owner.admitNativeSpillRead(id, scope), /retired/u)
    assert.equal(await readFile(saved.ref.locator, 'utf8'), body, 'the barrier rejects a still-present physical artifact')
  } finally { await owner.close() }
})

import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { createAssistantMessage, createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import * as jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import type { ResolvedToolSet, ToolExecution, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import type { HostMemoryApi } from '../src/memory/contracts/host.ts'
import { openMemoryOwner } from '../src/memory/node/owner.ts'
import { openNativeOriginalMaintenance } from '../src/memory/node/native-original-maintenance.ts'
import { eraseColdNativeCopies } from '../plugins/memory/lib/native/maintenance.ts'
import { trackNativeToolReads } from '../plugins/memory/lib/native/tool-reads.ts'
import { nativeEventDigest } from '../plugins/memory/lib/native/event-digest.ts'
import { inspectPtcResultWindow } from '../plugins/memory/lib/native/project-native-ptc.ts'
import { scratch } from './fixtures/scratch.js'

for (const scenario of ['settled-fork', 'interrupted', 'spill-pending', 'missing-origin'] as const) {
  test(`PTC exact input lineage and full-catalog no-output recovery: ${scenario}`, async t => {
    const { dir } = scratch(t, 'viva-native-ptc-'), memoryRoot = join(dir, 'memory'), root = join(dir, 'sessions')
    const owner = openMemoryOwner({ root: memoryRoot, hostNamespace: 'viva', fileMode: true,
      compute: () => null, route: () => null, quiesce: async () => {} })
    await owner.recover()
    const created = await owner.handleHost('createFile', { args: [{ operationId: randomUUID(), text: 'Exact private PTC source.' }] }) as HostMemoryApi['createFile']['output']
    const session = Session.create(SessionId(randomUUID())), signal = new AbortController().signal
    owner.initializeSession({ sessionId: String(session.id), cwd: dir })
    const tools: ResolvedToolSet = { dispose() {}, view: () => new Map() }
    const tracker = trackNativeToolReads(owner.finishNativeToolRead, { evidence: owner.nativeToolEvidence, archive: owner.inheritNativeToolRead })
    const token = () => Symbol() as ToolExecutionToken
    tracker.assembly(session, signal, tools); tracker.step(session, 1, 1, signal)
    session.append('turn/start', { turn: 1 }); session.append('step/start', { turn: 1, step: 1 })
    const rootId = ToolCallId('program'), leafId = ToolCallId('leaf'), independentId = ToolCallId('independent'), derivedId = ToolCallId('derived')
    session.append('assistant/message', { turn: 1, step: 1, message: createAssistantMessage({ source: { provider: 'fixture', model: 'fixture' },
      content: [{ type: 'tool-call', id: rootId, name: 'run_code', arguments: '{}' }] }), stream: [] }, { surfaceOp: 'append' })
    const native = session.append('tool/call', { turn: 1, step: 1, callId: rootId, name: 'run_code', arguments: '{}' })
    tracker.observe(session, native)
    const rootExec: ToolExecution = { callId: rootId, rootCallId: rootId, name: 'run_code', arguments: {}, signal, toolSet: tools, token: token() }
    tracker.bind(session, rootExec)
    const rootLease = tracker.acquire(session, rootExec, 0)!
    function start(id: typeof rootId, name: string, args: Record<string, unknown>) {
      const event = session.append('tool/ptc-dispatch-start', { rootCallId: rootId, parentCallId: rootId, subCallId: id, name, arguments: args })
      tracker.observe(session, event)
      const exec = { ...rootExec, callId: id, name, arguments: args, parent: rootExec.token, token: token() }
      tracker.bind(session, exec)
      return { event, lease: tracker.acquire(session, exec, 0)! }
    }
    const independent = start(independentId, 'echo', { text: 'Exact private PTC source.' })
    const leaf = start(leafId, 'memory_read', { id: created.identity.id })
    const text = owner.withNativeToolRead(leaf.lease, () => owner.runtime.handle({ op: 'file_read', session: session.id, id: created.identity.id },
      { session: session.id, conversation: session.id }))
    assert.match(text ?? '', /Exact private/u)
    const derived = start(derivedId, 'memory_node_search', { query: text })
    assert.equal(derived.lease.call.inputDerived, true)
    assert.equal(independent.lease.call.inputDerived, undefined, 'a pre-read concurrent leaf is independent')
    const settled = scenario === 'settled-fork'
    const outputs = new Map<number, number>()
    if (settled) {
      for (const item of [derived, independent, leaf]) {
        const event = session.append('tool/ptc-dispatch', { ...item.event.data, content: [{ type: 'text', text: 'Exact private PTC source.' }],
          isError: true, error: { name: 'Fixture', code: 'fixture', reason: 'Exact private PTC source.' }, meta: { extra: 'Exact private PTC source.' } })
        outputs.set(item.event.seq, event.seq)
        tracker.observe(session, event)
      }
      tracker.observe(session, session.append('tool/result', { turn: 1, step: 1,
        message: createToolResultMessage({ callId: rootId, content: [{ type: 'text', text: 'Exact private PTC source.' }], isError: false }) },
      { surfaceOp: 'append', sourceEventSeqs: [native.seq] }))
    }
    if (scenario === 'spill-pending') owner.beginNativeSpill({ call: rootLease.call, root: join(dir, 'opaque-spills'),
      hash: createHash('sha256').update('unknown result').digest('hex'), bytes: 14 })
    const detail = await owner.handleHost('readFile', { args: [created.identity] }) as HostMemoryApi['readFile']['output']
    assert.ok(detail)
    await owner.handleHost('forgetFile', { args: [{ operationId: randomUUID(), identity: created.identity, version: detail.version }] })
    await owner.close()
    const prefix = session.snapshotEvents(), inherited = SessionLogOffset(prefix.length), forkId = SessionId(randomUUID())
    const fork = Session.create(forkId, prefix, { ...session.header, id: forkId, isSeeded: true }, inherited)
    const context = new Context(), mounted = await context.plugin(jsonl, { root, compression: 'zstd' })
    try {
      for (const copy of [session, ...settled ? [fork] : []]) {
        const writer = await context.sessionPersistence.create(copy.header, { inheritedEventCount: copy === fork ? inherited : SessionLogOffset(0) })
        try { await writer.append(copy.snapshotEvents()); await writer.flush() } finally { await writer.close() }
      }
    } finally { await mounted.dispose() }
    if (scenario === 'missing-origin') {
      // A missing origin cannot establish physical absence from an unrelated catalog.
      const { rm } = await import('node:fs/promises')
      await rm(root, { recursive: true }); const { mkdir } = await import('node:fs/promises'); await mkdir(root)
    }
    const erase = () => eraseColdNativeCopies({ memoryRoot, sessionsRoot: root, storageRoot: join(dir, 'storages'), hostNamespace: 'viva',
      isCold: () => true, trace: { key: () => undefined, erase: () => {} } })
    await erase(); await erase()
    const admin = openNativeOriginalMaintenance(memoryRoot, 'viva')!
    try {
      const pending = admin.unsettledReceipts().tools
      if (scenario === 'spill-pending') assert.ok(pending.some(call => call.id === rootLease.call.id))
      else if (scenario === 'missing-origin') assert.equal(pending.length, 3)
      else assert.deepEqual(pending, [])
      assert.equal(admin.hasPlans(), scenario === 'spill-pending' || scenario === 'missing-origin',
        'the catalog receipt must reflect every tool and spill obligation')
    } finally { admin.close() }
    if (scenario === 'missing-origin' || scenario === 'spill-pending') return
    const verify = new Context(), install = await verify.plugin(jsonl, { root })
    try {
      for (const id of [session.id, ...settled ? [forkId] : []]) {
        const reader = await verify.sessionPersistence.open(id, 'read')
        try {
          const events = (await reader.read()).events
          assert.deepEqual(events[independent.event.seq], independent.event)
          const start = events[derived.event.seq]
          assert.equal(start?.type, 'tool/ptc-dispatch-start')
          assert.deepEqual(start.data.arguments, {})
          if (settled) {
            const output = events[outputs.get(derived.event.seq)!]
            assert.equal(output?.type, 'tool/ptc-dispatch')
            assert.deepEqual(output.data.arguments, {})
            assert.deepEqual(output.data.content, [])
            assert.equal(output.data.meta, undefined)
            assert.equal(output.data.error?.reason, undefined)
            assert.deepEqual(events[outputs.get(independent.event.seq)!], prefix[outputs.get(independent.event.seq)!])
          }

        } finally { await reader.close() }
      }
    } finally { await install.dispose() }
  })
}

test('PTC endpoint matching stays inside the original root execution even for invalid repeated IDs', () => {
  const session = Session.create(SessionId(randomUUID())), rootId = ToolCallId('root'), childId = ToolCallId('leaf')
  const root = session.append('tool/call', { turn: 1, step: 1, callId: rootId, name: 'run_code', arguments: '{}' })
  const start = session.append('tool/ptc-dispatch-start', { rootCallId: rootId, parentCallId: rootId, subCallId: childId, name: 'memory_read', arguments: {} })
  session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: rootId, content: [], isError: false }) },
    { surfaceOp: 'append', sourceEventSeqs: [root.seq] })
  session.append('step/end', { turn: 1, step: 1 }); session.append('step/start', { turn: 1, step: 2 })
  session.append('tool/call', { ...root.data, step: 2 })
  session.append('tool/ptc-dispatch-start', start.data)
  session.append('tool/ptc-dispatch', { ...start.data, isError: false, content: [{ type: 'text', text: 'unrelated late result' }] })
  const window = inspectPtcResultWindow(session.snapshotEvents(), { id: randomUUID(), session: String(session.id), callId: childId,
    generation: 0, turn: 1, step: 1, seq: start.seq, digest: nativeEventDigest(start), ptc: { rootCallId: rootId, parentCallId: rootId } })
  assert.ok(window)
  assert.deepEqual(window.results, [])
})

test('an interrupted ordinary memory tool has a cold no-output receipt after the full catalog proves absence', async t => {
  const { dir } = scratch(t, 'viva-native-no-output-'), memoryRoot = join(dir, 'memory'), root = join(dir, 'sessions')
  const owner = openMemoryOwner({ root: memoryRoot, hostNamespace: 'viva', fileMode: true,
    compute: () => null, route: () => null, quiesce: async () => {} })
  await owner.recover()
  const file = await owner.handleHost('createFile', { args: [{ operationId: randomUUID(), text: 'Unsettled ordinary file read.' }] }) as HostMemoryApi['createFile']['output']
  const session = Session.create(SessionId(randomUUID())), callId = ToolCallId('native-memory-read')
  owner.initializeSession({ sessionId: String(session.id), cwd: dir })
  session.append('turn/start', { turn: 1 }); session.append('step/start', { turn: 1, step: 1 })
  session.append('assistant/message', { turn: 1, step: 1, message: createAssistantMessage({ source: { provider: 'fixture', model: 'fixture' },
    content: [{ type: 'tool-call', id: callId, name: 'memory_read', arguments: '{}' }] }), stream: [] }, { surfaceOp: 'append' })
  const event = session.append('tool/call', { turn: 1, step: 1, callId, name: 'memory_read', arguments: '{}' })
  const call = { id: randomUUID(), session: String(session.id), callId, generation: 0, turn: 1, step: 1, seq: event.seq, digest: nativeEventDigest(event) }
  assert.match(owner.withNativeToolRead({ call, calls: [call], current: () => true }, () => owner.runtime.handle({ op: 'file_read', session: call.session, id: file.identity.id },
    owner.sessionContext(call.session))) ?? '', /Unsettled ordinary/u)
  const detail = await owner.handleHost('readFile', { args: [file.identity] }) as HostMemoryApi['readFile']['output']; assert.ok(detail)
  await owner.handleHost('forgetFile', { args: [{ operationId: randomUUID(), identity: file.identity, version: detail.version }] })
  await owner.close()
  const ctx = new Context(), mounted = await ctx.plugin(jsonl, { root, compression: 'zstd' })
  try {
    const writer = await ctx.sessionPersistence.create(session.header)
    try { await writer.append(session.snapshotEvents()); await writer.flush() } finally { await writer.close() }
  } finally { await mounted.dispose() }
  for (let i = 0; i < 2; i++) await eraseColdNativeCopies({ memoryRoot, sessionsRoot: root, storageRoot: join(dir, 'storages'), hostNamespace: 'viva',
    isCold: () => true, trace: { key: () => undefined, erase: () => {} } })
  const admin = openNativeOriginalMaintenance(memoryRoot, 'viva')!
  try {
    assert.deepEqual(admin.unsettledReceipts().tools, [])
    assert.equal(admin.hasPlans(), false, 'proven absence allows the native participant to finish')
  } finally { admin.close() }
})

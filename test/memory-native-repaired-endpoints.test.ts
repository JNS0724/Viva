import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { createAssistantMessage, createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { interruptedTurnClosers, Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import * as jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { openMemoryOwner } from '../src/memory/node/owner.ts'
import { openNativeOriginalMaintenance } from '../src/memory/node/native-original-maintenance.ts'
import type { HostMemoryApi } from '../src/memory/contracts/host.ts'
import { eraseColdNativeCopies } from '../plugins/memory/lib/native/maintenance.ts'
import { nativeEventDigest } from '../plugins/memory/lib/native/event-digest.ts'
import { scratch } from './fixtures/scratch.js'

test('cold parent repair preserves machine output while a fork retires known leaf and lost root endpoints', async t => {
  const { dir } = scratch(t, 'viva-repaired-endpoints-'), memoryRoot = join(dir, 'memory'), root = join(dir, 'sessions')
  const owner = openMemoryOwner({ root: memoryRoot, hostNamespace: 'viva',
    compute: () => null, route: () => null, quiesce: async () => {} })
  await owner.recover()
  const file = await owner.handleHost('createFile', { args: [{ operationId: randomUUID(), text: 'REPAIRED_PRIVATE source.' }] }) as HostMemoryApi['createFile']['output']
  const session = Session.create(SessionId(randomUUID())), rootId = ToolCallId('root'), leafId = ToolCallId('leaf')
  owner.initializeSession({ sessionId: String(session.id) })
  session.append('turn/start', { turn: 1 }); session.append('step/start', { turn: 1, step: 1 })
  session.append('assistant/message', { turn: 1, step: 1, message: createAssistantMessage({ source: { provider: 'fixture', model: 'fixture' },
    content: [{ type: 'tool-call', id: rootId, name: 'run_code', arguments: '{}' }] }), stream: [] }, { surfaceOp: 'append' })
  const begin = session.append('tool/call', { turn: 1, step: 1, callId: rootId, name: 'run_code', arguments: '{}' })
  const start = session.append('tool/ptc-dispatch-start', { rootCallId: rootId, parentCallId: rootId, subCallId: leafId,
    name: 'memory_read', arguments: { id: file.identity.id } })
  const parent = { id: randomUUID(), session: String(session.id), callId: rootId, generation: 0, turn: 1, step: 1, seq: begin.seq, digest: nativeEventDigest(begin) }
  const leaf = { ...parent, id: randomUUID(), callId: leafId, seq: start.seq, digest: nativeEventDigest(start), ptc: { rootCallId: rootId, parentCallId: rootId } }
  owner.withNativeToolRead({ call: leaf, calls: [leaf, parent], current: () => true, readCut: () => ({ seq: start.seq, digest: nativeEventDigest(start) }) }, () =>
    owner.runtime.handle({ op: 'file_read', session: session.id, id: file.identity.id }, owner.sessionContext(session.id)))
  const parentPrefix = session.snapshotEvents()
  const outcome = session.append('tool/ptc-dispatch', { ...start.data, isError: false, content: [{ type: 'text', text: 'REPAIRED_PRIVATE leaf.' }] })
  owner.finishNativeToolRead(leaf, { seq: outcome.seq, digest: nativeEventDigest(outcome) })
  const rootOutcome = session.append('tool/result', { turn: 1, step: 1,
    message: createToolResultMessage({ callId: rootId, isError: false, content: [{ type: 'text', text: 'REPAIRED_PRIVATE root.' }] }) },
  { surfaceOp: 'append', sourceEventSeqs: [begin.seq] })
  // Native root callback was lost; only the child flushed its complete prefix.
  const prefix = session.snapshotEvents(), inherited = SessionLogOffset(prefix.length), forkId = SessionId(randomUUID())
  const fork = Session.create(forkId, prefix, { ...session.header, id: forkId, isSeeded: true }, inherited)
  const context = new Context(), mounted = await context.plugin(jsonl, { root, compression: 'zstd' })
  let repaired = parentPrefix
  try {
    for (const copy of [session, fork]) {
      const writer = await context.sessionPersistence.create(copy.header, { inheritedEventCount: copy === fork ? inherited : SessionLogOffset(0) })
      try { await writer.append(copy === session ? parentPrefix : copy.snapshotEvents()); await writer.flush() } finally { await writer.close() }
    }
    const writer = await context.sessionPersistence.open(session.id, 'write')
    try {
      const durable = (await writer.read()).events
      repaired = Session.create(session.id, [...durable, ...interruptedTurnClosers(durable)], session.header).snapshotEvents()
      await writer.append(repaired.slice(durable.length)); await writer.flush()
    } finally { await writer.close() }
  } finally { await mounted.dispose() }
  const detail = await owner.handleHost('readFile', { args: [file.identity] }) as HostMemoryApi['readFile']['output']; assert.ok(detail)
  await owner.handleHost('forgetFile', { args: [{ operationId: randomUUID(), identity: file.identity, version: detail.version }] })
  await owner.close()
  for (let i = 0; i < 2; i++) await eraseColdNativeCopies({ memoryRoot, sessionsRoot: root, storageRoot: join(dir, 'storages'), hostNamespace: 'viva',
    isCold: () => true, trace: { key: () => undefined, erase: () => {} } })
  const admin = openNativeOriginalMaintenance(memoryRoot, 'viva')!
  try {
    assert.deepEqual(admin.unsettledReceipts().tools, [])
    assert.equal(admin.toolResultOperations().length, 0)
  } finally { admin.close() }
  const verify = new Context(), installed = await verify.plugin(jsonl, { root })
  try {
    for (const id of [session.id, fork.id]) {
      const reader = await verify.sessionPersistence.open(id, 'read')
      try {
        const events = (await reader.read()).events
        if (id === session.id) assert.deepEqual(events, repaired, 'the parent machine repair is preserved byte-for-byte')
        else {
          const child = events[outcome.seq], program = events[rootOutcome.seq]
          assert.equal(child?.type, 'tool/ptc-dispatch'); assert.deepEqual(child.data.content, [])
          assert.equal(program?.type, 'tool/result'); assert.deepEqual(program.data.message.content, [])
          assert.doesNotMatch(JSON.stringify(events), /REPAIRED_PRIVATE/u)
        }
      } finally { await reader.close() }
    }
  } finally { await installed.dispose() }
})

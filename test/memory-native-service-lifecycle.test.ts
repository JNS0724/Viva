import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { LocalSpillStore } from '@deepseek-ai/dsh-spill-local'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolExecution, ToolExecutionToken, ResolvedToolSet } from '@deepseek-ai/dsh-tools'
import { openMemoryOwner } from '../src/memory/node/owner.ts'
import { trackNativeToolReads } from '../plugins/memory/lib/native/tool-reads.ts'
import { trackNativeSpillReads } from '../plugins/memory/lib/native/read-spills.ts'
import { trackNativeSpills } from '../plugins/memory/lib/native/track-spills.ts'
import { scratch } from './fixtures/scratch.js'

test('captured memory service wrappers become inert on unload while later plugins and a reload still work', async t => {
  const { dir, defer } = scratch(t, 'viva-native-service-reload-'), root = join(dir, 'memory')
  const open = () => openMemoryOwner({ root, compute: () => null, route: () => null, quiesce: async () => {} })
  const owner = open(); defer(() => owner.close()); await owner.recover()
  const context = new Context()
  const filesystem = await context.plugin(LocalFileSystem, { cwd: dir }); defer(() => filesystem.dispose())
  const spillStore = await context.plugin(LocalSpillStore, { root: join(dir, 'spill'), cleanupPeriodDays: 0 }); defer(() => spillStore.dispose())
  const sessions = await context.plugin(SessionStore); defer(() => sessions.dispose())
  const session = context.sessions.create(SessionId('independent'))
  const tools: ResolvedToolSet = { dispose() {}, view: () => new Map() }, signal = new AbortController().signal
  const tracker = trackNativeToolReads(owner.finishNativeToolRead)
  tracker.assembly(session, signal, tools); tracker.step(session, 1, 1, signal)
  const callId = ToolCallId('independent-call')
  const exec: ToolExecution = { callId, rootCallId: callId, name: 'echo', arguments: {}, signal, toolSet: tools, token: Symbol() as ToolExecutionToken }
  tracker.observe(session, session.append('tool/call', { turn: 1, step: 1, callId, name: exec.name, arguments: '{}' }))
  tracker.bind(session, exec); assert.ok(tracker.acquire(session, exec, 0))
  const mount = (memory: typeof owner) => context.plugin({ inject: ['fs', 'spillStore', 'sessions'], apply(scoped: Context) {
    trackNativeSpillReads(scoped, memory, () => undefined)
    trackNativeSpills(scoped, memory, tracker)
  } })
  const guards = await mount(owner)
  const capturedRead = context.fs.readText, capturedSave = context.spillStore.saveText
  let outerReads = 0, outerSaves = 0
  const outerRead: typeof capturedRead = async (target, signal) => { outerReads++; return capturedRead.call(context.fs, target, signal) }
  const outerSave: typeof capturedSave = async input => { outerSaves++; return capturedSave.call(context.spillStore, input) }
  Object.defineProperty(context.fs, 'readText', { value: outerRead, configurable: true, writable: true })
  Object.defineProperty(context.spillStore, 'saveText', { value: outerSave, configurable: true, writable: true })
  await guards.dispose(); await owner.close()
  assert.equal(Object.getOwnPropertyDescriptor(context.fs, 'readText')?.value, outerRead)
  assert.equal(Object.getOwnPropertyDescriptor(context.spillStore, 'saveText')?.value, outerSave)
  const file = join(dir, 'independent.txt'); await writeFile(file, 'independent content')
  const target = await context.fs.resolve(file)
  assert.equal(await context.fs.readText(target), 'independent content', 'the later wrapper must never call a closed owner')
  const input = { owner: { sessionId: session.id }, source: { kind: 'tool' as const, toolName: 'echo', callId, label: 'result' },
    suggestedName: 'independent.txt', content: 'independent content' }
  assert.ok((await context.spillStore.saveText(input)).locator)
  const next = open(); defer(() => next.close()); await next.recover()
  let lookups = 0
  const candidates = next.nativeSpillCandidates
  t.mock.method(next, 'nativeSpillCandidates', () => { lookups++; return candidates() })
  const reloaded = await mount(next); defer(() => reloaded.dispose())
  assert.equal(await context.fs.readText(target), 'independent content')
  assert.equal(lookups, 1, 'only the current memory guard consults the owner')
  assert.ok((await context.spillStore.saveText(input)).locator)
  assert.equal(next.nativeSpillCandidates().length, 0, 'independent calls use the original store without duplicate memory receipts')
  assert.equal(outerReads, 2); assert.equal(outerSaves, 2)
})

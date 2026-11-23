import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { scratch } from './fixtures/scratch.js'
import { openMemoryOwner } from '../src/memory/node/owner.ts'
import type { MemoryFileDetail, MemoryFileListResult, MemoryFileMutationResult, MemoryFileSetEnabledRequest, MemoryManagedFileIdentity } from '../src/memory/contracts/file-management.ts'

async function fixture(t: TestContext) {
  const { dir, defer } = scratch(t, 'memory-daily-usage-')
  const at = Date.now()
  const session = randomUUID()
  const options = { root: dir, hostNamespace: 'viva-test', dailyNotes: { noteInterval: 1, timezone: 'UTC' },
    route: () => ({ provider: 'fake', model: 'fake' }), quiesce: async () => {},
    async compute(job: import('../src/memory/contracts/memory-contract.ts').MemoryCompute) {
      if (job.stage !== 'note') return '{"proposals":[]}'
      const input = JSON.parse(job.input) as { existing?: { markdown: string }, turns: { user: { text: string }[] }[] }
      return JSON.stringify({ status: 'write', title: input.turns[0]?.user[0]?.text ?? 'Daily note',
        markdown: [input.existing?.markdown, ...input.turns.flatMap(turn => turn.user.map(user => user.text.trim()))].filter(Boolean).join('\n') })
    },
  }
  let owner = openMemoryOwner(options)
  defer(() => owner.close())
  await owner.recover()
  let turn = 0
  async function add(text: string) {
    const messageId = randomUUID(), contextGeneration = owner.contextGeneration(session)
    turn++
    await owner.receiveSource({ sessionId: session, messageId, text, at, timezone: 'UTC', turn, step: 1,
      admitted: true, inherited: false, contextGeneration })
    await owner.completeTurn({ sessionId: session, turn, eventSeq: turn * 3, sourceIds: [messageId], assistant: '',
      completed: true, at, timezone: 'UTC', contextGeneration })
    await owner.runtime.wake()
    return { messageId, content: text }
  }
  async function find() {
    const list = await owner.handleHost('listFiles', { args: [{ kind: 'daily' }] }) as MemoryFileListResult
    assert.equal(list.items.length, 1)
    return detail(list.items[0]!.identity)
  }
  async function detail(identity: MemoryManagedFileIdentity) {
    const item = await owner.handleHost('readFile', { args: [identity] }) as MemoryFileDetail | null
    assert.ok(item)
    return item
  }
  const set = (input: MemoryFileSetEnabledRequest) => owner.handleHost('setFileEnabled', { args: [input] }) as Promise<MemoryFileMutationResult>
  return { get owner() { return owner }, add, find, detail, set,
    async reopen(dailyNotes: typeof options.dailyNotes | false = options.dailyNotes) {
      await owner.close(); owner = openMemoryOwner({ ...options, dailyNotes }); await owner.recover(); await owner.runtime.wake()
    } }
}

const stopInput = (file: MemoryFileDetail) => ({ operationId: randomUUID(), identity: file.identity, version: file.version, enabled: false })

test('a daily note keeps its contents and revisions across stop, restart and resume', async t => {
  const f = await fixture(t)
  const first = await f.add('The launch meeting is in the Greenwood room on Friday.')
  const initial = await f.find()
  const stop = stopInput(initial)
  const stopped = await f.set(stop)
  assert.equal(stopped.usageVersion, initial.version.usageVersion + 1)
  assert.equal(stopped.restrictionId, undefined)
  const disabled = await f.detail(initial.identity)
  assert.equal(disabled.enabled, false)
  assert.equal(disabled.markdown, initial.markdown)
  assert.equal(disabled.path, initial.path)
  assert.equal(f.owner.runtime.dispatchSourceCurrent(first.messageId), true)
  const session = randomUUID()
  const recall = () => f.owner.runtime.handle({ op: 'recall', session, query: 'Greenwood room' }, { session, conversation: session })
  assert.doesNotMatch(recall(), /Greenwood room/u)
  await f.reopen()
  assert.deepEqual(await f.set(stop), stopped)
  assert.equal((await f.detail(initial.identity)).enabled, false)
  const restored = await f.set({ operationId: randomUUID(), identity: initial.identity, version: disabled.version, enabled: true })
  assert.equal(restored.usageVersion, stopped.usageVersion + 1)
  assert.equal(restored.contentRevision, initial.version.contentRevision)
  assert.equal((await f.detail(initial.identity)).enabled, true)
  assert.match(recall(), /Greenwood room/u)
  await assert.rejects(f.set(stopInput(initial)), { code: 'revision.conflict' })
})

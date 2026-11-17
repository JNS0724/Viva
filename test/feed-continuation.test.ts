import assert from 'node:assert/strict'
import { test } from 'node:test'
import { admitFeedContinuation } from '../src/backend/feed-continuation.ts'
import { createAcpOperations } from '../src/backend/acp-operations.ts'
import { createAssistantStream } from '../src/backend/assistant-stream.ts'
import { sameContext } from '../src/shared/conversation-context.ts'
import { continueText } from '../src/shared/feed-continuation.ts'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

const item = { id: 'feed', source: 'schedule', key: 'run', title: 'Result', body: 'derived words', origin: { label: 'Schedule' },
  createdAt: 0, seenAt: null }
const memory = { sources: ['original'], turnOnly: false, epoch: 0 }

for (const phase of ['read', 'transfer', 'record'] as const) {
  for (const changed of ['session', 'conversation', 'bridge'] as const) {
    test(`feed admission rejects ${changed} changes while awaiting ${phase} and permits an explicit retry`, async () => {
      const origin = { conversationId: 'old-conversation', sessionId: 'old-session' }
      const bridge = {}
      let selected = origin, currentBridge = bridge
      const reached = deferred(), released = deferred()
      const transferred: string[] = [], recorded: string[] = [], prompts: string[] = []
      const current = () => currentBridge === bridge && sameContext(origin, selected)
      const pause = async (at: typeof phase) => {
        if (phase === at) { reached.resolve(); await released.promise }
      }
      const pending = admitFeedContinuation({
        text: continueText(item), current,
        read: async () => { await pause('read'); return { item, memory, current: () => true } },
        transfer: async () => { transferred.push(origin.sessionId); await pause('transfer'); return true },
        record: async () => { recorded.push(origin.sessionId); await pause('record') },
      }).then(held => { if (held()) prompts.push(selected.sessionId) })
      await reached.promise
      if (changed === 'bridge') currentBridge = {}
      else selected = { ...selected, [changed === 'session' ? 'sessionId' : 'conversationId']: 'new' }
      released.resolve()
      await assert.rejects(pending)
      assert.deepEqual(prompts, [])
      assert.ok([...transferred, ...recorded].every(session => session === origin.sessionId))
      assert.equal(recorded.length, phase === 'record' ? 1 : 0)

      const retryOrigin = selected, retryBridge = currentBridge
      const held = await admitFeedContinuation({
        text: continueText(item), current: () => currentBridge === retryBridge && sameContext(retryOrigin, selected),
        read: async () => ({ item, memory, current: () => true }),
        transfer: async () => { transferred.push(retryOrigin.sessionId); return true },
        record: async () => { recorded.push(retryOrigin.sessionId) },
      })
      assert.equal(held(), true)
      assert.equal(transferred.at(-1), retryOrigin.sessionId)
      assert.equal(recorded.at(-1), retryOrigin.sessionId)
    })
  }
}

test('the physical prompt rechecks the admitted feed recipient after asynchronous stream setup', async () => {
  let current = true
  const held = await admitFeedContinuation({ text: continueText(item), current: () => current,
    read: async () => ({ item, memory, current: () => true }), transfer: async () => true, record: async () => {} })
  const reached = deferred(), released = deferred(), wire: string[] = [], ends: string[] = []
  const streams = createAssistantStream({ emit() {}, send(message) {
    const action = message as { type: string, operation: string }
    if (action.type === 'assistant_stream_bind') streams.receive({ type: 'assistant_stream_bound', version: 1, operation: action.operation })
    else streams.receive({ type: 'assistant_stream_flushed', version: 1, operation: action.operation, messages: [], finalReply: false })
  } })
  streams.receive({ type: 'assistant_stream_ready', version: 1 })
  const operations = createAcpOperations({
    connection: () => ({ prompt: async request => { wire.push(request.sessionId); return { stopReason: 'end_turn' } }, cancel: async () => {} }),
    streams: { ...streams, begin: async session => { reached.resolve(); await released.promise; return streams.begin(session) } },
    cancelPermissions() {}, streamUpdate() {},
  })
  const pending = operations.run({ sessionId: 'old-session', prompt: [{ type: 'text', text: continueText(item) }], held,
    onEnd: response => { ends.push(response.stopReason) }, onError: error => assert.fail(String(error)) })
  await reached.promise
  current = false
  released.resolve()
  await pending
  assert.deepEqual(wire, [])
  assert.deepEqual(ends, ['cancelled'])
  operations.dispose()
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { createMessageJudge } from '../src/main/message-judge.ts'
import type { PrepareCall } from '../src/main/followup-channel.ts'

test('malformed judgment remains pending; a later valid negative judgment can finish it', async () => {
  const messages = [{ source: 'mail', id: 'm1', at: 1, receivedAt: 1, from: 'legal', title: '合同', text: '明天到期' }]
  const marked: string[] = []
  const events: string[] = []
  const calls: Array<Omit<PrepareCall, 'provider' | 'model'>> = []
  let response = '{"items":[{"id":"mail/m1","important":'
  const judge = createMessageJudge({
    sources: { unjudged: () => messages, oldestUnjudgedAt: () => 1,
      markJudged: items => { marked.push(...items.map(item => item.id)) } },
    store: { mutedSenders: () => new Set<string>(), recentDecisions: () => [],
      addSuggestion: () => { throw new Error('invalid or negative judgments must not make suggestions') },
      logEvent: kind => { events.push(kind) } },
    profile: () => null,
    prepareText: async call => { calls.push(call); return { ok: true, text: response } },
  })
  assert.deepEqual(await judge.run(new AbortController().signal), { ok: false, suggested: 0 })
  assert.deepEqual(marked, [], 'a broken response must not permanently consume the message')
  assert.ok(events.includes('judge_invalid'))
  assert.equal(calls[0].requireComplete, true, 'the plugin must reject token-limited responses before parsing')
  response = '{"items":[{"id":"mail/m1","important":false}]}'
  assert.deepEqual(await judge.run(new AbortController().signal), { ok: true, suggested: 0 })
  assert.deepEqual(marked, ['m1'])
  assert.equal(calls.length, 2, 'no hidden immediate retries outside the scheduler call budget')
})

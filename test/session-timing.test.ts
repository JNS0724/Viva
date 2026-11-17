import test from 'node:test'
import assert from 'node:assert/strict'
import type { SessionTiming } from '../src/backend/session-timing.ts'
import { sessionTiming } from '../src/backend/session-timing.ts'
import { installDiagnosticPort, withOperation } from '../src/diagnostics/node/context.ts'
import type { DiagnosticContext, DiagnosticEvent } from '../src/diagnostics/contracts.ts'

test('session timing records start before the native wait, inherits its parent, and preserves existing samples', async t => {
  const records: Array<{ event: DiagnosticEvent, context?: DiagnosticContext }> = []
  t.after(installDiagnosticPort({ emit(event, context) { records.push({ event, context }); return undefined } }))
  const samples: SessionTiming[] = []
  const measure = sessionTiming(sample => samples.push(sample))
  let release!: (value: number) => void
  const pending = withOperation('conversation.send', () => measure('session.acquire', () => new Promise<number>(resolve => { release = resolve }), 'SPECULATIVE_DETAIL_CANARY'))
  assert.deepEqual(records.map(record => record.event.event), ['operation.start', 'operation.start'])
  assert.equal(records[1]?.context?.parentSpanId, records[0]?.context?.spanId)
  assert.equal(records[1]?.context?.traceId, records[0]?.context?.traceId)
  release(42)
  assert.equal(await pending, 42)
  assert.equal(samples.length, 1)
  assert.equal(samples[0]?.ok, true)
  assert.equal(samples[0]?.detail, 'SPECULATIVE_DETAIL_CANARY')
  assert.equal(JSON.stringify(records).includes('SPECULATIVE_DETAIL_CANARY'), false)
  assert.equal(records.at(-1)?.event.outcome, 'completed')
})

test('a broken timing consumer or log sink cannot change the native value, error or cancellation', async t => {
  t.after(installDiagnosticPort({ emit() { throw new Error('failed diagnostic sink') } }))
  const measure = sessionTiming(() => { throw new Error('failed timing consumer') })
  assert.equal(await measure('session.open', async () => 42), 42)
  const failure = new Error('original native failure')
  await assert.rejects(measure('session.open', () => Promise.reject(failure)), error => error === failure)
  const cancelled = new DOMException('private cancellation text', 'AbortError')
  await assert.rejects(measure('session.resume', () => Promise.reject(cancelled)), error => error === cancelled)
})

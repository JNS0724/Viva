import assert from 'node:assert/strict'
import { test } from 'node:test'
import { beginMemoryWebSession, submitMemoryWebMessage, type MemoryWebComposerSnapshot } from '../scripts/memory-plugin-browser.ts'

const fact = '萤火读书会正在比较北馆和南馆两处场地，还没有决定。'
const old: MemoryWebComposerSnapshot = { sessionKey: 'session:old', blank: false, editable: true, text: '' }

function transition() {
  let snapshot = old, started = false, resolve = () => {}, waiting = () => {}
  const pending = new Promise<void>(done => { resolve = done })
  const observed = new Promise<void>(done => { waiting = done })
  let check: (() => Promise<boolean>) | undefined
  const opening = beginMemoryWebSession({
    read: async () => snapshot,
    create: async () => { started = true },
    async wait(current) { check = current; const ready = await current(); waiting(); if (!ready) await pending },
  })
  void opening.then(waiting, waiting)
  return {
    opening, observed, started: () => started,
    async advance(next: MemoryWebComposerSnapshot) {
      snapshot = next
      assert.ok(check)
      if (await check()) resolve()
    },
  }
}

test('packed Web waits for the new selected session before typing into the resident editor', async () => {
  const state = transition(), sent: string[] = []
  let typed = ''
  const delivered = state.opening.then(async () => {
    typed = fact
    await submitMemoryWebMessage(fact, { read: async () => typed, submit: async () => { sent.push(typed) } })
  })
  await state.observed
  assert.equal(state.started(), true)
  assert.equal(old.editable, true, 'the old visible editor is already editable during native creation')
  assert.equal(typed, '', 'new-session creation must finish before the first two characters can enter the old binding')
  await state.advance({ ...old, blank: true })
  assert.equal(typed, '', 'a blank-looking surface with the old row identity is insufficient')
  await state.advance({ ...old, sessionKey: 'session:new', blank: true })
  await delivered
  assert.deepEqual(sent, [fact])
})

test('the new Web row must also have its blank editable draft before accepting input', async () => {
  const state = transition()
  let ready = false
  const opening = state.opening.then(() => { ready = true })
  await state.observed
  for (const sessionKey of ['workspace:new', 'overflow:new']) {
    await state.advance({ ...old, sessionKey, blank: true })
    assert.equal(ready, false, 'another tree-row identity must not become a selected native session')
  }
  await state.advance({ ...old, sessionKey: 'session:new' })
  assert.equal(ready, false, 'the selected row can update before the blank conversation view')
  await state.advance({ ...old, sessionKey: 'session:new', blank: true, editable: false })
  assert.equal(ready, false)
  await state.advance({ ...old, sessionKey: 'session:new', blank: true, text: '萤火' })
  assert.equal(ready, false, 'the previous binding draft must not be submitted as the new session')
  await state.advance({ ...old, sessionKey: 'session:new', blank: true })
  await opening
  assert.equal(ready, true)
})

test('a truncated Web draft fails before Send without repairing the original or weakening expected text', async () => {
  const draft = fact.slice(2), sent: string[] = []
  await assert.rejects(submitMemoryWebMessage(fact, { read: async () => draft, submit: async () => { sent.push(draft) } }),
    /exact synthetic input/u)
  assert.deepEqual(sent, [])
  assert.equal(draft, '读书会正在比较北馆和南馆两处场地，还没有决定。')
})

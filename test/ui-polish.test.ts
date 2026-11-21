import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialState, reduce } from './fixtures/task-window.ts'
import { initialRewind } from '../src/renderer/rewind-state.ts'
import { threadState } from '../src/renderer/view/tasks-page.ts'
import { composedInput, keepingInput } from '../src/renderer/view/dom.ts'

test('background task thread view isolates rewind state from the foreground conversation', () => {
  const ready = reduce(initialState, { type: 'ready', info: { ...initialState.info, conversationId: 'seg-1' } })
  const withPrompt = reduce(ready, { type: 'user_prompt', text: '前景问题', at: 1 })
  const answered = reduce(withPrompt, { type: 'turn_end', stopReason: 'end_turn', at: 2 })
  const editing = reduce(answered, { type: 'rewind_edit', id: 'm0' })
  assert.equal(editing.rewind.editing, 'm0')

  const started = reduce(editing, {
    type: 'task_started', at: 3, text: '后台整理',
    task: { id: 't1', segmentId: 'seg-task', title: '后台整理', words: '后台整理' },
  })
  const task = started.tasks.list[0]!
  const scoped = threadState(started, task)
  assert.equal(scoped.rewind, initialRewind)
  assert.equal(scoped.rewind.editing, null)
})

test('composedInput ignores unconfirmed IME input and fires once on compositionend', () => {
  const seen: string[] = []
  const handlers = composedInput((value) => seen.push(value))
  const currentTarget = { value: 'ni' } as unknown as HTMLInputElement

  handlers.onInput({ isComposing: true, currentTarget } as unknown as Event)
  assert.deepEqual(seen, [])

  currentTarget.value = '你好'
  handlers.onCompositionEnd({ currentTarget } as unknown as Event)
  assert.deepEqual(seen, ['你好'])

  currentTarget.value = '你好世界'
  handlers.onInput({ isComposing: false, currentTarget } as unknown as Event)
  assert.deepEqual(seen, ['你好', '你好世界'])
})

test('keepingInput defers container rebuilds while an active child input is composing IME text', async () => {
  const listeners = new Map<string, () => void>()
  let activeField: unknown = null
  const field = { name: 'skill-search', value: 'ni', dataset: {} as Record<string, string>, selectionStart: 2, selectionEnd: 2, focus() {} }
  activeField = field
  const previousDocument = (globalThis as { document?: unknown }).document
  const previousCss = (globalThis as { CSS?: unknown }).CSS
  ;(globalThis as { document?: unknown }).document = { get activeElement() { return activeField } }
  ;(globalThis as { CSS?: unknown }).CSS = { escape: (value: string) => value }

  try {
    let rebuilds = 0
    const container = {
      isConnected: true,
      addEventListener(type: string, cb: () => void) { listeners.set(type, cb) },
      contains(target: unknown) { return target === field },
      querySelectorAll() { return [field] },
      querySelector() { return field },
    } as unknown as HTMLElement

    keepingInput(container, () => { rebuilds += 1 })
    assert.equal(rebuilds, 1)

    listeners.get('compositionstart')?.()
    keepingInput(container, () => { rebuilds += 1 })
    keepingInput(container, () => { rebuilds += 10 })
    assert.equal(rebuilds, 1, 'no DOM replacement while composing')

    field.value = '你好'
    listeners.get('compositionend')?.()
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(rebuilds, 11, 'only the latest deferred rebuild runs after composition ends')
  } finally {
    ;(globalThis as { document?: unknown }).document = previousDocument
    ;(globalThis as { CSS?: unknown }).CSS = previousCss
  }
})

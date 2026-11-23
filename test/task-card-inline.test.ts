import { test } from 'node:test'
import assert from 'node:assert/strict'
import { taskCard } from '../src/renderer/view/task-card.ts'

/** Minimal DOM shim for testing taskCard() node structure and button callbacks in Node. */
class FakeElement {
  tagName: string
  className = ''
  textContent = ''
  title = ''
  type = ''
  attrs: Record<string, string> = {}
  listeners: Record<string, Array<() => void>> = {}
  children: Array<FakeElement | string> = []
  constructor(tag: string) { this.tagName = tag.toUpperCase() }
  setAttribute(name: string, value: string) {
    this.attrs[name] = value
    if (name === 'class') this.className = value
  }
  addEventListener(type: string, fn: () => void) {
    this.listeners[type] = [...(this.listeners[type] ?? []), fn]
  }
  append(...nodes: Array<FakeElement | string>) {
    for (const node of nodes) this.children.push(node)
  }
  click() {
    for (const fn of this.listeners.click ?? []) fn()
  }
}

function withFakeDom<T>(run: () => T): T {
  const prevDoc = (globalThis as { document?: unknown }).document
  const prevNode = (globalThis as { Node?: unknown }).Node
  ;(globalThis as { document?: unknown }).document = {
    createElement: (tag: string) => new FakeElement(tag),
    createTextNode: (text: string) => text,
  }
  ;(globalThis as { Node?: unknown }).Node = FakeElement
  try { return run() }
  finally {
    if (prevDoc === undefined) delete (globalThis as { document?: unknown }).document
    else (globalThis as { document?: unknown }).document = prevDoc
    if (prevNode === undefined) delete (globalThis as { Node?: unknown }).Node
    else (globalThis as { Node?: unknown }).Node = prevNode
  }
}

const baseView = {
  messages: [], thoughts: [], tools: {}, modelCalls: {}, timeline: [],
  permission: null, question: null, secret: null, turn: null, phase: 'idle' as const,
  usage: null, stopUnconfirmed: false, stoppedReplayLost: false, lastReceipt: null,
  doneNotice: 'fresh' as const, completedTurn: null, error: null,
}

test('waiting task cards keep a single anchor and interrupted tasks keep their recovery actions', () => {
  withFakeDom(() => {
    const calls: Array<{ fn: string, args: unknown[] }> = []
    const handlers = {
      openTasks: (id: string) => calls.push({ fn: 'openTasks', args: [id] }),
      respond: (req: string, opt: string) => calls.push({ fn: 'respond', args: [req, opt] }),
      pickTaskOption: (id: string, qid: string, label: string) => calls.push({ fn: 'pickTaskOption', args: [id, qid, label] }),
      skipTaskQuestion: (id: string) => calls.push({ fn: 'skipTaskQuestion', args: [id] }),
      resumeTask: (id: string) => calls.push({ fn: 'resumeTask', args: [id] }),
      closeTask: (id: string) => calls.push({ fn: 'closeTask', args: [id] }),
    }

    // 1. Running task -> single button, no inline strip.
    const running = taskCard({ id: 't-run', title: '整理', status: 'running', startedAt: 100, endedAt: null, view: baseView }, handlers, 120)
    assert.equal(Array.isArray(running), false)
    assert.equal((running as unknown as FakeElement).className, 'task-line task-card')

    const waitingPerm = taskCard({
      id: 't-perm', title: '跑脚本', status: 'waiting', startedAt: 100, endedAt: null,
      permission: { requestId: 'req-1', title: '运行命令', options: [{ optionId: 'allow_once', name: '允许本次', kind: 'allow_once' }] },
      view: baseView,
    }, handlers, 120) as unknown as FakeElement
    assert.equal(waitingPerm.className, 'task-line task-card')
    waitingPerm.click()
    assert.deepEqual(calls, [{ fn: 'openTasks', args: ['t-perm'] }])

    // 3. Waiting permission with empty options (smoke-task-card fixture) -> single button.
    const emptyPerm = taskCard({
      id: 't-perm-empty', title: '确认', status: 'waiting', startedAt: 100, endedAt: null,
      permission: { requestId: 'req-2', title: '检查输出', options: [] },
      view: baseView,
    }, handlers, 120)
    assert.equal(Array.isArray(emptyPerm), false)

    const singleQ = taskCard({
      id: 't-q1', title: '部署', status: 'waiting', startedAt: 100, endedAt: null,
      question: {
        questionId: 'q-1',
        questions: [{ id: 'env', question: '请选择本次要部署的目标环境', multiSelect: false, options: [{ label: 'staging' }, { label: 'prod' }] }],
      },
      view: baseView,
    }, handlers, 120)
    assert.equal(Array.isArray(singleQ), false)

    // 5. Waiting multi-select question -> single button (handled on 后台 page).
    const multiQ = taskCard({
      id: 't-qm', title: '多选', status: 'waiting', startedAt: 100, endedAt: null,
      question: {
        questionId: 'q-m',
        questions: [{ id: 'env', question: '选环境', multiSelect: true, options: [{ label: 'a' }, { label: 'b' }] }],
      },
      view: baseView,
    }, handlers, 120)
    assert.equal(Array.isArray(multiQ), false)

    // 6. Interrupted task -> [button, inlineDiv] with Resume + Close.
    calls.length = 0
    const interrupted = taskCard({
      id: 't-int', title: '断线任务', status: 'interrupted', startedAt: 100, endedAt: 110, view: baseView,
    }, handlers, 120) as unknown as [FakeElement, FakeElement]
    assert.equal(Array.isArray(interrupted), true)
    assert.equal(interrupted[1].attrs['data-kind'], 'interrupted')
    const [intActions] = interrupted[1].children as [FakeElement]
    const [resumeBtn, closeBtn] = intActions.children as FakeElement[]
    assert.ok(resumeBtn.className.includes('btn-primary'))
    resumeBtn.click()
    closeBtn.click()
    assert.deepEqual(calls, [
      { fn: 'resumeTask', args: ['t-int'] },
      { fn: 'closeTask', args: ['t-int'] },
    ])
  })
})

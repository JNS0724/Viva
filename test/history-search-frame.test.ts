import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mountHistorySearchFrame } from '../src/renderer/history-search-frame.ts'

for (const outcome of ['loaded', 'loaded-composing', 'error', 'wrong-document', 'timeout'] as const) {
  test(`search frame ${outcome}: keeps the original field, focus and fallback available`, async (t) => {
    const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
    const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
    t.mock.method(console, 'warn', () => {})
    let focused = 0
    let restored = false
    let removed = false
    let adopted: unknown
    let selection: unknown
    let expire: (() => void) | undefined
    const classes = new Set<string>()
    const host = Object.assign(new EventTarget(), { classList: { add: (value: string) => classes.add(value), remove: (value: string) => classes.delete(value) }, insertBefore: (_node: unknown, _next: unknown) => {} })
    const owner = { activeElement: null as unknown }
    const input = Object.assign(new EventTarget(), {
      parentElement: host, nextSibling: null, ownerDocument: owner,
      selectionStart: 1, selectionEnd: 4,
      focus() { focused++ },
      setSelectionRange(start: number | null, end: number | null) { selection = [start, end] },
    })
    owner.activeElement = input
    const fonts = { dataset: { fontHref: 'https://fonts.googleapis.com/css2' }, href: '' }
    const child = {
      querySelector() { assert.equal(adopted, input); return fonts },
      documentElement: { dataset: { historySearchFrame: outcome === 'wrong-document' ? undefined : 'true' } },
      body: { append(node: unknown) { adopted = node } },
    }
    const frame = Object.assign(new EventTarget(), {
      id: '', className: '', title: '', src: '',
      sandbox: new Set<string>(), contentDocument: child,
      remove() { removed = true },
    })
    host.insertBefore = (node) => {
      if (node === frame) queueMicrotask(() => {
        if (outcome === 'timeout') expire?.()
        else {
          if (outcome === 'loaded-composing') input.dispatchEvent(new Event('compositionstart'))
          frame.dispatchEvent(new Event(outcome === 'error' ? 'error' : 'load'))
        }
      })
      else { assert.equal(node, input); restored = true }
    }
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => frame } })
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {
      setTimeout(callback: () => void, delay: number) {
        assert.equal(delay, 5000)
        if (outcome === 'timeout') { expire = callback; return 0 }
        return setTimeout(callback, delay)
      },
      clearTimeout,
    } })
    try {
      const mounting = mountHistorySearchFrame(input as unknown as HTMLInputElement)
      if (outcome === 'loaded-composing') {
        await new Promise(resolve => setImmediate(resolve))
        assert.equal(adopted, undefined, 'A composing field must stay in its original document')
        input.dispatchEvent(new Event('compositionend'))
      }
      const result = await mounting
      assert.deepEqual([...frame.sandbox], ['allow-same-origin'])
      if (outcome === 'loaded' || outcome === 'loaded-composing') {
        assert.equal(result, child)
        assert.equal(adopted, input)
        assert.deepEqual(selection, [1, 4])
        assert.equal(focused, 1)
        assert.equal(removed, false)
        assert.equal(fonts.href, fonts.dataset.fontHref)
        input.dispatchEvent(new Event('focus'))
        assert.equal(classes.has('search-focused'), true)
        input.dispatchEvent(new Event('blur'))
        assert.equal(classes.has('search-focused'), false)
      } else {
        assert.equal(result, null)
        assert.equal(adopted, undefined)
        assert.equal(fonts.href, '')
        assert.equal(restored, false, 'An unmoved fallback must not be reinserted and lose focus')
        assert.equal(removed, true)
        if (outcome === 'timeout') {
          // A late load must not adopt the usable fallback field into a detached frame.
          frame.dispatchEvent(new Event('load'))
          await Promise.resolve()
          assert.equal(adopted, undefined)
          assert.equal(input.parentElement, host)
        }
      }
      const before = focused
      host.dispatchEvent(new Event('click'))
      assert.equal(focused, before + 1)
    } finally {
      if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument)
      else Reflect.deleteProperty(globalThis, 'document')
      if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow)
      else Reflect.deleteProperty(globalThis, 'window')
    }
  })
}

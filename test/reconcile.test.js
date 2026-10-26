import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLayoutQueue, reconcileChildren } from '../src/renderer/view/reconcile.ts'

function parentWith(...nodes) {
  const parent = { nodes, writes: 0,
    get firstChild() { return this.nodes[0] ?? null },
    insertBefore(node, before) {
      this.writes++
      this.nodes = this.nodes.filter(n => n !== node)
      this.nodes.splice(before === null ? this.nodes.length : this.nodes.indexOf(before), 0, node)
    },
    removeChild(node) { this.writes++; this.nodes.splice(this.nodes.indexOf(node), 1) },
  }
  for (const node of nodes) Object.defineProperty(node, 'nextSibling', { get() { return parent.nodes[parent.nodes.indexOf(this) + 1] ?? null } })
  return parent
}

test('unchanged messages stay attached; appending or removing touches only the changed nodes', () => {
  const a = {}, b = {}, c = {}
  const p = parentWith(a, b, c)
  assert.equal(reconcileChildren(p, [a, b, c]), false)
  assert.equal(p.writes, 0)
  assert.equal(reconcileChildren(p, [a, c]), true)
  assert.deepEqual(p.nodes, [a, c])
  assert.equal(p.writes, 1)
  reconcileChildren(p, [a, b, c])
  assert.deepEqual(p.nodes, [a, b, c])
  assert.equal(p.writes, 2)
  reconcileChildren(p, [c, a, b])
  assert.deepEqual(p.nodes, [c, a, b])
  assert.equal(p.writes, 3)
})

test('layout work coalesces to the latest state and work queued during a flush uses the next frame', () => {
  const frames = [], seen = [], a = {}, b = {}
  const queue = createLayoutQueue(run => frames.push(run))
  queue(a, () => seen.push('stale'))
  queue(a, () => { seen.push('latest'); queue(a, () => seen.push('next')) })
  queue(b, () => seen.push('other'))
  assert.equal(frames.length, 1)
  frames.shift()()
  assert.deepEqual(seen, ['latest', 'other'])
  frames.shift()()
  assert.deepEqual(seen, ['latest', 'other', 'next'])
})

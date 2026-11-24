import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { ownerClient } from './fixtures/memory-owner-client.ts'
import { openMemoryOwner } from '../src/memory/node/owner.ts'
import { scratch } from './fixtures/scratch.js'

function open(root: string) {
  return openMemoryOwner({ root, compute: () => null, route: () => null })
}

test('Viva file client preserves durable create and edit receipts after owner restart', async t => {
  const { dir, defer } = scratch(t, 'memory-client-')
  const root = path.join(dir, 'owner')
  let owner = open(root)
  defer(() => owner.close())
  await owner.recover()
  let client = ownerClient(owner)
  const input = { operationId: randomUUID(), text: '回答先给结论，再给依据。' }
  const created = await client.createFile(input)
  assert.deepEqual(await client.createFile(input), created)
  await assert.rejects(client.createFile({ ...input, text: '不同正文不能复用操作。' }), /重复|不同|标识|操作|conflict|different input/i)
  await owner.close()
  owner = open(root)
  await owner.recover()
  client = ownerClient(owner)
  assert.deepEqual(await client.createFile(input), created)
  const before = await client.readFile(created.identity)
  assert.ok(before)
  const edit = { operationId: randomUUID(), identity: created.identity, version: before.version, text: '回答先给结论，再给来源依据。' }
  const updated = await client.editFile(edit)
  assert.deepEqual(await client.editFile(edit), updated)
  await assert.rejects(client.editFile({ ...edit, operationId: randomUUID() }), /变化|改变|更新|刷新|revision|refresh/i)
  assert.ok((await client.readFile(created.identity))?.markdown.includes(edit.text))
})

test('Viva profile receipts are replayable and old numeric fact methods are absent', async t => {
  const { dir, defer } = scratch(t, 'memory-client-profile-')
  const root = path.join(dir, 'owner')
  let owner = open(root)
  defer(() => owner.close())
  await owner.recover()
  let client = ownerClient(owner)
  const operation = randomUUID()
  const profile = await client.setProfile({ role: '后端负责人' }, operation)
  assert.deepEqual(await client.setProfile({ role: '后端负责人' }, operation), profile)
  await owner.close()
  owner = open(root)
  await owner.recover()
  client = ownerClient(owner)
  assert.deepEqual(await client.setProfile({ role: '后端负责人' }, operation), profile)
  await assert.rejects(client.setProfile({ role: '不同角色' }, operation), /conflict|different input/i)
  for (const method of ['listMemories', 'addMemory', 'editMemory', 'stopMemory', 'restoreMemory', 'deleteMemory', 'resolveConflictPair', 'undoChange']) {
    assert.equal(Object.hasOwn(client, method), false)
    await assert.rejects(owner.handleHost(method, { args: [] }), /Unknown memory host method/)
  }
})

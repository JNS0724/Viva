import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { scratch } from './fixtures/scratch.js'
import { openMemoryOwner } from '../src/memory/node/owner.ts'

test('standalone explicit file commands use the native session scope, versions and durable owner receipts', async t => {
  const { dir, defer } = scratch(t, 'viva-memory-commands-')
  const cwd = (name: string) => {
    const workspace = join(dir, name), git = join(workspace, '.git')
    mkdirSync(join(git, 'objects'), { recursive: true })
    writeFileSync(join(git, 'HEAD'), 'ref: refs/heads/main\n')
    return workspace
  }
  const options = { root: join(dir, 'memory'), fileMode: true, compute: () => null, route: () => null, quiesce: async () => {} }
  let owner = openMemoryOwner(options)
  defer(() => owner.close())
  await owner.recover()
  const session = 'project-one', neighbor = 'project-two', personal = 'personal'
  owner.initializeSession({ sessionId: session, cwd: cwd('one') })
  owner.initializeSession({ sessionId: neighbor, cwd: cwd('two') })
  owner.initializeSession({ sessionId: personal, cwd: dir })
  const method = (current: string, id: string) => owner.runtime.handle({ op: 'file_read', session: current, id }, owner.sessionContext(current))
  const input = { operationId: randomUUID(), text: 'Project-only release notes stay with the rollout.' }
  const written = await owner.rememberStandaloneFile(session, input)
  assert.deepEqual(await owner.rememberStandaloneFile(session, input), written)
  await assert.rejects(owner.rememberStandaloneFile(neighbor, input), { code: 'operation.conflict' })
  assert.throws(() => owner.rememberStandaloneFile('unregistered', { ...input, operationId: randomUUID() }), { code: 'not.found' })
  assert.ok(method(session, written.identity.id).includes(input.text))
  assert.ok(!method(personal, written.identity.id).includes(input.text))
  await assert.rejects(owner.forgetStandaloneFile(neighbor, written.identity.id, randomUUID()), { code: 'not.found' })
  assert.ok(owner.runtime.readFile(written.identity))
  const operationId = randomUUID()
  assert.equal(await owner.forgetStandaloneFile(session, written.identity.id, operationId), 'pending')
  assert.equal(owner.runtime.readFile(written.identity), null)
  assert.equal(owner.runtime.listMemories().total, 0)
  await owner.close()
  owner = openMemoryOwner(options)
  await owner.recover()
  const retry = await owner.forgetStandaloneFile(session, written.identity.id, operationId)
  assert.ok(retry === 'pending' || retry === 'complete')
  await assert.rejects(owner.forgetStandaloneFile(neighbor, written.identity.id, operationId), { code: 'operation.conflict' })
  assert.equal(owner.runtime.readFile(written.identity), null)
  assert.equal(owner.runtime.listMemories().total, 0)
})

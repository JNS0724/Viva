import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createConfigActions } from '../src/backend/config-actions.ts'
import { createMcpConfigStore } from '../src/backend/mcp-config.ts'
import { createEnvelope } from '../src/backend/envelope.ts'
import { skillRoots } from '../src/backend/skills.ts'
import { userDshHome, type ImportResult } from '../src/backend/dsh-mcp-import.ts'
import type { ServerSpec, ServerUpdate } from '../src/backend/config-channel.ts'

function harness(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viva-config-actions-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'mcp.json')
  const store = createMcpConfigStore({ file, crypto: createEnvelope({ key: Buffer.alloc(32, 7) }) })
  let changes = 0
  let imported: ImportResult = { dir, added: [], skipped: [], problems: [] }
  const remembered: string[] = [], imports: string[] = []
  const actions = createConfigActions({
    store, roots: () => skillRoots({ dshHome: dir, cwd: dir }),
    onMcpChange: () => { changes++ }, rememberDshDir: value => { remembered.push(value) },
    importDsh: async value => { imports.push(value); return imported },
    trash: async file => { fs.renameSync(file, path.join(dir, 'trashed-' + path.basename(file))) },
  })
  return { actions, dir, store, file, changes: () => changes, remembered, imports,
    imported: (result: ImportResult) => { imported = result } }
}
const spec: ServerSpec = { name: 'mail', command: 'mail-mcp', args: ['--stdio'], url: '', secrets: ['TOKEN'] }
const update: ServerUpdate = { name: 'mail', newName: 'mail-new', command: '', args: null, url: '', secrets: [] }

test('preparing a card validates without storing credentials or scheduling a reload', t => {
  const h = harness(t)
  h.actions.prepareServer(spec)
  assert.deepEqual(h.store.list(), []); assert.equal(h.changes(), 0)
  assert.equal(fs.existsSync(h.file), false)
  assert.throws(() => h.actions.prepareServer({ ...spec, name: '' }))
  assert.equal(h.changes(), 0)
})

test('approved add, rename and remove share the encrypted store and notify only after success', t => {
  const h = harness(t)
  h.actions.addServer(spec, { TOKEN: 'test-secret' })
  assert.equal(h.store.list()[0].env.TOKEN, 'test-secret')
  assert.equal(fs.readFileSync(h.file, 'utf8').includes('test-secret'), false)
  assert.equal(h.changes(), 1)
  assert.equal(h.actions.listServers().join().includes('test-secret'), false)
  h.actions.prepareUpdate(update)
  assert.equal(h.changes(), 1); assert.equal(h.store.list()[0].name, 'mail')
  h.actions.updateServer(update, {})
  assert.equal(h.store.list()[0].name, 'mail-new')
  assert.equal(h.store.list()[0].env.TOKEN, 'test-secret', 'rename must keep existing keys')
  assert.equal(h.changes(), 2)
  assert.throws(() => h.actions.updateServer(update, {}))
  assert.throws(() => h.actions.removeServer('missing'))
  assert.equal(h.changes(), 2)
  h.actions.removeServer('mail-new')
  assert.deepEqual(h.store.list(), []); assert.equal(h.changes(), 3)
})

test('imports remember a custom folder and request a reload only when a server was added', async t => {
  const h = harness(t)
  await h.actions.importServers(h.dir)
  assert.deepEqual(h.remembered, [h.dir]); assert.equal(h.changes(), 0)
  h.imported({ dir: h.dir, added: [{ name: 'new', missing: [] }], skipped: [], problems: [] })
  await h.actions.importServers('')
  assert.equal(h.imports[1], userDshHome())
  assert.deepEqual(h.remembered, [h.dir]); assert.equal(h.changes(), 1)
})

test('skills use the managed root and removal goes through the supplied trash capability', async t => {
  const h = harness(t)
  h.actions.createSkill({ name: 'weekly', description: 'Weekly report', instructions: 'Summarise the week.' })
  const rows = h.actions.listSkills()
  assert.equal(rows.length, 1); assert.match(rows[0], /Weekly report/)
  const id = rows[0].split('：')[0]
  await h.actions.removeSkill(id)
  assert.equal(h.actions.listSkills().length, 0)
  assert.equal(h.changes(), 0, 'skills are watched by dsh and need no MCP reattach')
})

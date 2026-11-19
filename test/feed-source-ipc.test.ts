import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { checkedIpc } from '../src/shared/ipc-contract.ts'
import { openFeedSourceStore } from '../src/backend/feed-source-store.ts'
import { registerFeedSourceIpc } from '../src/backend/feed-source-ipc.ts'

test('feed-sources IPC validates arguments through ipc-contract and handles full CRUD + run-now', async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const rawIpc = {
    handle: (channel: string, listener: (...args: unknown[]) => unknown) => { handlers.set(channel, listener) },
    on: () => {},
  }
  const store = openFeedSourceStore({ db: new DatabaseSync(':memory:'), now: () => Date.parse('2026-11-19T12:00:00+08:00'), newId: () => 'fs1' })
  let changes = 0
  let ranId: string | null = null

  registerFeedSourceIpc(checkedIpc(rawIpc), {
    store: () => store,
    cwd: () => '/work',
    validatePlugin: async (name) => name === '@company/dsh-plugin-mail'
      ? { ok: true }
      : { ok: false, reason: `插件 ${name} 未声明允许数据源调用的只读工具。` },
    changed: () => { changes += 1 },
    runNow: async (id) => {
      ranId = id
      const view = (await handlers.get('feed-sources:list')!({})) as Array<{ id: string }>
      return { status: 'skipped', publishedCount: 0, message: '无新内容', source: view[0] as never }
    },
  })

  const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args)

  await assert.rejects(
    async () => invoke('feed-sources:create', {
      pluginName: '@company/dsh-plugin-unsupported',
      instruction: '查内容',
      schedule: { kind: 'interval', minutes: 30, timeZone: 'Asia/Shanghai' },
    }),
    /未声明允许数据源调用的只读工具/,
  )
  assert.deepEqual(await invoke('feed-sources:list'), [])

  const created = await invoke('feed-sources:create', {
    pluginName: '@company/dsh-plugin-mail',
    name: '紧急邮件',
    instruction: '查紧急邮件',
    schedule: { kind: 'interval', minutes: 30, timeZone: 'Asia/Shanghai' },
  }) as { id: string, name: string, status: string }
  assert.equal(created.id, 'fs1')
  assert.equal(created.name, '紧急邮件')
  assert.equal(changes, 1)

  const listed = await invoke('feed-sources:list') as Array<{ id: string }>
  assert.equal(listed.length, 1)

  const updated = await invoke('feed-sources:update', 'fs1', { name: '紧急客户邮件' }) as { name: string }
  assert.equal(updated.name, '紧急客户邮件')

  const paused = await invoke('feed-sources:pause', 'fs1', true) as { status: string }
  assert.equal(paused.status, 'paused')

  const runResult = await invoke('feed-sources:run-now', 'fs1') as { status: string }
  assert.equal(ranId, 'fs1')
  assert.equal(runResult.status, 'skipped')

  const deleted = await invoke('feed-sources:delete', 'fs1') as { deleted: boolean }
  assert.equal(deleted.deleted, true)
  assert.deepEqual(await invoke('feed-sources:list'), [])
})

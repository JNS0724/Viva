import test from 'node:test'
import assert from 'node:assert/strict'
import type { BrowserWindow } from 'electron'
import { checkedIpc, type RawIpc } from '../src/shared/ipc-contract.ts'
import type { DraftSnapshot } from '../src/shared/composer-draft.ts'
import { registerIslandIpc } from '../src/shell/island-main.ts'
import type { createDeskIsland } from '../src/shell/desk-island.ts'

test('desktop sends require main-window acceptance, keep rejected drafts, and preserve edits made before a receipt', async () => {
  const listeners = new Map<string, Parameters<RawIpc['on']>[1]>()
  const ipc = checkedIpc({ on: (key, listener) => { listeners.set(key, listener) }, handle: (key, listener) => { listeners.set(key, listener) } })
  const messages: Array<{ channel: string, payload: unknown }> = []
  const main = { send: (channel: string, payload: unknown) => messages.push({ channel, payload }) }
  const desktop = { send() {} }
  let closed = 0
  const island = { owns: (sender: unknown) => sender === desktop, setView() {}, sendDraft() {}, closeInput: () => { closed++ } }
  const bridge = registerIslandIpc(ipc, {
    desk: () => island as unknown as ReturnType<typeof createDeskIsland>,
    window: () => ({ webContents: main, isDestroyed: () => false }) as unknown as BrowserWindow,
    showWindow() {}, switchOff() {}, Menu: {} as Parameters<typeof registerIslandIpc>[1]['Menu'],
  })
  const emit = (sender: unknown, channel: string, ...args: unknown[]) => listeners.get(channel)!({ sender }, ...args)
  emit(main, 'island:view', { form: 'idle', label: 'idle', recent: [], target: { key: 'topic-a' } })
  bridge.ownDraft('desk')
  const snapshot = () => emit(desktop, 'draft:get') as DraftSnapshot
  const first = snapshot()
  emit(desktop, 'draft:update', { ...first, sequence: first.sequence + 1, text: 'keep this draft' })
  const draft = snapshot()
  const request = { text: draft.text, files: [], images: [], draft: { key: draft.key, version: draft.version } }
  const sent = emit(desktop, 'island:ask', request)
  assert.equal(snapshot().text, draft.text)
  assert.equal(closed, 0)
  const receipt = messages.findLast(message => message.channel === 'island:action')!.payload as { receiptId: string }
  emit(desktop, 'island:ask-result', receipt.receiptId, { ok: true })
  assert.equal(closed, 0, 'the desktop cannot acknowledge its own send')
  emit(main, 'island:ask-result', receipt.receiptId, { ok: false, error: 'busy' })
  assert.deepEqual(await sent, { ok: false, error: 'busy' })
  assert.equal(snapshot().text, draft.text)
  const nextSend = emit(desktop, 'island:ask', request)
  const accepted = messages.findLast(message => message.channel === 'island:action')!.payload as { receiptId: string }
  emit(desktop, 'draft:update', { ...snapshot(), sequence: snapshot().sequence + 1, text: 'new typing' })
  emit(main, 'island:ask-result', accepted.receiptId, { ok: true })
  assert.deepEqual(await nextSend, { ok: true })
  assert.equal(snapshot().text, 'new typing')
  assert.equal(closed, 1)
  emit(main, 'island:ask-result', accepted.receiptId, { ok: true })
  assert.equal(closed, 1, 'a receipt is consumed once')
  assert.equal((await emit(desktop, 'island:ask', request) as { ok: boolean }).ok, false, 'stale sends do not reach another draft')
})

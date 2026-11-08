import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { BrowserWindow } from 'electron'
import { checkedIpc, type RawIpc } from '../src/shared/ipc-contract.ts'
import type { DraftSnapshot } from '../src/shared/composer-draft.ts'
import { registerIslandIpc } from '../src/shell/island-main.ts'
import { MISSING } from '../src/shell/island-files.ts'
import type { createDeskIsland } from '../src/shell/desk-island.ts'
import type { KeptImage } from '../src/backend/image-store.ts'

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
    keepImage: async () => { throw new Error('Unexpected image keep') },
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

function imageDraftHarness(keepImage: Parameters<typeof registerIslandIpc>[1]['keepImage']) {
  const listeners = new Map<string, Parameters<RawIpc['on']>[1]>()
  const ipc = checkedIpc({ on: (key, listener) => { listeners.set(key, listener) }, handle: (key, listener) => { listeners.set(key, listener) } })
  const main = { send() {} }, desktop = { send() {} }
  let connected = true
  const island = { owns: (sender: unknown) => connected && sender === desktop, setView() {}, sendDraft() {} }
  const bridge = registerIslandIpc(ipc, {
    desk: () => connected ? island as unknown as ReturnType<typeof createDeskIsland> : null,
    window: () => ({ webContents: main, isDestroyed: () => false }) as unknown as BrowserWindow,
    showWindow() {}, switchOff() {}, Menu: {} as Parameters<typeof registerIslandIpc>[1]['Menu'], keepImage,
  })
  const emit = (sender: unknown, channel: string, ...args: unknown[]) => listeners.get(channel)!({ sender }, ...args)
  return {
    main, desktop, emit, bridge,
    snapshot: () => emit(main, 'draft:get') as DraftSnapshot,
    select: (key: string, migrateDraft = false) => emit(main, 'island:view', { form: 'idle', label: 'idle', recent: [], target: { key, migrateDraft } }),
    destroyDesk: () => { connected = false; bridge.ownDraft('main') },
  }
}

const keptImage: KeptImage = { id: `${'c'.repeat(64)}.png`, mimeType: 'image/png', size: 12 }

function pendingImage() {
  let resolve!: (image: KeptImage) => void
  let reject!: (error: Error) => void
  const promise = new Promise<KeptImage>((finish, fail) => { resolve = finish; reject = fail })
  return { promise, resolve, reject }
}

for (const migrate of [false, true]) {
  test(`an accepted image keep completes in its original draft after desktop destruction${migrate ? ' and provisional-key migration' : ''}`, async () => {
    const pending = pendingImage()
    const harness = imageDraftHarness(() => pending.promise)
    harness.select('origin')
    harness.bridge.ownDraft('desk')
    const saving = harness.emit(harness.desktop, 'draft:keep-images', 'origin', [new Uint8Array([1, 2, 3])])
    assert.deepEqual(harness.snapshot().images, [])
    harness.destroyDesk()
    if (migrate) harness.select('canonical', true)
    harness.select('other')
    pending.resolve(keptImage)
    await saving
    assert.deepEqual(harness.snapshot().images, [], 'completion leaves the currently selected topic alone')
    harness.select(migrate ? 'canonical' : 'origin')
    assert.deepEqual(harness.snapshot().images, [keptImage])
    assert.equal(harness.snapshot().owner, 'main')
  })
}

test('every image in a pending batch completes after the originating desktop is destroyed', async () => {
  const pending = [pendingImage(), pendingImage()]
  let calls = 0
  const harness = imageDraftHarness(() => pending[calls++].promise)
  harness.select('origin')
  harness.bridge.ownDraft('desk')
  const saving = harness.emit(harness.desktop, 'draft:keep-images', 'origin', [new Uint8Array([1]), new Uint8Array([2])])
  assert.equal(calls, 2)
  harness.destroyDesk()
  const second = { ...keptImage, id: `${'d'.repeat(64)}.png` }
  pending[1].resolve(second)
  pending[0].resolve(keptImage)
  await saving
  assert.deepEqual(harness.snapshot().images.map(image => image.id), [keptImage.id, second.id], 'clipboard order survives reverse save completion')
})

test('a failed image keep records its error in the originating draft after handoff and migration', async () => {
  const pending = pendingImage()
  const harness = imageDraftHarness(() => pending.promise)
  harness.select('pending')
  harness.bridge.ownDraft('desk')
  const saving = harness.emit(harness.desktop, 'draft:keep-images', 'pending', [new Uint8Array([1])])
  harness.destroyDesk()
  harness.select('canonical', true)
  harness.select('other')
  pending.reject(new Error('image storage unavailable'))
  await saving
  assert.equal(harness.snapshot().error, null)
  harness.select('canonical')
  assert.equal(harness.snapshot().error, 'image storage unavailable')
  assert.deepEqual(harness.snapshot().images, [])
})

test('a mixed image batch preserves successful clipboard order, deduplicates, and retains its failure', async () => {
  const second = { ...keptImage, id: `${'d'.repeat(64)}.png` }
  const harness = imageDraftHarness(async bytes => {
    const value = bytes instanceof Uint8Array ? bytes[0] : new Uint8Array(bytes)[0]
    if (!value) throw new Error('invalid pasted image')
    return value === 1 ? keptImage : second
  })
  harness.select('origin')
  await harness.emit(harness.main, 'draft:keep-images', 'origin', [1, 0, 2, 1].map(byte => new Uint8Array([byte])))
  assert.deepEqual(harness.snapshot().images, [keptImage, second])
  assert.equal(harness.snapshot().error, 'invalid pasted image', 'later successes cannot erase a batch failure')
})

test('only live composer hosts may initiate image keeps, and the shared draft enforces the image limit', async () => {
  let calls = 0
  const harness = imageDraftHarness(async () => ({ ...keptImage, id: `${(++calls).toString(16).padStart(64, '0')}.png` }))
  harness.select('origin')
  await harness.emit({}, 'draft:keep-images', 'origin', [new Uint8Array([1])])
  assert.equal(calls, 0)
  for (let index = 0; index < 11; index++) await harness.emit(harness.main, 'draft:keep-images', 'origin', [new Uint8Array([1])])
  assert.equal(harness.snapshot().images.length, 10)
  assert.ok(harness.snapshot().error)
  harness.destroyDesk()
  await harness.emit(harness.desktop, 'draft:keep-images', 'origin', [new Uint8Array([1])])
  assert.equal(calls, 11)
})

test('file drops append and report failures in the main-process draft without a renderer completion', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'viva-draft-files-'))
  const filename = path.join(directory, 'drop.txt')
  fs.writeFileSync(filename, 'data')
  try {
    const harness = imageDraftHarness(async () => keptImage)
    harness.select('origin')
    harness.bridge.ownDraft('desk')
    harness.emit(harness.desktop, 'draft:append-files', 'origin', [filename])
    harness.destroyDesk()
    assert.deepEqual(harness.snapshot().files, [{ path: filename, name: 'drop.txt', size: 4 }])
    harness.emit(harness.main, 'draft:append-files', 'origin', [''])
    assert.equal(harness.snapshot().error, MISSING, 'virtual files without a native path retain the existing refusal feedback')
    harness.emit(harness.main, 'draft:append-files', 'origin', [filename])
    assert.equal(harness.snapshot().error, null)
    harness.select('other')
    harness.emit(harness.main, 'draft:append-files', 'origin', [path.join(directory, 'missing.txt')])
    assert.equal(harness.snapshot().error, null)
    harness.select('origin')
    assert.ok(harness.snapshot().error)
    assert.equal(harness.snapshot().files.length, 1)
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { appToSourcesOf, draftOf, MAX_SEEN, MAX_SOURCES, sourcesToAppOf, type CheckedItem, type SourceDraft } from '../src/shared/sources-channel.ts'
import { createSourceStore, mergeSeen } from '../src/backend/message-sources.ts'
import { createSourcesDesk, plainMarkdown, sourceItemBody } from '../src/backend/sources-desk.ts'
import { t } from '../src/shared/i18n/translate.ts'
import { Lexer, type Token } from 'marked'
import { getLocale, setLocale } from '../src/shared/i18n/locale.ts'

/** 消息源 on the app's side: the channel to viva-sources, the store, and the desk that answers and delivers. Synthetic data only. */

const DRAFT: SourceDraft = {
  name: '重要邮件提醒',
  tool: 'mcp__labmail__search_unread',
  args: { since: '{last}' },
  decode: 'json-text',
  items: '$.results',
  map: { key: '$.id', title: '$.subject', body: '$.preview', link: null, time: '$.date' },
  judge: '来自真人、涉及时间安排或需要回复的提醒',
  everyMinutes: 15,
  model: { provider: 'deepseek', model: 'deepseek-chat' },
}

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'viva-sources-')), 'message-sources.json')

test('a draft is taken only whole: tool, paths, pace within bounds, a model to judge with', () => {
  assert.deepEqual(draftOf(DRAFT), DRAFT)
  for (const bad of [
    { ...DRAFT, name: '' },
    { ...DRAFT, items: 'results' },
    { ...DRAFT, map: { ...DRAFT.map, title: null } },
    { ...DRAFT, map: { ...DRAFT.map, body: 'preview' } },
    { ...DRAFT, decode: 'model' },
    { ...DRAFT, everyMinutes: 1 },
    { ...DRAFT, everyMinutes: 15.5 },
    { ...DRAFT, model: { provider: 'deepseek' } },
    { ...DRAFT, args: 'since' },
  ]) assert.equal(draftOf(bad), null, JSON.stringify(bad))
})

test('the channel takes only well-formed messages, each way', () => {
  assert.deepEqual(sourcesToAppOf({ type: 'sources_ready', version: 1 }), { type: 'sources_ready', version: 1 })
  assert.deepEqual(sourcesToAppOf({ type: 'source_request', version: 1, id: 'r1-x', op: 'add', draft: DRAFT, seen: ['a'] }),
    { type: 'source_request', version: 1, id: 'r1-x', op: 'add', draft: DRAFT, seen: ['a'] })
  assert.deepEqual(sourcesToAppOf({ type: 'source_request', version: 1, id: 'r2', op: 'remove', sourceId: 'src-1' }),
    { type: 'source_request', version: 1, id: 'r2', op: 'remove', sourceId: 'src-1' })
  const checked = { type: 'source_checked', version: 1, sourceId: 'src-1', at: 10, nextAt: 20, ok: true, items: [{ key: 'k', title: ' 周五评审 ', body: 'b', link: '', push: true, reason: '时间' }], seen: [] }
  assert.deepEqual(sourcesToAppOf(checked), { ...checked, items: [{ key: 'k', title: '周五评审', body: 'b', link: '', push: true, reason: '时间' }] })
  assert.deepEqual(sourcesToAppOf({ type: 'source_checked', version: 1, sourceId: 'src-1', at: 10, nextAt: 20, ok: false, error: { code: 'tool', detail: 'x'.repeat(5000) } }),
    { type: 'source_checked', version: 1, sourceId: 'src-1', at: 10, nextAt: 20, ok: false, error: { code: 'tool', detail: 'x'.repeat(4000) } })
  assert.equal(sourcesToAppOf({ type: 'source_checked', version: 1, sourceId: 'src-1', at: 10, nextAt: 20, ok: false, error: '找不到工具' }), null, 'a failure is a code, not words')
  assert.equal(sourcesToAppOf({ type: 'source_checked', version: 1, sourceId: 'src-1', at: 10, nextAt: 20, ok: false, error: { code: 'nope', detail: '' } }), null)
  for (const bad of [
    null,
    { type: 'sources_ready', version: 2 },
    { type: 'source_request', version: 1, id: 'r 1', op: 'add', draft: DRAFT, seen: [] },
    { type: 'source_request', version: 1, id: 'r1', op: 'add', draft: { ...DRAFT, tool: '' }, seen: [] },
    { type: 'source_request', version: 1, id: 'r1', op: 'remove', sourceId: '../x' },
    { ...checked, items: [{ key: 'k', title: '', push: true }] },
    { ...checked, items: [{ key: 'k', title: 't', push: 'yes' }] },
    { ...checked, at: -1 },
  ]) assert.equal(sourcesToAppOf(bad), null, JSON.stringify(bad))
  assert.equal(appToSourcesOf({ type: 'sources_set', version: 1, sources: [{ ...DRAFT, id: 'Bad Id', paused: false, createdAt: 1, lastCheckedAt: null, seen: [] }] }), null)
  assert.deepEqual(appToSourcesOf({ type: 'source_reply', version: 1, id: 'r1', ok: false, text: 'no' }), { type: 'source_reply', version: 1, id: 'r1', ok: false, text: 'no' })
})

test('the store keeps sources whole across a restart, with the newest seen keys', () => {
  const file = tmpFile()
  let id = 0
  const store = createSourceStore({ file, now: () => 1000, newId: () => `src-${++id}` })
  const added = store.add(DRAFT, ['a', 'b'])
  assert.deepEqual(added, { ...DRAFT, id: 'src-1', paused: false, createdAt: 1000, lastCheckedAt: null, seen: ['a', 'b'] })
  assert.throws(() => store.add(DRAFT, []), { message: t('main.sources.name.taken', { name: DRAFT.name }) })
  store.recordCheck('src-1', 2000, ['b', 'c'])
  store.setPaused('src-1', true)
  const again = createSourceStore({ file })
  assert.deepEqual(again.list(), [{ ...added, paused: true, lastCheckedAt: 2000, seen: ['a', 'b', 'c'] }])
  if (process.platform !== 'win32') assert.equal((fs.statSync(file).mode & 0o777).toString(8), '600')
  assert.equal(again.remove('src-1')?.id, 'src-1')
  assert.equal(again.remove('src-1'), null)
  assert.deepEqual(createSourceStore({ file }).list(), [])
})

test('the store refuses more than it keeps, and a file it cannot read is reported, not thrown', () => {
  const store = createSourceStore({ file: tmpFile() })
  for (let i = 0; i < MAX_SOURCES; i++) store.add({ ...DRAFT, name: `源 ${i}` }, [])
  assert.throws(() => store.add({ ...DRAFT, name: '再一个' }, []), { message: t('main.sources.too.many', { max: MAX_SOURCES }) })
  const broken = tmpFile()
  fs.writeFileSync(broken, '{not json')
  const errors: string[] = []
  assert.deepEqual(createSourceStore({ file: broken, onError: (err) => errors.push(err.message) }).list(), [])
  assert.equal(errors.length, 1)
})

test('seen keys keep the newest, each once', () => {
  assert.deepEqual(mergeSeen(['a', 'b', 'c'], ['b', 'd', 'd']), ['a', 'c', 'b', 'd'])
  const many = Array.from({ length: MAX_SEEN + 5 }, (_, i) => `k${i}`)
  const merged = mergeSeen([], many)
  assert.equal(merged.length, MAX_SEEN)
  assert.equal(merged.at(-1), `k${MAX_SEEN + 4}`)
})

test('a pushed message reads as plain text, with why and a link to the original only when it is http(s)', () => {
  assert.equal(plainMarkdown('[点我](javascript:x) **粗** #标题'), '\\[点我\\]\\(javascript\\:x\\) \\*\\*粗\\*\\* \\#标题')
  const body = sourceItemBody({ body: '会议室换到 B2', reason: '涉及时间安排', link: 'https://mail.example.test/m(1)' })
  assert.equal(body, `会议室换到 B2\n\n${t('main.sources.why', { reason: '涉及时间安排' })}\n\n[${t('main.sources.open.original')}](https://mail.example.test/m%281%29)`)
  assert.equal(sourceItemBody({ body: 'x', reason: '', link: 'javascript:alert(1)' }), 'x')
})

test('a pushed message\'s text reads back as written: no address in it turns into a link, nothing into code', () => {
  const text = '见 https://example.com/path?a=1&b=_x_ 或 www.example.com，联系 a@b.example.test\n    缩进行 1. 不是列表 <b>x</b> \\ 完'
  const tokens = new Lexer({ gfm: true }).lex(plainMarkdown(text))
  const kinds = new Set<string>()
  const shown = (list: readonly Token[]): string => list.map((token) => {
    kinds.add(token.type)
    if (token.type === 'escape') return token.text
    if ('tokens' in token && token.tokens) return shown(token.tokens)
    return token.type === 'space' ? '' : ('text' in token ? String(token.text) : token.raw)
  }).join('')
  const read = shown(tokens)
  assert.deepEqual([...kinds].filter((kind) => !['paragraph', 'text', 'escape', 'br'].includes(kind)), [])
  assert.equal(read.replace(/\s+/g, ' '), text.replace(/^[ \t]+/gm, '').replace(/\s+/g, ' '))
})

function deskSetup() {
  const sent: any[] = []
  const delivered: Array<{ source: string, items: CheckedItem[] }> = []
  let changes = 0
  let id = 0
  const store = createSourceStore({ file: tmpFile(), now: () => 1000, newId: () => `src-${++id}` })
  const desk = createSourcesDesk({
    send: (message) => sent.push(message),
    store: () => store,
    deliver: (source, items) => delivered.push({ source: source.id, items }),
    onChange: () => { changes++ },
    now: () => 5000,
  })
  return { sent, delivered, store, desk, changes: () => changes }
}

test('the desk sends the sources when the plugin starts, and answers an add and a remove', () => {
  const { sent, desk, store } = deskSetup()
  desk.receive({ type: 'sources_ready', version: 1 })
  assert.deepEqual(sent.shift(), { type: 'sources_set', version: 1, sources: [] })
  desk.receive({ type: 'source_request', version: 1, id: 'r1', op: 'add', draft: DRAFT, seen: ['a'] })
  assert.deepEqual(sent.shift(), { type: 'source_reply', version: 1, id: 'r1', ok: true, text: t('main.sources.added', { name: DRAFT.name }) })
  assert.equal(sent.shift().sources[0].id, 'src-1')
  desk.receive({ type: 'source_request', version: 1, id: 'r2', op: 'add', draft: DRAFT, seen: [] })
  assert.deepEqual(sent.shift(), { type: 'source_reply', version: 1, id: 'r2', ok: false, text: t('main.sources.name.taken', { name: DRAFT.name }) })
  assert.equal(sent.length, 0, 'a refused add changes nothing')
  desk.receive({ type: 'source_request', version: 1, id: 'r3', op: 'remove', sourceId: 'src-1' })
  assert.deepEqual(sent.shift(), { type: 'source_reply', version: 1, id: 'r3', ok: true, text: t('main.sources.removed', { name: DRAFT.name }) })
  assert.deepEqual(store.list(), [])
  desk.receive({ type: 'source_request', version: 1, id: 'r4', op: 'remove', sourceId: 'src-1' })
  assert.equal(sent.find((message) => message.id === 'r4').ok, false)
})

test('a check that went through remembers every key, delivers only what is pushed, and says how it stands', () => {
  const { delivered, desk, store } = deskSetup()
  store.add(DRAFT, ['old'])
  const items = [
    { key: 'a1@example.test', title: '周五评审改到 15:00', body: '会议室换到 B2', link: '', push: true, reason: '涉及时间安排' },
    { key: 'n7@example.test', title: '本周技术周刊', body: '十篇文章推荐', link: '', push: false, reason: '推广' },
  ]
  desk.receive({ type: 'source_checked', version: 1, sourceId: 'src-1', at: 4000, nextAt: 9000, ok: true, items, seen: ['skipped'] })
  assert.deepEqual(store.list()[0].seen, ['old', 'skipped', 'a1@example.test', 'n7@example.test'])
  assert.equal(store.list()[0].lastCheckedAt, 4000)
  assert.deepEqual(delivered, [{ source: 'src-1', items: [items[0]] }])
  assert.deepEqual(desk.views()[0].status, { checkedAt: 5000, nextAt: 9000, fresh: 2, pushed: 1, error: '' })
  desk.receive({ type: 'source_checked', version: 1, sourceId: 'src-1', at: 6000, nextAt: 12000, ok: false, error: { code: 'unknown-tool', detail: 'mcp__mail__search' } })
  const said = t('main.sources.error.unknown-tool', { detail: 'mcp__mail__search' })
  assert.ok(said.includes('mcp__mail__search') && !said.includes('{detail}'))
  assert.deepEqual(desk.views()[0].status, { checkedAt: 5000, nextAt: 12000, fresh: 2, pushed: 1, error: said }, 'said in the window\'s language')
  assert.equal(store.list()[0].lastCheckedAt, 4000, 'a failed check does not move the time new messages are read from')
  desk.receive({ type: 'source_checked', version: 1, sourceId: 'src-404', at: 1, nextAt: 2, ok: true, items, seen: [] })
  store.setPaused('src-1', true)
  desk.receive({ type: 'source_checked', version: 1, sourceId: 'src-1', at: 7000, nextAt: 13000, ok: true, items, seen: [] })
  assert.equal(delivered.length, 1, 'a check that arrives after the source was paused is not delivered')
  assert.equal(delivered.length, 1, 'a check of a source no longer kept is dropped')
})

test('a check that cannot be remembered (a full disk) still delivers its reminders, and the app keeps running', (t) => {
  const { delivered, store } = deskSetup()
  store.add(DRAFT, [])
  const errors = t.mock.method(console, 'error', () => {})
  const desk = createSourcesDesk({
    send: () => {},
    store: () => ({ ...store, recordCheck: () => { throw new Error('ENOSPC') } }),
    deliver: (source, items) => delivered.push({ source: source.id, items }),
    onChange: () => {},
    now: () => 5000,
  })
  const items = [{ key: 'a1@example.test', title: '周五评审改到 15:00', body: '', link: '', push: true, reason: '时间' }]
  assert.doesNotThrow(() => desk.receive({ type: 'source_checked', version: 1, sourceId: 'src-1', at: 4000, nextAt: 9000, ok: true, items, seen: [] }))
  assert.deepEqual(delivered, [{ source: 'src-1', items }])
  assert.equal(errors.mock.callCount(), 1)
})

test('why a check failed is said in the language the window has now', (t) => {
  const { desk, store } = deskSetup()
  store.add(DRAFT, [])
  const was = getLocale()
  t.after(() => setLocale(was))
  setLocale('zh-CN')
  desk.receive({ type: 'source_checked', version: 1, sourceId: 'src-1', at: 1, nextAt: 2, ok: false, error: { code: 'timeout', detail: '' } })
  assert.equal(desk.views()[0].status.error, '检查超时了。')
  setLocale('en')
  assert.equal(desk.views()[0].status.error, 'The check timed out.')
})

test('pause and delete from the window reach the plugin; the view leaves out seen keys and the model', () => {
  const { sent, desk, store, changes } = deskSetup()
  store.add(DRAFT, ['old'])
  desk.setPaused('src-1', true)
  assert.equal(sent.at(-1).sources[0].paused, true)
  const view = desk.views()[0]
  assert.equal('seen' in view || 'model' in view || 'args' in view, false)
  assert.equal(view.paused, true)
  assert.throws(() => desk.setPaused('src-404', true), { message: t('main.sources.not.found') })
  desk.remove('src-1')
  assert.deepEqual(sent.at(-1), { type: 'sources_set', version: 1, sources: [] })
  assert.equal(changes(), 2)
})

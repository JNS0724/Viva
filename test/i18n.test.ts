import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { en } from '../src/shared/i18n/messages/en.ts'
import { zhCN } from '../src/shared/i18n/messages/zh-CN.ts'
import { resolveLocale, setLocale, getLocale, type Language } from '../src/shared/i18n/locale.ts'
import { t, translate } from '../src/shared/i18n/translate.ts'
import { calendarDays } from '../src/shared/i18n/format.ts'
import { createPreferences } from '../src/main/preferences.ts'
import { registerLanguageIpc } from '../src/main/language-ipc.ts'
import { checkedIpc, type RawIpc } from '../src/main/ipc-contract.ts'
import { optionName } from '../src/renderer/approval.ts'
import { PERMISSION_LEVELS } from '../src/renderer/view/permission-picker.ts'
import { PROFILE_FIELDS } from '../src/shared/profile-fields.ts'
import { readMessages } from '../src/main/message-reader.ts'

afterEach(() => setLocale('zh-CN'))

test('message-reader guidance follows the active locale without altering source data', async () => {
  const deps = { enabled: () => [], health: () => ({ lastOkAt: null, lastError: null }), search: () => [], pollNow: async () => {} }
  const request = { source: null, query: null, sinceHours: 72, limit: 10 }
  setLocale('en')
  assert.match(await readMessages(request, deps), /^No message sources are enabled/)
  setLocale('zh-CN')
  assert.match(await readMessages(request, deps), /^用户还没有打开任何消息源/)
})

test('count phrases and profile labels switch without changing inserted content', () => {
  setLocale('en')
  assert.equal(PROFILE_FIELDS[0].label, 'Role and responsibilities')
  assert.equal(t('history-panel.messages', { length: 1 }), '1 message')
  assert.equal(t('history-panel.messages', { length: 0 }), '0 messages')
  assert.equal(t('history-panel.messages', { length: 2 }), '2 messages')
  assert.equal(t('native.pending', { count: '1 messages' }), '1 messages waiting for you')
  setLocale('zh-CN')
  assert.equal(PROFILE_FIELDS[0].label, '角色与职责')
})

test('system locales resolve deliberately; explicit selection wins', () => {
  for (const locale of ['zh', 'zh-CN', 'zh_SG', 'zh-Hans', 'zh-Hans-CN']) assert.equal(resolveLocale('system', locale), 'zh-CN')
  for (const locale of ['en-US', 'fr', 'zh-TW', 'zh-HK', 'zh-Hant', 'zh-Hant-CN', '']) assert.equal(resolveLocale('system', locale), 'en')
  assert.equal(resolveLocale('en', 'zh-CN'), 'en')
  assert.equal(resolveLocale('zh-CN', 'en-US'), 'zh-CN')
})

test('all translations have matching keys, parameters, and nonempty values', () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zhCN).sort())
  const slots = (value: string) => [...value.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort()
  for (const key of Object.keys(en) as (keyof typeof en)[]) {
    assert.ok(en[key].trim() && zhCN[key].trim(), key)
    assert.deepEqual(slots(en[key]), slots(zhCN[key]), key)
    assert.ok(!en[key].includes('{undefined}'), key)
  }
})

test('switching updates module-level permission and approval labels; unknown keys are readable', () => {
  assert.equal(optionName({ name: 'Allow once', kind: 'allow_once' }), '允许')
  setLocale('en')
  assert.equal(optionName({ name: 'Allow once', kind: 'allow_once' }), 'Allow')
  assert.equal(PERMISSION_LEVELS[0].name, 'Read only')
  assert.equal(t('native.pending', { count: 2 }), '2 waiting for you')
  assert.equal(translate('missing.key'), en['errors.generic'])
  assert.equal(translate('native.pending', { count: '<img onerror=bad>' }), '<img onerror=bad> waiting for you')
  setLocale('zh-CN')
  assert.equal(PERMISSION_LEVELS[0].name, '仅可查看')
})

test('old profiles keep Chinese; new profiles follow the system; invalid values are refused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viva-language-'))
  try {
    const file = path.join(dir, 'preferences.json')
    const prefs = createPreferences({ file })
    assert.equal(prefs.get().language, 'system')
    fs.writeFileSync(file, JSON.stringify({ v: 1, deskIsland: false }))
    assert.equal(prefs.get().language, 'zh-CN')
    prefs.set('language', 'en')
    assert.equal(createPreferences({ file }).get().language, 'en')
    assert.equal(prefs.get().deskIsland, false)
    assert.throws(() => prefs.set('language', '../../etc'), /Invalid language/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('language IPC persists and broadcasts without reconnecting the agent', () => {
  const listeners = new Map<string, (...args: unknown[]) => unknown>()
  const raw: RawIpc = { handle: (channel, fn) => { listeners.set(channel, fn) }, on: () => {} }
  let language: Language = 'system'
  const delivered: unknown[] = []
  let nativeRefreshes = 0
  registerLanguageIpc(checkedIpc(raw), {
    getLanguage: () => language, saveLanguage: next => { language = next }, systemLocale: () => 'en-GB',
    broadcast: value => { delivered.push(value) }, refreshNative: () => { nativeRefreshes++ },
  })
  assert.equal(getLocale(), 'en')
  assert.deepEqual(listeners.get('language:get')?.({}), { language: 'system', locale: 'en' })
  assert.deepEqual(listeners.get('language:set')?.({}, 'zh-CN'), { language: 'zh-CN', locale: 'zh-CN' })
  assert.equal(nativeRefreshes, 1)
  assert.equal(delivered.length, 1)
  assert.throws(() => listeners.get('language:set')?.({}, 'unsupported'), /invalid language:set/)
  assert.equal(delivered.length, 1)
})

test('calendar day arithmetic crosses month and year boundaries', () => {
  assert.equal(calendarDays(new Date(2026, 11, 31, 23, 59).getTime(), new Date(2027, 0, 1, 0, 1).getTime()), 1)
  assert.equal(calendarDays(new Date(2026, 2, 8).getTime(), new Date(2026, 2, 9).getTime()), 1)
})

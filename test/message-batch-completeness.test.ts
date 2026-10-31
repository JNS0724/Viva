import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMessageJudge } from '../src/main/message-judge.ts'
import { openFollowupStore } from '../src/main/followup-store.ts'
import { openSourcesDb } from '../src/main/sources-db.ts'

test('valid JSON with omitted, duplicate or foreign IDs stays pending; a complete retry settles once', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viva-judge-completeness-'))
  const store = openFollowupStore({ file: path.join(dir, 'followups.db') })
  const sources = openSourcesDb({ file: path.join(dir, 'sources.db') })
  t.after(() => { store.close(); sources.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  sources.save('mail', Array.from({ length: 20 }, (_, index) => ({ id: `m${index}`, at: 1, from: 'QA', title: `消息${index}`, text: '需要处理的合成消息' })), 'cursor')
  const complete = Array.from({ length: 20 }, (_, index) => ({ id: `mail/m${index}`, important: index % 2 === 0 }))
  let items = complete
  const judge = createMessageJudge({ sources, store, profile: () => null, prepareText: async () => ({ ok: true, text: JSON.stringify({ items }) }) })
  for (const bad of [[], complete.slice(0, 19), [...complete.slice(0, 19), complete[0]], [...complete.slice(0, 19), { id: 'mail/foreign', important: true }]]) {
    items = bad
    assert.deepEqual(await judge.run(new AbortController().signal), { ok: false, suggested: 0 })
    assert.equal(sources.unjudged().length, 20)
    assert.equal(store.listSuggestions().length, 0)
  }
  items = complete
  assert.deepEqual(await judge.run(new AbortController().signal), { ok: true, suggested: 10 })
  assert.equal(sources.unjudged().length, 0)
  assert.equal(store.listSuggestions().length, 10)
  assert.deepEqual(await judge.run(new AbortController().signal), { ok: true, suggested: 0 })
})

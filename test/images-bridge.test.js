import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { defaultModel } from '../src/main/model-providers.ts'
import { DSH_TIMEOUT_MS, startHarness as setup } from './fixtures/dsh-harness.js'

/** Pictures pasted into a question, inside the real dsh: the model gets them, and dsh keeps its copy in Viva's folder. */

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

test('a picture with the words reaches the model, and dsh keeps it in the pictures folder', { timeout: DSH_TIMEOUT_MS }, async (t) => {
  const { events, llm, bridge, dir } = await setup(t, {
    imagesDir: (root) => path.join(root, 'images'),
    // As main.js writes it with only a DeepSeek key.
    models: () => ({ providers: {}, deepseek: true, defaultModel: defaultModel({ lastModel: null, providers: [], hasDeepSeek: true }) }),
  })
  const agent = bridge()
  await agent.start()
  await agent.prompt('这张图里是什么', [{ data: PNG, mimeType: 'image/png' }])

  assert.equal(events.filter((e) => e.type === 'error').length, 0, JSON.stringify(events.filter((e) => e.type === 'error')))
  const asked = JSON.stringify(llm.requests.find((request) => JSON.stringify(request).includes('这张图里是什么')))
  assert.match(asked, /image/, 'the request carries a picture')
  assert.ok(fs.existsSync(path.join(dir, 'images', 'attachments')), 'dsh keeps its copy in the pictures folder')
})

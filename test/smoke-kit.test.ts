import test from 'node:test'
import assert from 'node:assert/strict'
import { settle, smokeStep, submit, type SmokeWindow } from './smoke/smoke-kit.ts'

test('smoke submission waits for readiness before writing or sending the prompt', async () => {
  let ready = false
  let checks = 0
  const submissions: string[] = []
  const webContents = {
    executeJavaScript: async (code: string) => {
      if (code.includes('.requestSubmit()')) {
        assert.equal(ready, true, 'startup must finish before submitting')
        submissions.push(code)
        return undefined
      }
      checks++
      assert.match(code, /info.mode === 'live'/)
      assert.match(code, /Boolean\(info.sessionId\)/)
      assert.match(code, /!send.disabled/)
      return ready
    },
  } as SmokeWindow['webContents']
  const pending = submit({ webContents }, 'test prompt')
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(checks, 1)
  assert.equal(submissions.length, 0, 'a loading composer must not swallow the test prompt')
  ready = true
  await pending
  assert.equal(submissions.length, 1)
  assert.match(submissions[0], /test prompt/)
})

test('ordinary smoke settling waits for fonts, finite running transitions and two paint frames', async () => {
  let script = ''
  await settle({ webContents: { executeJavaScript: async code => { script = code } } as SmokeWindow['webContents'] })
  assert.match(script, /await document.fonts.ready/)
  assert.match(script, /animation.playState === 'running'/)
  assert.match(script, /Number.isFinite/)
  assert.match(script, /animation.finished/)
  assert.match(script, /requestAnimationFrame\(\(\) => requestAnimationFrame/)
})

test('named smoke stages return values and propagate the first failure', async () => {
  const seen: string[] = []
  const hooks = { step: async <T>(name: string, action: () => Promise<T>) => { seen.push(name); return action() } }
  assert.equal(await smokeStep(hooks, 'ready', async () => 42), 42)
  await assert.rejects(smokeStep(hooks, 'broken', async () => { throw new Error('first failure') }), /first failure/)
  assert.deepEqual(seen, ['ready', 'broken'])
  assert.equal(await smokeStep({}, 'without Playwright', async () => 'done'), 'done')
})

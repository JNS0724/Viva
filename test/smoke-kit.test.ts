import test from 'node:test'
import assert from 'node:assert/strict'
import { submit, type SmokeWindow } from '../src/main/smoke-kit.ts'

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

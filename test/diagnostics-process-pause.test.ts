import test from 'node:test'
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { pauseOwnedProcess } from './fixtures/diagnostics-process-pause.ts'
import type { PausedProcess } from './fixtures/diagnostics-process-pause.ts'

test('fault injection rejects invalid and self PIDs before any OS action', async () => {
  for (const pid of [0, -1, 1.5, NaN, Infinity, process.pid]) await assert.rejects(pauseOwnedProcess(pid), /owned child/)
})

test('an actually suspended owned process resumes and continues its IPC heartbeat', { timeout: 30_000 }, async () => {
  const child = fork(fileURLToPath(new URL('./fixtures/diagnostics-pulse.ts', import.meta.url)), {
    execPath: process.execPath, execArgv: [], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  })
  let pulse = 0, paused: PausedProcess | undefined
  const exit = new Promise<void>(resolve => child.once('exit', () => resolve()))
  child.on('message', (value: unknown) => { if (typeof value === 'number') pulse = value })
  async function nextPulse(after: number) {
    for (let i = 0; i < 100 && pulse <= after; i++) await delay(20)
    assert.ok(pulse > after, 'owned process must emit a fresh heartbeat')
  }
  try {
    await nextPulse(0)
    paused = await pauseOwnedProcess(child.pid!)
    await delay(200) // Drain any IPC already in transit before checking the held debug event.
    const before = pulse
    await delay(150)
    assert.equal(pulse, before, 'all target threads must be stopped')
    await paused.resume()
    await paused.resume() // Cleanup can call resume again safely.
    await nextPulse(before)
  } finally {
    await paused?.resume()
    child.kill()
    await exit
  }
})

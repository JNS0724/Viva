import fs from 'node:fs/promises'
import path from 'node:path'
import type { BrowserWindow } from 'electron'

/** How the smoke runs (smoke.js, smoke-memory.js) drive the window: run page code, wait for what it shows. */
export const UI_WAIT_MS = 600
export const TURN_TIMEOUT_MS = 60_000
const POLL_MS = 200

/** A window the smoke run drives: the app's, or the desktop island's. */
export type SmokeWindow = Pick<BrowserWindow, 'webContents'>
/** What a check finds: what looked wrong, and what was seen. */
export type Expect = (ok: unknown, message: string, seen?: unknown) => void
/** What main.ts lends a smoke run: the desktop island, the fake model, the agent to crash, and so on. */
export type SmokeHooks = { desk?: () => any, [hook: string]: any }

export const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
/** What the page code returns; the code is the smoke run's own, so what comes back is what it was written to return. */
export const run = (win: SmokeWindow, code: string): Promise<any> => win.webContents.executeJavaScript(code)
export const click = (win: SmokeWindow, id: string) => run(win, `document.getElementById(${JSON.stringify(id)}).click()`)
/** ⌘N / Ctrl+N: a new topic, the timeline kept above it (there is no button for it). */
export const newTopic = (win: SmokeWindow) => run(win, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', metaKey: true, bubbles: true }))`)
/** Runtime startup and topic switches are asynchronous; a fixed boot delay is not a readiness signal. */
export async function submit(win: SmokeWindow, text: string) {
  await until(win, `(async () => {
    const info = await window.agent.getInfo()
    const input = document.getElementById('composer-input')
    const send = document.getElementById('send-btn')
    return info.mode === 'live' && Boolean(info.sessionId) && input && !input.disabled && send && !send.disabled
  })()`, 'the composer and agent session ready for submission')
  return run(win, `(() => {
  document.getElementById('composer-input').value = ${JSON.stringify(text)}
  document.getElementById('composer').requestSubmit()
})()`)
}

export function report(line: string) {
  process.stdout.write(`[smoke] ${line}\n`)
}

export async function capture(win: SmokeWindow, outDir: string, name: string) {
  const file = path.join(outDir, `${name}.png`)
  await fs.writeFile(file, (await win.webContents.capturePage()).toPNG())
  report(`saved ${file}`)
}

/** Polls page code until it returns something truthy, and returns that. */
export async function until(win: SmokeWindow, code: string, what: string, timeoutMs = TURN_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await run(win, code)
    if (value) return value
    await wait(POLL_MS)
  }
  throw new Error(`${what} never happened`)
}

/**
 * Waits for the turn to end and be fully typed out, allowing any permission card on the way (not a question, nor a
 * follow-up's proposal, which are the user's to decide). @returns cards allowed
 */
export async function finishTurn(win: SmokeWindow): Promise<number> {
  const deadline = Date.now() + TURN_TIMEOUT_MS
  let allowed = 0
  while (Date.now() < deadline) {
    const seen = await run(win, `(() => {
      const card = document.querySelector('.confirm:not(.ask):not(.fu-card) .btn-primary')
      if (card) card.click()
      const send = document.getElementById('send-btn')
      return { card: Boolean(card), idle: send.dataset.busy === 'false' && !send.disabled && !document.querySelector('.caret') }
    })()`)
    if (seen.card) allowed += 1
    else if (seen.idle) return allowed
    await wait(POLL_MS)
  }
  throw new Error('a turn never finished')
}

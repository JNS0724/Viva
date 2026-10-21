import fs from 'node:fs/promises'
import path from 'node:path'

/** How the smoke runs (smoke.js, smoke-memory.js) drive the window: run page code, wait for what it shows. */
export const UI_WAIT_MS = 600
export const TURN_TIMEOUT_MS = 60_000
const POLL_MS = 200

export const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
export const run = (win, code) => win.webContents.executeJavaScript(code)
export const click = (win, id) => run(win, `document.getElementById(${JSON.stringify(id)}).click()`)
export const submit = (win, text) => run(win, `(() => {
  document.getElementById('composer-input').value = ${JSON.stringify(text)}
  document.getElementById('composer').requestSubmit()
})()`)

export function report(line) {
  process.stdout.write(`[smoke] ${line}\n`)
}

export async function capture(win, outDir, name) {
  const file = path.join(outDir, `${name}.png`)
  await fs.writeFile(file, (await win.webContents.capturePage()).toPNG())
  report(`saved ${file}`)
}

/** Polls page code until it returns something truthy, and returns that. */
export async function until(win, code, what, timeoutMs = TURN_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await run(win, code)
    if (value) return value
    await wait(POLL_MS)
  }
  throw new Error(`${what} never happened`)
}

/** Waits for the turn to end and be fully typed out, allowing any permission card on the way. @returns {number} cards allowed */
export async function finishTurn(win) {
  const deadline = Date.now() + TURN_TIMEOUT_MS
  let allowed = 0
  while (Date.now() < deadline) {
    const seen = await run(win, `(() => {
      const card = document.querySelector('.confirm:not(.ask) .btn-primary')
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

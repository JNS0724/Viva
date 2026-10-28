import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { mayAutoApprove } from './live-approval.ts'
import { capture, newTopic, run, submit, UI_WAIT_MS, until, wait, type Expect, type SmokeHooks, type SmokeWindow } from './smoke-kit.ts'

/**
 * What the live check (live.ts, docs/live-check.md) drives the window with: the smoke helpers (smoke-kit.ts),
 * plus turns that wait as long as a real model takes and say what happened on the way: which cards asked,
 * what was answered, what went wrong.
 */
const POLL_MS = 300
/** A real model, with tools, can take minutes on one turn. */
export const LIVE_TURN_MS = 240_000
/** How long a turn may take to start once the question is sent. */
const START_MS = 15_000
/** The memory plugin's background pass writes after a turn (scripts/live-memory.js SETTLE_MS). */
export const MEMORY_SETTLE_MS = 20_000

/** What one attempt of a scenario has to work with. */
export interface LiveContext {
  win: SmokeWindow
  hooks: SmokeHooks
  /** Where this attempt's screenshots and files go. */
  outDir: string
  /** The live check's own folder (smoke/live), shared by every attempt and both phases. */
  liveDir: string
  /** The conversation's workspace. */
  workspace: string
  userData: string
  /** Which attempt this is, from 1. */
  attempt: number
  /** Lower-case letters and digits, new for each attempt: names and words no earlier attempt used. */
  tag: string
  /** The same, upper-case: codes the model has to repeat back. */
  code: string
  expect: Expect
  /** A screenshot of the window into this attempt's folder. */
  shot: (name: string, page?: SmokeWindow) => Promise<void>
}

/** One thing the live check verifies, run several times (live.ts). */
export interface LiveScenario {
  id: string
  /** What it checks, as the report says it. */
  title: string
  /** The section of docs/features.md it covers. */
  feature: string
  /** Run on every beta (LIVE_SET=core); the rest only in the full set. */
  core?: boolean
  /**
   * What needs the app started again: `prepare` runs at the end of the first launch (phase `live`), `run`
   * in the second (`live-resume`) on the same profile. Without it the scenario runs whole in the first.
   */
  prepare?: (ctx: LiveContext) => Promise<void>
  run: (ctx: LiveContext) => Promise<void>
}

export function newTag(): string {
  return crypto.randomBytes(3).toString('hex')
}

export function makeContext(base: Omit<LiveContext, 'expect' | 'shot' | 'tag' | 'code'>, failures: string[], shots: string[]): LiveContext {
  const tag = newTag()
  return {
    ...base,
    tag,
    code: `LV-${tag.toUpperCase()}`,
    expect: (ok, message, seen) => { if (!ok) failures.push(`${message}${seen === undefined ? '' : `: ${clip(JSON.stringify(seen), 400)}`}`) },
    shot: async (name, page) => {
      await capture(page ?? base.win, base.outDir, name)
      shots.push(path.join(base.outDir, `${name}.png`))
    },
  }
}

export const clip = (text: string, max = 200) => (text.length > max ? `${text.slice(0, max)}…` : text)

/** Page code: the card asking permission in the conversation, not one on the 后台 page. */
const PERMISSION_CARD = `[...document.querySelectorAll('.confirm:not(.ask):not(.fu-card)')].find((el) => !el.closest('#tasks-page'))`

const TURN_STATE = `(() => {
  const card = ${PERMISSION_CARD}
  const ask = [...document.querySelectorAll('.ask')].find((el) => !el.closest('#tasks-page'))
  const secret = document.querySelector('.secret')
  const send = document.getElementById('send-btn')
  return {
    card: card ? (card.querySelector('.confirm-title')?.textContent || card.textContent.slice(0, 120)) : null,
    cardText: card?.textContent ?? '',
    ask: ask ? { question: ask.querySelector('.ask-question')?.textContent ?? '', options: [...ask.querySelectorAll('.ask-option')].map((el) => el.textContent) } : null,
    secret: secret ? [...secret.querySelectorAll('input')].map((el) => el.getAttribute('aria-label') ?? '') : null,
    idle: send.dataset.busy === 'false' && !send.disabled && !document.querySelector('.caret'),
  }
})()`

/** What the user does when the turn asks: allow or turn down what needs permission, answer a question, fill a key. */
export interface TurnPolicy {
  permission?: 'allow' | 'deny'
  /** The option to pick, or words to type, when the agent asks a question; without it the turn stops there. */
  answer?: string
  /** What to type into each field of a key card; without it a key card fails the turn. */
  secret?: string
  timeoutMs?: number
}

export interface TurnOutcome {
  /** Titles of the permission cards, in order. */
  cards: string[]
  questions: Array<{ question: string, options: string[] }>
  /** Names the key cards asked for. */
  secrets: string[]
  /** The newest answer in the conversation on screen. */
  answer: string
  /** The newest error shown in the conversation on screen, if any. */
  error: string
  /** Whether the turn stopped on a question it was not told how to answer. */
  waiting: boolean
  ms: number
}

const lastAnswer = `[...document.querySelectorAll('#thread .msg-agent .msg-text')].at(-1)?.textContent ?? ''`
const lastError = `[...document.querySelectorAll('#thread .msg-error')].at(-1)?.textContent ?? ''`

async function answerQuestion(win: SmokeWindow, answer: string, options: string[]) {
  // '*' takes the first option offered, or says a city when there are none (the questions here are about places).
  const option = answer === '*' ? options[0] : options.find((text) => text === answer)
  if (option === undefined && answer === '*') return submit(win, '上海')
  if (option !== undefined) {
    await run(win, `[...document.querySelectorAll('.ask-option')].find((el) => el.textContent === ${JSON.stringify(option)}).click()`)
    // A multiple choice or several questions wait for 提交.
    await wait(UI_WAIT_MS)
    await run(win, `[...document.querySelectorAll('.ask button')].find((el) => el.textContent === '提交')?.click()`)
    return
  }
  // Typed in the input, the words answer the question (docs/features.md 助手反问).
  await submit(win, answer)
}

/** Waits for the turn on screen to end, doing on the way what `policy` says the user does. */
export async function settle(win: SmokeWindow, policy: TurnPolicy = {}): Promise<TurnOutcome> {
  const started = Date.now()
  const deadline = started + (policy.timeoutMs ?? LIVE_TURN_MS)
  const outcome: TurnOutcome = { cards: [], questions: [], secrets: [], answer: '', error: '', waiting: false, ms: 0 }
  const done = async (waiting: boolean) => ({ ...outcome, waiting, answer: await run(win, lastAnswer), error: await run(win, lastError), ms: Date.now() - started })
  while (Date.now() < deadline) {
    const seen = await run(win, TURN_STATE)
    if (seen.card) {
      outcome.cards.push(seen.card)
      const allowed = policy.permission === 'allow' && mayAutoApprove(seen.cardText)
      if (policy.permission === 'allow' && !allowed) {
        outcome.cards.push('验收脚本拒绝了超出范围的系统权限更改')
        process.stdout.write('[live] denied out-of-scope ACL/security modification; fixture-only approval policy\n')
      }
      await run(win, `(${PERMISSION_CARD}).querySelector(${JSON.stringify(allowed ? '.btn-primary' : '.btn-secondary')}).click()`)
      await wait(UI_WAIT_MS)
      continue
    }
    if (seen.secret) {
      if (policy.secret === undefined) throw new Error(`a key card asked for ${seen.secret.join('、')} and the scenario has none to give`)
      outcome.secrets.push(...seen.secret)
      await run(win, `(() => {
        const card = document.querySelector('.secret')
        card.querySelectorAll('input').forEach((input) => { input.value = ${JSON.stringify(policy.secret)} })
        card.requestSubmit()
      })()`)
      await wait(UI_WAIT_MS)
      continue
    }
    if (seen.ask) {
      if (!outcome.questions.some((q) => q.question === seen.ask.question)) outcome.questions.push(seen.ask)
      if (policy.answer === undefined) return done(true)
      await answerQuestion(win, policy.answer, seen.ask.options)
      await wait(UI_WAIT_MS)
      continue
    }
    if (seen.idle) return done(false)
    await wait(POLL_MS)
  }
  throw new Error(`the turn did not end within ${Math.round((policy.timeoutMs ?? LIVE_TURN_MS) / 1000)} s`)
}

/** Sends `text` in the conversation on screen and waits for the turn it starts to end. */
export async function ask(win: SmokeWindow, text: string, policy: TurnPolicy = {}): Promise<TurnOutcome> {
  const asked = await run(win, `document.querySelectorAll('#thread .msg-user').length`)
  await submit(win, text)
  await until(win, `document.querySelectorAll('#thread .msg-user').length > ${asked} || document.getElementById('send-btn').dataset.busy === 'true'`, 'the question going out', START_MS)
  return settle(win, policy)
}

/** ⌘N, and the agent ready for the new topic: each scenario starts with nothing said in it. */
export async function fresh(win: SmokeWindow) {
  await newTopic(win)
  await until(win, `(() => { const send = document.getElementById('send-btn'); return send.dataset.busy === 'false' && !send.disabled })()`, 'the new topic ready', LIVE_TURN_MS)
  await wait(UI_WAIT_MS)
}

/** Waits for the agent to be connected and idle: after launch, after a restart, after switching models. */
export async function agentReady(win: SmokeWindow, timeoutMs = LIVE_TURN_MS) {
  await until(win, `(() => {
    const send = document.getElementById('send-btn')
    return send.dataset.busy === 'false' && !send.disabled && !document.getElementById('model-btn').disabled
  })()`, 'the agent connected', timeoutMs)
}

/** The titles of the steps in 过程 for the conversation on screen: the tools the agent used, among others. */
export async function traceTitles(win: SmokeWindow): Promise<string[]> {
  const wasOpen = await run(win, `document.getElementById('drawer').dataset.open === 'true'`)
  if (!wasOpen) await run(win, `document.getElementById('toggle-drawer').click()`)
  await run(win, `[...document.querySelectorAll('.drawer .tab')].find((el) => el.textContent === '过程')?.click()`)
  await wait(UI_WAIT_MS)
  const titles = await run(win, `[...document.querySelectorAll('.trace-row .trace-title')].map((row) => row.textContent)`)
  if (!wasOpen) await run(win, `document.getElementById('toggle-drawer').click()`)
  return titles
}

/** Actual current-session tool identities, not words merely mentioned in a thought or explanation. */
export async function traceToolNames(ctx: LiveContext): Promise<string[]> {
  const info = await run(ctx.win, 'window.agent.getInfo()')
  const db = new DatabaseSync(path.join(ctx.userData, 'trace.db'), { readOnly: true })
  try {
    return db.prepare("SELECT name FROM steps WHERE kind = 'tool' AND session_id = ? ORDER BY seq")
      .all(String(info.sessionId)).map(row => String(row.name ?? ''))
  } finally { db.close() }
}

/** Writes a file into the workspace (folders made as needed) and returns its full path. */
export function writeWorkspace(ctx: LiveContext, rel: string, content: string): string {
  const file = path.join(ctx.workspace, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
  return file
}

/** Writes a file outside the workspace, in this attempt's folder, and returns its full path. */
export function writeOutside(ctx: LiveContext, name: string, content: string): string {
  const file = path.join(ctx.outDir, 'outside', name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
  return file
}

/** Digits as written in an answer: thousands separators and spaces dropped. */
export const digitsOf = (text: string) => text.replace(/(?<=\d)[,，\s](?=\d)/g, '')

/** How much of the letters in `text` are Latin rather than Chinese. */
export function latinShare(text: string): number {
  const latin = (text.match(/[A-Za-z]/g) ?? []).length
  const han = (text.match(/[一-鿿]/g) ?? []).length
  return latin + han === 0 ? 0 : latin / (latin + han)
}

export const hasHan = (text: string) => /[一-鿿]/.test(text)

/** Opens 设置 on the hub (the icon by the title bar, then the sidebar). */
export async function openSettings(win: SmokeWindow) {
  await run(win, `document.getElementById('hub').dataset.open === 'true' || document.getElementById('open-profile').click()`)
  await run(win, `document.querySelector('.hub-nav[data-page="settings"]').click()`)
  await until(win, `Boolean(document.querySelector('#settings-root .settings'))`, 'the 设置 page')
  await wait(UI_WAIT_MS)
}

export async function closeHub(win: SmokeWindow) {
  await run(win, `document.getElementById('hub').dataset.open === 'true' && document.getElementById('hub-back').click()`)
  await wait(UI_WAIT_MS)
}

export const escape = (win: SmokeWindow) => run(win, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)

/** The memories the app keeps that mention `words` (valid ones only). */
export async function memoriesWith(win: SmokeWindow, words: string): Promise<Array<{ id: string, text: string }>> {
  const list = await run(win, `window.agent.listMemories(${JSON.stringify(words)})`)
  return (list?.items ?? []).filter((m: { text: string }) => m.text.includes(words))
}

/** Forgets every memory that mentions `words`, so a later attempt starts without it. */
export async function forgetMemories(win: SmokeWindow, words: string) {
  for (const memory of await memoriesWith(win, words)) await run(win, `window.agent.deleteMemory(${JSON.stringify(memory.id)})`)
}

/** Whether `file` (a database, a JSON file) holds `secret` anywhere in its bytes. */
export function fileHolds(file: string, secret: string): boolean {
  return fs.existsSync(file) && fs.readFileSync(file).includes(Buffer.from(secret))
}

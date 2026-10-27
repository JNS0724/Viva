import fs from 'node:fs/promises'
import path from 'node:path'
import type { BrowserWindow } from 'electron'
import { capture, finishTurn, newTopic, report, run, submit, wait } from './smoke-kit.ts'

/**
 * The `scroll` smoke phase: a long conversation (the fake dsh, half its answers the Markdown demo with a table, code
 * and lists), then a steady scroll up through it, measured two ways: the gaps between animation frames as the page
 * saw them, and a Chromium trace of what the frames spent their time on (style, layout, paint, script). Written to
 * smoke/scroll-profile.json. A frame over 50 ms is a stutter the eye sees.
 */
const TURNS = Number(process.env.SMOKE_SCROLL_TURNS) || 60
/** A new topic every so many turns: what was said before goes to the earlier part, loaded in pages as one scrolls up. */
const TOPIC_EVERY = 10
/** How much slower than this machine the page runs (Chromium's CPU throttling): 4 is a modest laptop. */
const CPU_SLOWDOWN = Number(process.env.SMOKE_SCROLL_CPU) || 4
/** Long enough to reach the top, where earlier topics load, in a long conversation. */
const SCROLL_MS = 8_000
const STEP_PX = 40
const TRACE_CATEGORIES = ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'blink', 'cc'].join(',')
/** Trace events that are the main thread's own work for a frame; nested ones are left out so nothing counts twice. */
const COSTS = ['UpdateLayoutTree', 'Layout', 'PrePaint', 'Paint', 'Layerize', 'UpdateLayer', 'CompositeLayers', 'HitTest', 'FunctionCall', 'EventDispatch', 'ParseHTML', 'RunTask']

const SCROLL = `new Promise((resolve) => {
  const scroll = document.getElementById('scroll')
  scroll.scrollTop = scroll.scrollHeight
  const gaps = []
  let last = performance.now()
  const end = last + ${SCROLL_MS}
  const step = (now) => {
    gaps.push(now - last)
    last = now
    scroll.scrollTop -= ${STEP_PX}
    if (now < end && scroll.scrollTop > 0) requestAnimationFrame(step)
    else resolve(gaps)
  }
  requestAnimationFrame(step)
})`

/** How long the page records frames while the window is maximized and restored (each step waits RESIZE_SETTLE_MS). */
const RESIZE_ROUNDS = 3
const RESIZE_SETTLE_MS = 600
const FRAMES = (ms: number) => `new Promise((resolve) => {
  const gaps = []
  let last = performance.now()
  const end = last + ${ms}
  const step = (now) => {
    gaps.push(now - last)
    last = now
    if (now < end) requestAnimationFrame(step)
    else resolve(gaps)
  }
  requestAnimationFrame(step)
})`

const percentile = (values: number[], p: number) => {
  const sorted = values.toSorted((a, b) => a - b)
  return sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] * 10) / 10 : 0
}

async function trace<T>(win: BrowserWindow, during: () => Promise<T>): Promise<{ result: T, events: any[] }> {
  const dbg = win.webContents.debugger
  dbg.attach('1.3')
  const events: any[] = []
  dbg.on('message', (_event, method, params) => {
    if (method === 'Tracing.dataCollected') events.push(...params.value)
  })
  await dbg.sendCommand('Emulation.setCPUThrottlingRate', { rate: CPU_SLOWDOWN })
  await dbg.sendCommand('Tracing.start', { categories: TRACE_CATEGORIES, transferMode: 'ReportEvents' })
  const result = await during()
  await dbg.sendCommand('Emulation.setCPUThrottlingRate', { rate: 1 })
  const done = new Promise<void>((resolve) => dbg.on('message', (_event, method) => { if (method === 'Tracing.tracingComplete') resolve() }))
  await dbg.sendCommand('Tracing.end')
  await done
  dbg.removeAllListeners('message')
  dbg.detach()
  return { result, events }
}

/** Main-thread time per kind of work, from complete trace events (ph X) of the renderer's main thread. */
function costs(events: any[]) {
  const main = events.find((event) => event.name === 'thread_name' && event.args?.name === 'CrRendererMain')
  const totals = new Map<string, number>()
  for (const event of events) {
    if (event.ph !== 'X' || !COSTS.includes(event.name) || (main && (event.pid !== main.pid || event.tid !== main.tid))) continue
    totals.set(event.name, (totals.get(event.name) ?? 0) + (event.dur ?? 0) / 1000)
  }
  return [...totals].map(([name, ms]) => ({ name, ms: Math.round(ms) })).toSorted((a, b) => b.ms - a.ms)
}

const frameStats = (gaps: number[]) => ({ count: gaps.length, p50: percentile(gaps, 0.5), p95: percentile(gaps, 0.95), max: percentile(gaps, 1), over50: gaps.filter((gap) => gap > 50).length })

/**
 * Maximizing and restoring the window re-wraps every message at the new width: the frames the page saw meanwhile,
 * and what the main thread spent on it.
 */
async function checkResize(win: BrowserWindow) {
  const { result: gaps, events } = await trace(win, async () => {
    const frames = run(win, FRAMES(RESIZE_ROUNDS * 2 * RESIZE_SETTLE_MS + RESIZE_SETTLE_MS)) as Promise<number[]>
    for (let round = 0; round < RESIZE_ROUNDS; round += 1) {
      win.maximize()
      await wait(RESIZE_SETTLE_MS)
      win.unmaximize()
      await wait(RESIZE_SETTLE_MS)
    }
    return frames
  })
  return { frames: frameStats(gaps), costs: costs(events).slice(0, 5) }
}

const RAIL = `(() => {
  const rail = document.getElementById('turn-rail')
  const questions = document.querySelectorAll('#scroll .msg-user:not(.msg-answer)')
  return { shown: !rail.hidden, marks: rail.children.length, questions: questions.length }
})()`
const FIRST_TURN = `(() => {
  const scroll = document.getElementById('scroll')
  const first = document.querySelector('#scroll .msg-user')
  return { top: Math.round(first.getBoundingClientRect().top - scroll.getBoundingClientRect().top), lit: document.querySelector('#turn-rail [aria-current]') === document.querySelector('#turn-rail .turn-mark') }
})()`
/** Where the first question may sit after its mark is clicked: at the top of the conversation, give or take its margin. */
const JUMP_LANDING_PX = 120

/** 按轮次跳转: a mark per question on screen; the first mark scrolls to the first question and lights; a hovered mark says its question. */
async function checkRail(win: BrowserWindow, outDir: string): Promise<string[]> {
  await wait(300)
  const rail = await run(win, RAIL)
  if (!rail.shown || rail.marks !== rail.questions) return [`turn rail: ${JSON.stringify(rail)}, expected one mark per question, shown`]
  await run(win, `document.querySelector('#turn-rail .turn-mark').click()`)
  await wait(1_000)
  const first = await run(win, FIRST_TURN)
  const problems = first.top >= 0 && first.top <= JUMP_LANDING_PX && first.lit ? [] : [`turn rail: the first mark left the first question at ${first.top}px, lit ${first.lit}`]
  const middle = await run(win, `(() => { const marks = document.querySelectorAll('#turn-rail .turn-mark'); const box = marks[Math.floor(marks.length / 2)].getBoundingClientRect(); return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) } })()`)
  win.webContents.sendInputEvent({ type: 'mouseMove', x: middle.x, y: middle.y })
  await wait(400)
  await capture(win, outDir, 'turn-rail')
  report(`turn rail: ${rail.marks} marks, first question at ${first.top}px after its mark`)
  return problems
}

export async function checkScroll(win: BrowserWindow, outDir: string): Promise<string[]> {
  for (let turn = 0; turn < TURNS; turn += 1) {
    if (turn > 0 && turn % TOPIC_EVERY === 0) {
      await newTopic(win)
      await finishTurn(win)
    }
    await submit(win, turn % 2 ? '格式演示' : `第 ${turn + 1} 个问题：把这周的进展整理一下`)
    await finishTurn(win)
  }
  await wait(1_000)
  const problems = await checkRail(win, outDir)
  const messages =await run(win, `document.querySelectorAll('#thread .msg-user, #thread .msg-agent, #earlier .msg-user, #earlier .msg-agent').length`)
  const { result: gaps, events } = await trace(win, () => run(win, SCROLL) as Promise<number[]>)
  const profile = { turns: TURNS, cpuSlowdown: CPU_SLOWDOWN, messages, frames: frameStats(gaps), costs: costs(events), resize: await checkResize(win) }
  await fs.writeFile(path.join(outDir, 'scroll-profile.json'), JSON.stringify(profile, null, 2))
  report(`scroll: ${JSON.stringify(profile)}`)
  return problems
}

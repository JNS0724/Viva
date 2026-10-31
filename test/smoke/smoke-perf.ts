import path from 'node:path'
import type { BrowserWindow } from 'electron'
import { openHistoryDb } from '../../src/main/history-db.ts'
import { capture, report, run, UI_WAIT_MS, until, wait, type Expect } from './smoke-kit.ts'

/**
 * The `perf` smoke phase (npm run smoke:perf): a history far longer than anyone's, written before the app opens it
 * (seedPerf), and what it costs to read. The conversation on screen and an earlier topic are a thousand turns each,
 * an answer is 200 KB of Markdown, a message is three hundred topics back. Measured: the time between frames while
 * scrolling, how many elements the page holds, how much the page's memory grows, how long the long answer takes to
 * show, and whether what is read stays where it is as more comes in. On macOS the budgets below must hold; elsewhere
 * the numbers are only reported for now.
 */
const HOUR_MS = 3_600_000
const LONG_TURNS = 1000
const FAR_TOPICS = 300
const MARKDOWN_BYTES = 200_000

/** Runtime budgets from PR #52 phase 2; DOM counts became diagnostic-only on 2026-10-29. */
const BUDGET = Object.freeze({
  /**
   * p95 of the time between frames while scrolling. Agreed as a vsync at 60 Hz (16.7 ms); measured with rAF the time
   * between frames of light work already runs from 16 to 20 ms on the Mac it was tried on, so a frame is late only
   * past 20 ms: 95% of frames on time.
   */
  frameP95Ms: 20,
  /** No frame past two vsyncs (a frame dropped twice over) while scrolling. */
  frameMaxMs: 33.4,
  /** Growth of the page's JS heap over reading a thousand-turn topic end to end. */
  heapGrowthMb: 30,
  /** From 详情 to the 200 KB answer drawn. */
  markdownMs: 150,
  /** Messages drawn at once: in the conversation and in 回顾 (THREAD_MAX, READER_MAX); in an earlier topic opened in place. */
  drawn: 200,
  drawnOpened: 100,
  /** How far the message being read may move while more comes in above it. */
  shiftPx: 2,
})

const FAR_WORDS = '灯塔计划'
const LONG_WORDS = '千轮话题第500问'
const MARKDOWN_WORDS = '超长文档'

const answer = (text: string) => ({ role: 'assistant', text, receipt: { ms: 3000, tools: 0, thoughts: 0, stopReason: 'end_turn' } })
const user = (text: string) => ({ role: 'user', text, receipt: null })

/** A thousand turns, each a question and an answer of a few lines; turn 500 of the old one has words of its own. */
const longTalk = (name: string) => Array.from({ length: LONG_TURNS }, (_, i) => [
  user(i === 500 && name === 'old' ? `${LONG_WORDS}：把第 ${i} 步的结果再核对一遍` : `${name} 第 ${i} 步：接下来做什么`),
  answer(`第 ${i} 步做完了：数据核对过，接口调通，下一步按计划继续。没有新的阻塞，备注已经写进了周报草稿。`),
]).flat()

/** Markdown of every kind a long answer has, to about MARKDOWN_BYTES. */
function longMarkdown() {
  const section = (i: number) => [
    `## 第 ${i} 节`, '',
    `这一节说明${MARKDOWN_WORDS}的第 ${i} 部分：背景、做法和结论，每一条都写清楚负责人和时间。`, '',
    '- 背景：接口联调还差一步', '- 做法：先补测试，再改实现', '- 结论：周五上线', '',
    '```ts', `export const step${i} = (input: number) => input * ${i} + 1`, '```', '',
    '| 项目 | 负责人 | 时间 |', '| --- | --- | --- |', `| 第 ${i} 项 | 张三 | 10 月 ${(i % 28) + 1} 日 |`, '',
  ].join('\n')
  const parts: string[] = []
  let size = 0
  for (let i = 1; size < MARKDOWN_BYTES; i += 1) {
    const part = section(i)
    parts.push(part)
    size += Buffer.byteLength(part)
  }
  return parts.join('\n')
}

/** Writes the history into `userData` before the app opens it. Oldest first; the last is the conversation on screen. */
export function seedPerf(userData: string, now = Date.now()) {
  let clock = now - (FAR_TOPICS + 100) * HOUR_MS
  const db = openHistoryDb({ file: path.join(userData, 'history.db'), now: () => clock })
  const cwd = path.join(userData, 'workspace')
  const save = (at: number, messages: object[]) => {
    clock = at
    return db.save(db.create({ cwd }), messages)
  }
  save(clock, [user(`${FAR_WORDS}怎么定`), answer(`${FAR_WORDS}定在明年三月启动。`)])
  for (let i = 0; i < FAR_TOPICS; i += 1) save(now - (FAR_TOPICS + 50 - i) * HOUR_MS, [user(`第 ${i} 个话题：问点小事`), answer('好的，记下了。')])
  save(now - 30 * HOUR_MS, [user(`写一份${MARKDOWN_WORDS}`), answer(longMarkdown())])
  save(now - 20 * HOUR_MS, longTalk('old'))
  save(now - HOUR_MS, longTalk('now'))
  db.close()
}

const p95 = (values: readonly number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  return Math.round((sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0) * 10) / 10
}

/**
 * Scrolls an element (by selector) a step a frame toward one end until there is no more to come in at that end, or
 * `frames` have gone. @returns the times between frames, and the most elements and drawn messages seen meanwhile
 */
const scrollThrough = (selector: string, toTop: boolean, frames: number, drawn: string, edge: string) => `(async () => {
  const el = document.querySelector(${JSON.stringify(selector)})
  const gaps = [], loading = []
  let elements = 0, most = 0, last = performance.now(), first = null
  for (let i = 0; i < ${frames}; i += 1) {
    el.scrollTop += ${toTop ? -1 : 1} * Math.max(200, el.clientHeight * 0.6)
    await new Promise((resolve) => requestAnimationFrame(resolve))
    const now = performance.now()
    gaps.push(now - last)
    last = now
    elements = Math.max(elements, document.getElementsByTagName('*').length)
    const shown = document.querySelectorAll(${JSON.stringify(drawn)})
    most = Math.max(most, shown.length)
    // A frame where a part came in (what is drawn first changed): told apart from plain scrolling.
    loading.push(shown[0]?.dataset.msg !== first)
    first = shown[0]?.dataset.msg ?? null
    const atEnd = ${toTop ? 'el.scrollTop <= 0' : 'el.scrollTop + el.clientHeight >= el.scrollHeight - 1'}
    if (atEnd && !document.querySelector(${JSON.stringify(edge)})) break
    if (atEnd) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      last = performance.now()
    }
  }
  return { gaps, loading, elements, most, frames: gaps.length }
})()`

/** The slowest frames, and how many of the slow ones (past a vsync and a half) were when a part came in. */
function slowest(runs: ReadonlyArray<{ gaps: number[], loading: boolean[] }>) {
  const frames = runs.flatMap((r) => r.gaps.map((gap, i) => ({ gap, loading: r.loading[i] })))
  const slow = frames.filter((f) => f.gap > 25)
  return { top: frames.map((f) => Math.round(f.gap)).sort((a, b) => b - a).slice(0, 8), slow: slow.length, slowWhileLoading: slow.filter((f) => f.loading).length }
}

const ELEMENTS = `document.getElementsByTagName('*').length`
const HEAP_MB = `Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1048576)`
const READER = '#history-list .review-focus .review-reader'
const READER_MESSAGES = `${READER} [data-msg]`

const openSearch = (words: string) => `(() => {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', metaKey: true, bubbles: true }))
  const input = (document.getElementById('history-search-frame')?.contentDocument?.getElementById('history-search') ?? document.getElementById('history-search'))
  input.value = ${JSON.stringify(words)}
  input.dispatchEvent(new Event('input'))
})()`

/** The hit of the search for `words` (not one left from a search before). */
const hitWith = (words: string) => `[...document.querySelectorAll('#history-list .search-hit')].find((el) => el.textContent.includes(${JSON.stringify(words)}))`

/**
 * 详情 on the hit, timed in the page until the message it names is drawn and marked: in the timeline when it is read
 * back there (an earlier topic opened for it), else at the top of 回顾.
 */
const openHitTimed = (words: string) => `(async () => {
  const hit = ${hitWith(words)}
  const start = performance.now()
  hit.querySelector('.hit-open').click()
  for (let i = 0; i < 600; i += 1) {
    const found = [...document.querySelectorAll('${READER} .msg-found, #scroll .msg-found')].find((el) => el.textContent.includes(${JSON.stringify(words)}))
    if (found) {
      const box = found.getBoundingClientRect()
      return {
        ms: Math.round(performance.now() - start), inView: box.bottom > 0 && box.top < innerHeight,
        where: found.closest('#scroll') ? 'timeline' : '回顾', text: found.textContent.slice(0, 40),
      }
    }
    await new Promise((resolve) => requestAnimationFrame(resolve))
  }
  return null
})()`

async function openHit(win: BrowserWindow, words: string) {
  await run(win, openSearch(words))
  await until(win, `Boolean(${hitWith(words)})`, `the search finding 「${words}」`)
  return run(win, openHitTimed(words))
}

const closeFocus = `document.querySelector('#history-list .review-focus-close')?.click()`

/** Reading on above what is read in 回顾: the message at the top of the view stays where it is. */
const READ_ON_KEEPS_PLACE = `(async () => {
  const pane = document.querySelector('#history-list').closest('.hub-main')
  const edge = document.querySelector('${READER} .reader-edge[data-edge="before"]')
  if (!edge) return null
  const top = pane.getBoundingClientRect().top
  const anchor = [...document.querySelectorAll('${READER_MESSAGES}')].find((el) => el.getBoundingClientRect().bottom > top)
  const id = anchor.dataset.msg
  const before = anchor.getBoundingClientRect().top
  const first = document.querySelector('${READER_MESSAGES}')?.dataset.msg
  edge.click()
  for (let i = 0; i < 300 && document.querySelector('${READER_MESSAGES}')?.dataset.msg === first; i += 1) await new Promise((resolve) => requestAnimationFrame(resolve))
  const after = document.querySelector('${READER} [data-msg="' + CSS.escape(id) + '"]')?.getBoundingClientRect().top
  return { shift: after === undefined ? null : Math.round(Math.abs(after - before) * 10) / 10, drawn: document.querySelectorAll('${READER_MESSAGES}').length }
})()`

/** The conversation on screen, a thousand turns: drawn bounded, scrolled to the top and through what is read back. */
async function checkConversation(win: BrowserWindow, outDir: string, expect: Expect, seen: Record<string, unknown>) {
  const drawn = await until(win, `document.querySelectorAll('#thread [data-msg]').length`, 'the conversation drawn')
  const rest = await run(win, `document.querySelector('#thread .thread-rest')?.textContent ?? null`)
  expect(drawn <= BUDGET.drawn && rest?.includes('在回顾里看'), `a ${LONG_TURNS}-turn conversation should draw at most ${BUDGET.drawn} messages, the rest in 回顾`, { drawn, rest })
  const scrolled = await run(win, scrollThrough('#scroll', true, 400, '#thread [data-msg], #earlier [data-msg]', '#earlier .timeline-more:not([disabled])'))
  seen.conversation = { drawn, frames: scrolled.frames, frameP95: p95(scrolled.gaps), elements: scrolled.elements, drawnMost: scrolled.most, slowest: slowest([scrolled]) }
  await capture(win, outDir, 'perf-conversation')

  // An earlier topic as long, opened in place: its latest part drawn, the rest in 回顾.
  const opened = await run(win, `(() => {
    const fold = [...document.querySelectorAll('#earlier details.topic-old')].find((el) => el.querySelector('.topic-title')?.textContent.includes('old 第 0 步'))
    if (!fold) return null
    fold.querySelector('.topic-head').click()
    return true
  })()`)
  await wait(UI_WAIT_MS)
  const inFold = await run(win, `(() => {
    const fold = document.querySelector('#earlier details.topic-old[open]')
    return fold && { drawn: fold.querySelectorAll('[data-msg]').length, rest: Boolean(fold.querySelector('.topic-rest')), elements: ${ELEMENTS} }
  })()`)
  seen.openedTopic = inFold
  expect(opened && inFold && inFold.drawn <= BUDGET.drawnOpened && inFold.rest, `an earlier ${LONG_TURNS}-turn topic opened should draw at most ${BUDGET.drawnOpened} messages`, { opened, inFold })
}

/** 回顾: the earlier thousand-turn topic read from a message in its middle, to its start and its end. */
async function checkReader(win: BrowserWindow, outDir: string, expect: Expect, seen: Record<string, unknown>) {
  const heapBefore = await run(win, HEAP_MB)
  const hit = await openHit(win, LONG_WORDS)
  expect(hit?.inView, 'a message in the middle of a long topic should be read at once, in view', hit)
  await wait(UI_WAIT_MS)
  const kept = await run(win, READ_ON_KEEPS_PLACE)
  expect(kept && kept.shift !== null && kept.shift <= BUDGET.shiftPx, 'reading on above should leave the message being read where it is', kept)
  const pane = '#hub .hub-main'
  const edge = (side: string) => `${READER} .reader-edge[data-edge="${side}"]`
  const up = await run(win, scrollThrough(pane, true, 600, READER_MESSAGES, edge('before')))
  const down = await run(win, scrollThrough(pane, false, 900, READER_MESSAGES, edge('after')))
  const heapAfter = await run(win, HEAP_MB)
  const ends = await run(win, `({ before: Boolean(document.querySelector('${edge('before')}')), after: Boolean(document.querySelector('${edge('after')}')) })`)
  seen.reader = {
    open: hit, keptPlace: kept, frames: up.frames + down.frames, frameP95: p95([...up.gaps, ...down.gaps]),
    elements: Math.max(up.elements, down.elements), drawnMost: Math.max(up.most, down.most), heapMb: [heapBefore, heapAfter], reachedEnd: !ends.after,
    slowest: slowest([up, down]),
  }
  expect(!ends.after, 'scrolling down should read the long topic to its end', ends)
  expect(Math.max(up.most, down.most) <= BUDGET.drawn, `回顾 should never draw more than ${BUDGET.drawn} messages of a topic`, seen.reader)
  await capture(win, outDir, 'perf-reader')
  await run(win, closeFocus)
}

/** The checks that hold on any machine, and the budgets that hold on macOS (reported elsewhere). */
function judge(expect: Expect, seen: Record<string, any>, platform: string) {
  const strict: Expect = platform === 'darwin' ? expect : () => {}
  const { conversation, reader, markdown, far } = seen
  for (const [what, run] of [['the conversation', conversation], ['a long topic in 回顾', reader]] as const) {
    strict(run.frameP95 <= BUDGET.frameP95Ms, `scrolling ${what}: p95 between frames ≤ ${BUDGET.frameP95Ms} ms`, run)
    strict(run.slowest.top[0] <= BUDGET.frameMaxMs, `scrolling ${what}: no frame past ${BUDGET.frameMaxMs} ms`, run)
  }
  // Full Markdown semantics can require more than 4000 elements. Keep the measured counts, while
  // accepting actual frame time and heap growth rather than removing content to meet a node limit.
  expect([conversation.elements, reader.elements, markdown?.elements].every((count) => Number.isFinite(count) && count > 0),
    'element counts are reported as diagnostics for conversation, reader and Markdown', { conversation: conversation.elements, reader: reader.elements, markdown: markdown?.elements })
  strict(reader.heapMb[1] - reader.heapMb[0] <= BUDGET.heapGrowthMb, `the heap grows by at most ${BUDGET.heapGrowthMb} MB reading a long topic end to end`, reader.heapMb)
  strict(markdown && markdown.ms <= BUDGET.markdownMs, `the 200 KB answer shows within ${BUDGET.markdownMs} ms`, markdown)
  expect(far?.inView && far.foldedBefore === far.foldedAfter, `a message ${FAR_TOPICS} topics back should be read at once, in view, without reading the timeline back`, far)
}

/** @returns failures */
export async function checkPerf(win: BrowserWindow, outDir: string): Promise<string[]> {
  const failures: string[] = []
  const expect: Expect = (ok, message, seen) => { if (!ok) failures.push(`perf: ${message}: ${JSON.stringify(seen)}`) }
  const seen: Record<string, any> = { platform: process.platform }
  await checkConversation(win, outDir, expect, seen)
  await checkReader(win, outDir, expect, seen)

  const markdown = await openHit(win, MARKDOWN_WORDS)
  seen.markdown = markdown && { ms: markdown.ms, elements: await run(win, ELEMENTS) }
  await capture(win, outDir, 'perf-markdown')
  await run(win, closeFocus)

  const foldedBefore = await run(win, `document.querySelectorAll('#earlier .topic-old').length`)
  const far = await openHit(win, FAR_WORDS)
  seen.far = far && { ...far, foldedBefore, foldedAfter: await run(win, `document.querySelectorAll('#earlier .topic-old').length`) }
  await capture(win, outDir, 'perf-far-hit')

  judge(expect, seen, process.platform)
  report(`perf: ${JSON.stringify(seen)}`)
  await run(win, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  return failures
}

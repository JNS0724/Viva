import { ask, clip, escape, fresh, type LiveContext, type LiveScenario } from './live-kit.ts'
import { run, until, UI_WAIT_MS, wait, type SmokeWindow } from './smoke-kit.ts'

/**
 * Live scenarios (live.ts) for schedules, natural language first: the model proposes one from what was said, the card
 * says when and what it will do, 定时 keeps it; then it is changed and deleted by asking, as it would be by anyone.
 */
const LAST_CARD = `[...document.querySelectorAll('#thread .fu-card[aria-label="要我定时做吗？"]')].at(-1)`
const PAGE = '#feed-page'
const CARD_WAIT_MS = 30_000

/** Says `words`, and returns the proposal card's text, or null when no card came. */
async function propose(win: SmokeWindow, words: string) {
  const out = await ask(win, words, { answer: '*' })
  const card: string | null = await until(win, `${LAST_CARD}?.textContent ?? null`, 'the proposal card', CARD_WAIT_MS).catch(() => null)
  return { out, card }
}

/** 定时 on the newest card. */
async function accept(win: SmokeWindow) {
  await run(win, `[...(${LAST_CARD}).querySelectorAll('button')].find((b) => b.textContent === '定时').click()`)
  await wait(UI_WAIT_MS * 2)
}

/** Opens 动态 and returns its rows in 接下来 (the schedules), as shown. */
async function scheduleRows(ctx: LiveContext): Promise<string[]> {
  if (await run(ctx.win, `document.getElementById('feed-page').hidden`)) await run(ctx.win, `document.getElementById('open-feed').click()`)
  await until(ctx.win, `!document.getElementById('feed-page').hidden`, 'the 动态 page')
  await wait(UI_WAIT_MS)
  return run(ctx.win, `[...document.querySelectorAll('${PAGE} .fu-row[data-status="active"], ${PAGE} .fu-row[data-status="paused"]')].map((row) => row.textContent)`)
}

/** The Wednesdays 「下周三」 can mean from today, as the card may write them. */
function wednesdays(now = new Date()): string[] {
  const days: string[] = []
  for (let ahead = 1; ahead <= 14; ahead += 1) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + ahead)
    if (day.getDay() === 3) days.push(`${day.getMonth() + 1}月${day.getDate()}日`, `${day.getMonth() + 1}/${day.getDate()}`)
  }
  return days
}

const schedulePropose: LiveScenario = {
  id: 'schedule-propose',
  title: '「到时候帮我…」出现定时卡片，时间对；点「定时」后在动态的「接下来」里',
  feature: '定时任务',
  core: true,
  async run(ctx) {
    const { win, expect } = ctx
    await fresh(win)
    const { out, card } = await propose(win, '下周三下午三点前要交季度报告，到时候帮我起草一下。')
    expect(card !== null, 'the model should propose a schedule', clip(out.answer))
    if (!card) return
    expect(card.includes('季度报告'), 'the card should say what it is about', clip(card, 300))
    expect(card.includes('周三') || wednesdays().some((day) => card.includes(day)), 'the card should say when, on the Wednesday meant', clip(card, 300))
    await ctx.shot('schedule-card')
    await accept(win)
    const rows = await scheduleRows(ctx)
    expect(rows.some((row) => row.includes('季度报告')), 'kept, the schedule should be in 接下来', rows)
    await ctx.shot('schedule-listed')
    await escape(win)
  },
}

const scheduleByTalk: LiveScenario = {
  id: 'schedule-by-talk',
  title: '在对话里说「改到九点」「删掉它」，定时就改了、删了',
  feature: '定时任务',
  async run(ctx) {
    const { win, expect, tag } = ctx
    await fresh(win)
    const name = `日报-${tag}`
    const { out, card } = await propose(win, `每天下午六点提醒我写${name}。`)
    expect(card !== null, 'the model should propose a daily schedule', clip(out.answer))
    if (!card) return
    await accept(win)
    await escape(win)
    const changed = await ask(win, `把「${name}」那个定时改到晚上九点。`)
    let rows = await scheduleRows(ctx)
    expect(rows.some((row) => row.includes(name) && row.includes('21:00')), 'asked, its time should change', { answer: clip(changed.answer), rows })
    await escape(win)
    const deleted = await ask(win, `「${name}」那个定时不要了，删掉吧。`)
    rows = await scheduleRows(ctx)
    expect(!rows.some((row) => row.includes(name)), 'asked, it should be gone', { answer: clip(deleted.answer), rows })
    await escape(win)
  },
}

export const SCHEDULE_SCENARIOS: readonly LiveScenario[] = [schedulePropose, scheduleByTalk]

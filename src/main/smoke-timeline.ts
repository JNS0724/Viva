import path from 'node:path'
import type { BrowserWindow } from 'electron'
import { openHistoryDb } from './history-db.ts'
import { capture, report, run, UI_WAIT_MS, until, wait, type Expect } from './smoke-kit.ts'

/**
 * The `timeline` smoke phase: a timeline weeks long, written into the run's own history before the app opens
 * (seedTimeline), then what a long one looks like. Scrolling up reads back the recent days only, each earlier topic
 * folded to a line, a dot on the rail; a folded topic opens in place; a message is starred; 回顾 lists the topics by
 * month and day, filters them, opens one to read, and lists what is starred.
 */
const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000

type Seed = { daysAgo: number, hour: number, talk: string[], files?: string[], star?: number, task?: boolean }

/** Oldest first; the last is the conversation on screen. A task hangs off the topic before it. */
const SEEDS: readonly Seed[] = [
  { daysAgo: 35, hour: 10.5, talk: ['季度目标对齐会的纪要帮我理一下', '三条结论：一、Q4 先做对账重构；二、客服工单系统延后；三、每周五同步进度。', '把第二条展开写写', '工单系统延后到明年一月，原因是人手：两位后端在对账重构上。'] },
  { daysAgo: 20, hour: 15, talk: ['帮我比较一下两家云服务的报价', '按一年 8 台 4 核 16G 算，A 家 6.2 万，B 家 5.4 万；B 家带宽另算。'] },
  { daysAgo: 12, hour: 9.6, talk: ['把这几张发票按公司模板整理成报销单', '整理好了：3 张发票，合计 1,286 元，报销单在 Viva 的文件/报销单-10月.xlsx。'], files: ['/Users/me/Downloads/发票-滴滴.pdf', '/Users/me/Downloads/发票-酒店.pdf'] },
  { daysAgo: 9, hour: 16.1, talk: ['帮我写一下 beta.4 的更新说明，口语一点', '这一版主要是 Windows 上的修复：岛一直在最上层，长标题末尾省略，停止更及时。', '再短一点', 'Windows 上更稳了：岛不再被挡住，停下更快。'] },
  { daysAgo: 8, hour: 11, talk: ['周会的会议室改到几楼了', '改到 3 楼大会议室了，周三 14:00。'] },
  { daysAgo: 3, hour: 14.3, talk: ['把这周的进展整理一下，发给组里', '本周三件事：对账系统重构按计划推进；接口联调还差一步；上线改到周五。周报模板在 共享盘/行政/周报模板.docx。', '先别发，加上下周计划', '加好了：下周完成联调，周五上线。'], star: 1 },
  { daysAgo: 3, hour: 15.2, talk: ['整理 notes 文件夹里的会议纪要', '整理好了，共 6 份，按日期合成了一份 会议纪要-10月.md。'], task: true },
  { daysAgo: 2, hour: 20.5, talk: ['杭州周边有什么两天一夜的地方', '莫干山、千岛湖、桐庐都合适；开车两小时内，莫干山最近。', '莫干山住哪儿好', '想安静住庾村附近的民宿，想看山住半山腰的。'] },
  { daysAgo: 1, hour: 11, talk: ['下周三的会议定在哪个会议室？', '下周三 14:00 的项目例会在 3 楼大会议室。'] },
  { daysAgo: 0, hour: -0.5, talk: ['帮我列一下季度复盘 PPT 的大纲', '一共六页：目标回顾、完成情况、问题、原因、下季度计划、需要的支持。', '第三页写什么', '列三个最大的问题，每个一句现象一句影响。', '下季度计划要几条', '三到五条，每条带负责人和时间。', '最后一页呢', '写需要哪些支持：人手、预算、跨组配合。'] },
]

const messagesOf = (seed: Seed) => seed.talk.map((text, i) => (i % 2
  ? { role: 'assistant', text, receipt: { ms: 4200, tools: 1, thoughts: 1, stopReason: 'end_turn' } }
  : { role: 'user', text: i === 0 && seed.files ? `${text}\n\n附带的文件（本机路径）：\n${seed.files.map((file) => `- ${file}`).join('\n')}` : text, receipt: null }))

/** Writes the timeline into `userData`'s history before the app opens it. */
export function seedTimeline(userData: string, now = Date.now()) {
  let clock = 0
  const db = openHistoryDb({ file: path.join(userData, 'history.db'), now: () => clock })
  const today = new Date(now).setHours(0, 0, 0, 0)
  let previous: string | null = null
  for (const seed of SEEDS) {
    clock = seed.hour < 0 ? now + seed.hour * HOUR_MS : today - seed.daysAgo * DAY_MS + seed.hour * HOUR_MS
    const saved = db.save(db.create({ cwd: path.join(userData, 'workspace') }), messagesOf(seed))
    if (seed.task && previous) db.fold(saved.id, { into: previous, at: 0, kind: 'side' })
    if (seed.star !== undefined) db.setStar(saved.id, seed.star, true)
    if (!seed.task) previous = saved.id
  }
  db.close()
}

const TIMELINE = `(() => {
  const folded = [...document.querySelectorAll('#earlier .topic-old')]
  const marks = [...document.querySelectorAll('#turn-rail .turn-mark')]
  return {
    folded: folded.length, open: folded.filter((el) => el.open).length,
    titles: folded.map((el) => el.querySelector('.topic-title')?.textContent ?? ''),
    more: document.querySelector('#earlier .timeline-more')?.textContent ?? null,
    dots: marks.filter((mark) => mark.classList.contains('turn-topic')).length,
    lines: marks.filter((mark) => !mark.classList.contains('turn-topic')).length,
  }
})()`

const openFolded = (title: string) => `(() => {
  const fold = [...document.querySelectorAll('#earlier .topic-old')].find((el) => el.querySelector('.topic-title')?.textContent.includes(${JSON.stringify(title)}))
  fold.querySelector('.topic-head').click()
  fold.scrollIntoView({ block: 'start' })
  return fold.open
})()`

const REVIEW = `(() => ({
  months: [...document.querySelectorAll('#history-list .review-month-head')].map((el) => el.textContent),
  days: [...document.querySelectorAll('#history-list .review-day-head')].map((el) => el.textContent),
  topics: [...document.querySelectorAll('#history-list .review-topic .review-title')].map((el) => el.textContent),
  tasks: document.querySelectorAll('#history-list .review-kind').length,
  page: document.getElementById('hub').dataset.open,
}))()`

const hoverMiddleDot = async (win: BrowserWindow) => {
  const at = await run(win, `(() => {
    const dots = document.querySelectorAll('#turn-rail .turn-topic')
    const box = dots[Math.floor(dots.length / 2)].getBoundingClientRect()
    return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) }
  })()`)
  win.webContents.sendInputEvent({ type: 'mouseMove', x: at.x, y: at.y })
}

/** Scrolling up, folded topics and the rail; one opened; a star put on a message of the conversation on screen. */
async function checkFolded(win: BrowserWindow, outDir: string, expect: Expect) {
  const seen = await until(win, `(() => { const seen = ${TIMELINE}; return seen.folded >= 5 && seen })()`, 'the earlier topics folded above the conversation')
  expect(seen.open === 0 && seen.titles.some((title: string) => title.includes('把这周的进展整理一下')), 'earlier topics should be folded to a line named by their first question', seen)
  expect(seen.more?.includes('回顾'), 'past the recent days, the top should point to 回顾 instead of reading further back', seen)
  expect(seen.dots === seen.folded && seen.lines === 4, 'the rail: a dot per earlier topic, a line per question of this one', seen)
  await run(win, `document.getElementById('scroll').scrollTop = 0`)
  await wait(UI_WAIT_MS)
  await hoverMiddleDot(win)
  await wait(UI_WAIT_MS)
  await capture(win, outDir, 'timeline-folded')

  const opened = await run(win, openFolded('把这周的进展整理一下'))
  await wait(UI_WAIT_MS)
  const starred = await until(win, `document.querySelector('#earlier .topic-old[open] .star-btn[aria-pressed="true"]') && true`, 'the starred message shown with its star in the opened topic')
  expect(opened && starred, 'a folded topic should open in place, its starred message marked', { opened, starred })
  await capture(win, outDir, 'timeline-open')

  const star = await run(win, `(() => {
    const answer = [...document.querySelectorAll('#thread .msg-agent[data-msg]')].at(-1)
    answer.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    answer.querySelector('.star-btn').click()
    return true
  })()`)
  const kept = await until(win, `window.agent.starredMessages().then((items) => items.length === 2 && items)`, 'the star put on the latest answer kept')
  expect(star && kept[0].text.includes('人手'), 'a star put on in the conversation should be kept, newest first', kept)
}

/** 回顾: by month and day, filtered to background tasks, a topic read in place, the starred messages. */
async function checkReview(win: BrowserWindow, outDir: string, expect: Expect) {
  await run(win, `document.querySelector('#earlier .timeline-more').click()`)
  const listed = await until(win, `(() => { const seen = ${REVIEW}; return seen.topics.length >= 9 && seen })()`, '回顾 listing the topics')
  expect(listed.page === 'true' && listed.months.length === 2 && listed.days.includes('今天') && listed.days.includes('昨天'),
    '回顾 should open on the topics by month and day, newest first', listed)
  await wait(UI_WAIT_MS)
  await capture(win, outDir, 'review')

  await run(win, `[...document.querySelectorAll('#history-list .review-filter')].find((el) => el.textContent === '后台任务').click()`)
  const tasks = await until(win, `(() => { const seen = ${REVIEW}; return seen.topics.length === 1 && seen })()`, 'the 后台任务 filter')
  expect(tasks.tasks === 1 && tasks.topics[0].includes('会议纪要'), 'the filter should keep the background task only', tasks)
  await run(win, `[...document.querySelectorAll('#history-list .review-filter')].find((el) => el.textContent === '全部').click()`)

  await run(win, `[...document.querySelectorAll('#history-list .review-row')].find((el) => el.textContent.includes('把这周的进展')).click()`)
  const read = await until(win, `document.querySelectorAll('#history-list .review-reader [data-msg]').length`, 'a topic read in 回顾')
  expect(read === 4, 'the topic opened should show its messages', read)
  await wait(UI_WAIT_MS)
  await capture(win, outDir, 'review-open')

  await run(win, `[...document.querySelectorAll('#history-list .review-filter')].find((el) => el.textContent === '收藏').click()`)
  const stars = await until(win, `document.querySelectorAll('#history-list .review-star').length`, 'the 收藏 list')
  expect(stars === 2, 'the 收藏 list should show both starred messages', stars)
  await wait(UI_WAIT_MS)
  await capture(win, outDir, 'review-stars')
  await run(win, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
}

/** @returns failures */
export async function checkTimeline(win: BrowserWindow, outDir: string): Promise<string[]> {
  const failures: string[] = []
  const expect: Expect = (ok, message, seen) => { if (!ok) failures.push(`timeline: ${message}: ${JSON.stringify(seen)}`) }
  await checkFolded(win, outDir, expect)
  await checkReview(win, outDir, expect)
  report(`timeline: ${failures.length ? 'problems' : 'folded topics, the rail, stars and 回顾 as expected'}`)
  return failures
}

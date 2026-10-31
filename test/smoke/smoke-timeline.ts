import fs from 'node:fs'
import path from 'node:path'
import type { BrowserWindow } from 'electron'
import { openHistoryDb } from '../../src/main/history-db.ts'
import { capture, report, run, UI_WAIT_MS, until, wait, type Expect } from './smoke-kit.ts'

/**
 * The `timeline` smoke phase: a timeline weeks long, written into the run's own history before the app opens
 * (seedTimeline), then what a long one looks like. Scrolling up reads back the recent days only, each earlier topic
 * folded to a line, a dot on the rail; a folded topic opens in place; a message is starred; 回顾 lists the topics by
 * month and day, filters them, opens one to read, and lists what is starred.
 */
const HOUR_MS = 3_600_000

/** Calendar offsets keep fixtures on their intended local day, including midnight and DST boundaries. */
export function timelineSeedTime(now: number, daysAgo: number, hour: number): number {
  const day = new Date(now)
  day.setDate(day.getDate() - daysAgo)
  day.setHours(0, 0, 0, 0)
  if (hour < 0) return Math.max(day.getTime(), now + hour * HOUR_MS)
  day.setHours(Math.floor(hour), Math.round((hour % 1) * 60), 0, 0)
  return day.getTime()
}

/**
 * `continues`: the seed (by index) whose topic it goes on (继续这个话题, days later). `cwd`: where it was talked in
 * when not the workspace: another folder that is there ('other'), or one that is not any more ('gone').
 */
type Seed = { daysAgo: number, hour: number, talk: string[], files?: string[], star?: number, task?: boolean, continues?: number, cwd?: 'other' | 'gone' }
/** The folders of the seeds talked in elsewhere, within the run's own userData. */
export const seedDir = (userData: string, cwd: Seed['cwd']) => (cwd === 'other' ? path.join(userData, 'other-project') : cwd === 'gone' ? path.join(userData, 'deleted-project') : path.join(userData, 'workspace'))

/** Oldest first; the last is the conversation on screen. A task hangs off the topic before it. */
const SEEDS: readonly Seed[] = [
  { daysAgo: 35, hour: 10.5, talk: ['季度目标对齐会的纪要帮我理一下', '三条结论：一、Q4 先做对账重构；二、客服工单系统延后；三、每周五同步进度。', '把第二条展开写写', '工单系统延后到明年一月，原因是人手：两位后端在对账重构上。'], star: 1 },
  { daysAgo: 20, hour: 15, talk: ['帮我比较一下两家云服务的报价', '按一年 8 台 4 核 16G 算，A 家 6.2 万，B 家 5.4 万；B 家带宽另算。'] },
  { daysAgo: 12, hour: 9.6, talk: ['把这几张发票按公司模板整理成报销单', '整理好了：3 张发票，合计 1,286 元，报销单在 Viva 的文件/报销单-10月.xlsx。'], files: ['/Users/me/Downloads/发票-滴滴.pdf', '/Users/me/Downloads/发票-酒店.pdf'] },
  { daysAgo: 9, hour: 16.1, talk: ['帮我写一下 beta.4 的更新说明，口语一点', '这一版主要是 Windows 上的修复：岛一直在最上层，长标题末尾省略，停止更及时。', '再短一点', 'Windows 上更稳了：岛不再被挡住，停下更快。'], cwd: 'gone' },
  { daysAgo: 8, hour: 11, talk: ['周会的会议室改到几楼了', '改到 3 楼大会议室了，周三 14:00。'], cwd: 'other' },
  { daysAgo: 3, hour: 14.3, talk: ['把这周的进展整理一下，发给组里', '本周三件事：对账系统重构按计划推进；接口联调还差一步；上线改到周五。周报模板在 共享盘/行政/周报模板.docx。', '先别发，加上下周计划', '加好了：下周完成联调，周五上线。'], star: 1 },
  { daysAgo: 3, hour: 15.2, talk: ['整理 notes 文件夹里的会议纪要', '整理好了，共 6 份，按日期合成了一份 会议纪要-10月.md。'], task: true, star: 1 },
  { daysAgo: 2, hour: 20.5, talk: ['杭州周边有什么两天一夜的地方', '莫干山、千岛湖、桐庐都合适；开车两小时内，莫干山最近。', '莫干山住哪儿好', '想安静住庾村附近的民宿，想看山住半山腰的。'] },
  { daysAgo: 1, hour: 9.5, talk: ['B 家的带宽怎么算', '按峰值 100M 算，一年约 0.9 万，加上后 B 家 6.3 万，比 A 家略贵。'], continues: 1 },
  { daysAgo: 1, hour: 11, talk: ['下周三的会议定在哪个会议室？', '下周三 14:00 的项目例会在 3 楼大会议室。'] },
  { daysAgo: 0, hour: -0.5, talk: ['帮我列一下季度复盘 PPT 的大纲', '一共六页：目标回顾、完成情况、问题、原因、下季度计划、需要的支持。', '第三页写什么', '列三个最大的问题，每个一句现象一句影响。', '下季度计划要几条', '三到五条，每条带负责人和时间。', '最后一页呢', '写需要哪些支持：人手、预算、跨组配合。'] },
]

const SEEDED_STARS = SEEDS.filter((seed) => seed.star !== undefined).length

const messagesOf = (seed: Seed) => seed.talk.map((text, i) => (i % 2
  ? { role: 'assistant', text, receipt: { ms: 4200, tools: 1, thoughts: 1, stopReason: 'end_turn' } }
  : { role: 'user', text: i === 0 && seed.files ? `${text}\n\n附带的文件（本机路径）：\n${seed.files.map((file) => `- ${file}`).join('\n')}` : text, receipt: null }))

/** Writes the timeline into `userData`'s history before the app opens it. */
export function seedTimeline(userData: string, now = Date.now()) {
  let clock = 0
  const db = openHistoryDb({ file: path.join(userData, 'history.db'), now: () => clock })
  let previous: string | null = null
  const ids: string[] = []
  fs.mkdirSync(seedDir(userData, 'other'), { recursive: true })
  for (const seed of SEEDS) {
    clock = timelineSeedTime(now, seed.daysAgo, seed.hour)
    // A task is started from the conversation (task-ipc.ts start); a topic gone on goes on from its segment.
    const parentId: string | null = seed.task ? previous : seed.continues === undefined ? null : ids[seed.continues]
    const saved: { id: string } = db.save(db.create({ cwd: seedDir(userData, seed.cwd), parentId }), messagesOf(seed))
    if (seed.task && previous) db.fold(saved.id, { into: previous, at: 0, kind: 'side' })
    if (seed.star !== undefined) db.setStar(saved.id, seed.star, true)
    if (!seed.task) previous = saved.id
    ids.push(saved.id)
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
  topics: [...document.querySelectorAll('#history-list .review-topic > .review-row .review-title')].map((el) => el.textContent),
  metas: [...document.querySelectorAll('#history-list .review-topic > .review-row .review-meta')].map((el) => el.textContent),
  tasks: [...document.querySelectorAll('#history-list .review-task .review-title')].map((el) => el.textContent),
  page: document.getElementById('hub').dataset.open,
}))()`

/** The record read at the top (opened from a hit, a link or a star): its title, the message marked, any notice. */
const FOCUS = `(() => {
  const focus = document.querySelector('#history-list .review-focus')
  const found = focus?.querySelector('.review-reader .msg-found')
  return focus && found && {
    title: focus.querySelector('.review-title')?.textContent ?? '', found: found.textContent,
    notice: focus.querySelector('.review-notice')?.textContent ?? null,
    resume: focus.querySelector('.review-reader-actions .btn')?.textContent ?? null,
  }
})()`

const hoverMiddleDot = async (win: BrowserWindow) => {
  const at = await run(win, `(() => {
    const dots = document.querySelectorAll('#turn-rail .turn-topic')
    const box = dots[Math.floor(dots.length / 2)].getBoundingClientRect()
    return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) }
  })()`)
  win.webContents.sendInputEvent({ type: 'mouseMove', x: at.x, y: at.y })
}

/** How many questions a long topic is given to see that every mark of the rail stays in the window. */
const MANY_QUESTIONS = 150

/**
 * A topic far longer than the window: questions added to the thread for a moment (no render happens meanwhile), and
 * every mark of the rail inside the window, the last one the element found where it is drawn.
 */
const MANY_MARKS = `(async () => {
  const thread = document.getElementById('thread')
  const added = Array.from({ length: ${MANY_QUESTIONS} }, (_, i) => {
    const el = document.createElement('div')
    el.className = 'msg-user'
    el.textContent = '第 ' + (i + 1) + ' 个问题'
    return thread.appendChild(el)
  })
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  const marks = [...document.querySelectorAll('#turn-rail .turn-mark')]
  const outside = marks.filter((mark) => { const box = mark.getBoundingClientRect(); return box.top < 0 || box.bottom > innerHeight })
  const last = marks.at(-1).getBoundingClientRect()
  const reachable = document.elementFromPoint(last.left + last.width / 2, last.top + last.height / 2) === marks.at(-1)
  for (const el of added) el.remove()
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  return { marks: marks.length, outside: outside.length, reachable, lastBottom: Math.round(last.bottom), height: innerHeight }
})()`

/** Scrolling up, folded topics and the rail; one opened; a star put on a message of the conversation on screen. */
async function checkFolded(win: BrowserWindow, outDir: string, expect: Expect) {
  const seen = await until(win, `(() => { const seen = ${TIMELINE}; return seen.folded >= 5 && seen })()`, 'the earlier topics folded above the conversation')
  expect(seen.open === 0 && seen.titles.some((title: string) => title.includes('把这周的进展整理一下')), 'earlier topics should be folded to a line named by their first question', seen)
  expect(seen.more?.includes('回顾'), 'past the recent days, the top should point to 回顾 instead of reading further back', seen)
  expect(seen.dots === seen.folded && seen.lines === 4, 'the rail: a dot per earlier topic, a line per question of this one', seen)
  const many = await run(win, MANY_MARKS)
  expect(many.marks >= MANY_QUESTIONS && many.outside === 0 && many.reachable, 'with many questions every mark of the rail should stay in the window, the last one reachable', many)
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
  const kept = await until(win, `window.agent.starredMessages().then((items) => items.length === ${SEEDED_STARS + 1} && items)`, 'the star put on the latest answer kept')
  expect(star && kept[0].text.includes('人手'), 'a star put on in the conversation should be kept, newest first', kept)
}

const clickFilter = (name: string) => `[...document.querySelectorAll('#history-list .review-filter')].find((el) => el.textContent === ${JSON.stringify(name)}).click()`
const clickTopic = (words: string) => `[...document.querySelectorAll('#history-list .review-topic > .review-row')].find((el) => el.textContent.includes(${JSON.stringify(words)})).click()`
/** The agent as it is: reading the history must leave its session and directory as they are. */
const AGENT = `window.agent.getInfo().then((info) => ({ sessionId: info.sessionId ?? null, cwd: info.cwd ?? null }))`

/** 回顾: topics by when last talked in, filtered over whole topics, a topic read in place, the starred messages. */
async function checkReview(win: BrowserWindow, outDir: string, expect: Expect) {
  await run(win, `document.querySelector('#earlier .timeline-more').click()`)
  const listed = await until(win, `(() => { const seen = ${REVIEW}; return seen.topics.length >= 9 && seen })()`, '回顾 listing the topics')
  expect(listed.page === 'true' && listed.months.length >= 2 && listed.months.length <= 3 && listed.days.includes('今天') && listed.days.includes('昨天'),
    '回顾 should open on the topics by month and day, newest first', listed)
  const gone = listed.topics.indexOf('帮我比较一下两家云服务的报价')
  expect(gone >= 0 && listed.metas[gone].includes('开始于') && listed.topics.filter((title: string) => title.includes('B 家的带宽')).length === 0,
    'a topic gone on yesterday should be one line, placed by when it was last talked in, saying when it began', listed)
  await wait(UI_WAIT_MS)
  await capture(win, outDir, 'review')

  await run(win, clickFilter('后台任务'))
  const tasks = await until(win, `(() => { const seen = ${REVIEW}; return seen.topics.length === 1 && seen })()`, 'the 后台任务 filter')
  expect(tasks.topics[0].includes('把这周的进展') && tasks.tasks.length === 1 && tasks.tasks[0].includes('会议纪要'),
    'the filter should keep the topic with a background task, the task under it', tasks)
  await run(win, clickFilter('全部'))
  await until(win, `(() => { const seen = ${REVIEW}; return seen.topics.length >= 9 && seen })()`, '回顾 listing all topics again')

  await run(win, clickTopic('把这周的进展'))
  const read = await until(win, `document.querySelectorAll('#history-list .review-reader [data-msg]').length`, 'a topic read in 回顾')
  expect(read === 4, 'the topic opened should show its messages', read)
  await wait(UI_WAIT_MS)
  await capture(win, outDir, 'review-open')

  // A topic too old for the timeline, read only here: its star is read back for it.
  await run(win, clickTopic('季度目标对齐会'))
  const oldStar = await until(win, `document.querySelector('#history-list .review-reader .star-btn[aria-pressed="true"]') && true`, 'the star of a topic read only in 回顾')
  expect(oldStar, 'a topic read only in 回顾 should show the star it has', oldStar)

  await run(win, clickFilter('收藏'))
  const stars = await until(win, `document.querySelectorAll('#history-list .review-star').length`, 'the 收藏 list')
  expect(stars === SEEDED_STARS + 1, 'the 收藏 list should show every starred message', stars)
  await wait(UI_WAIT_MS)
  await capture(win, outDir, 'review-stars')

  // 详情 on a background task's message: read at the top where it is kept, the 收藏 list still below.
  await run(win, `[...document.querySelectorAll('#history-list .review-star')].find((el) => el.textContent.includes('会议纪要-10月')).querySelector('.btn-outline').click()`)
  const task = await until(win, FOCUS, '详情 on a message of a background task reading it in 回顾')
  const filter = await run(win, `document.querySelector('#history-list .review-filter[aria-pressed="true"]')?.textContent`)
  expect(task.found.includes('会议纪要-10月') && filter === '收藏' && task.resume === null,
    '详情 should read the task at that message, at the top of the list it was opened from', { task, filter })
  await run(win, `document.querySelector('#history-list .review-focus .btn-text').click()`)
}

/**
 * 详情 on a search hit five weeks back, far past what the timeline has read: read straight where it is kept, at the
 * top of the results, with 继续这个话题; nothing more read into the timeline, and the agent left as it was.
 */
async function checkFarHit(win: BrowserWindow, outDir: string, expect: Expect) {
  const FOLDED = `document.querySelectorAll('#earlier .topic-old').length`
  const before = await run(win, FOLDED)
  const agent = await run(win, AGENT)
  await run(win, `(() => {
    const field = (document.getElementById('history-search-frame')?.contentDocument?.getElementById('history-search') ?? document.getElementById('history-search'))
    field.value = '工单系统'
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await until(win, `document.querySelectorAll('#history-list .search-hit').length`, 'the search finding the old message')
  await run(win, `document.querySelector('#history-list .search-hit .hit-open').click()`)
  const far = await until(win, FOCUS, '详情 on an old hit reading it in 回顾')
  const folded = await run(win, FOLDED)
  const agentAfter = await run(win, AGENT)
  expect(far.found.includes('工单系统') && far.title.includes('季度目标对齐会') && far.resume === '继续这个话题',
    'an old hit should be read where it is kept, marked, with 继续这个话题', far)
  expect(folded === before, 'reading an old hit should not read the timeline back for it', { before, folded })
  expect(JSON.stringify(agentAfter) === JSON.stringify(agent), 'reading the history should leave the agent on its conversation and directory', { agent, agentAfter })
  await wait(UI_WAIT_MS)
  await capture(win, outDir, 'review-far-hit')
  await run(win, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
}

const RESUME_SHEET = `(() => {
  const sheet = document.querySelector('#resume-root .resume-sheet')
  return sheet && {
    title: sheet.querySelector('.workdir-sheet-title')?.textContent ?? '', dir: sheet.querySelector('.resume-dir')?.textContent ?? null,
    text: sheet.textContent, buttons: [...sheet.querySelectorAll('button')].map((button) => button.textContent),
  }
})()`

/** 回顾 opened, a topic read, 继续这个话题 pressed: the dialog it brings up. */
async function continueFromReview(win: BrowserWindow, words: string) {
  // 回顾 is the page with nothing typed: what a search before left in the field is cleared.
  await run(win, `(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }))
    const field = (document.getElementById('history-search-frame')?.contentDocument?.getElementById('history-search') ?? document.getElementById('history-search'))
    field.value = ''
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await until(win, `document.querySelector('#history-list .review-filter') && true`, '回顾 with its filters')
  await run(win, clickFilter('全部'))
  await until(win, `(() => { const seen = ${REVIEW}; return seen.topics.some((title) => title.includes(${JSON.stringify(words)})) })()`, `回顾 listing 「${words}」`)
  await run(win, clickTopic(words))
  await until(win, `document.querySelector('#history-list .review-reader-actions .btn') && true`, `「${words}」 read, with 继续这个话题`)
  await run(win, `document.querySelector('#history-list .review-reader-actions .btn').click()`)
  return until(win, RESUME_SHEET, `the dialog for 「${words}」`)
}

/**
 * 继续这个话题 in the window: another folder said before switching (and nothing switched on 取消); a folder gone asks
 * for another; a session gone (the seeds have none) goes on from the topic's records in a new conversation.
 */
async function checkResume(win: BrowserWindow, outDir: string, expect: Expect) {
  const agent = await run(win, AGENT)
  const other = await continueFromReview(win, '周会的会议室')
  expect(other.title === '换到这个话题的目录接着聊' && other.dir?.endsWith('other-project'), 'another folder should be said before switching to it', other)
  await wait(UI_WAIT_MS)
  await capture(win, outDir, 'resume-confirm-dir')
  await run(win, `document.querySelector('#resume-root .btn-secondary').click()`)
  expect(JSON.stringify(await run(win, AGENT)) === JSON.stringify(agent), '取消 should leave the agent where it was', agent)

  const gone = await continueFromReview(win, 'beta.4')
  expect(gone.title === '这个话题的目录不在了' && gone.text.includes('deleted-project') && gone.buttons.some((label: string) => label.includes('选个目录')),
    'a folder gone should ask for another to go on from the records', gone)
  await run(win, `document.querySelector('#resume-root .btn-secondary').click()`)

  const lost = await continueFromReview(win, '把这周的进展')
  expect(lost.title === '原来的会话已经接不上了' && lost.text.includes('最近 20 轮'), 'a session gone should offer to go on from the records', lost)
  await wait(UI_WAIT_MS)
  await capture(win, outDir, 'resume-gone')
  await run(win, `document.querySelector('#resume-root .resume-main').click()`)
  const note = await until(win, `[...document.querySelectorAll('#earlier .topic-note')].map((el) => el.textContent).find((text) => text.includes('仅供助手参考'))`, 'the new conversation saying what it carries')
  const after = await run(win, AGENT)
  expect(note.includes('轮记录') && after.sessionId !== agent.sessionId, 'going on from the records should be a new conversation saying so', { note, agent, after })
  // The dialog gone and the page drawn again before the picture (else it may show the frame before).
  await until(win, `!document.querySelector('#resume-root .resume-sheet')`, 'the dialog closed')
  await wait(UI_WAIT_MS)
  await capture(win, outDir, 'resume-carried')
}

/** @returns failures */
export async function checkTimeline(win: BrowserWindow, outDir: string): Promise<string[]> {
  const failures: string[] = []
  const expect: Expect = (ok, message, seen) => { if (!ok) failures.push(`timeline: ${message}: ${JSON.stringify(seen)}`) }
  await checkFolded(win, outDir, expect)
  await checkReview(win, outDir, expect)
  await checkFarHit(win, outDir, expect)
  await checkResume(win, outDir, expect)
  report(`timeline: ${failures.length ? 'problems' : 'folded topics, the rail, stars and 回顾 as expected'}`)
  return failures
}

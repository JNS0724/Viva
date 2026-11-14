import { capture, run, submit, until, UI_WAIT_MS, wait, type Expect, type SmokeHooks, type SmokeWindow } from './smoke-kit.ts'
import { columnSteps } from './smoke-column.ts'
import { checkTaskCardRetention } from './smoke-task-card.ts'

/**
 * Background tasks on the real dsh: 后台做 starts a task of its own at any time, also while a turn waits on an
 * approval, the turn staying in front. Each task has one line in the conversation and a place on the 后台
 * page, where it is answered.
 */
/** Unlike configSteps's words, which stay earlier in the same session. */
const OTHER_ASK = '帮我订一张周五的机票'

/** Idle without approving anything (smoke-kit finishTurn would allow the task's card too). */
const mainIdle = `(() => {
  const send = document.getElementById('send-btn')
  return send.dataset.busy === 'false' && !send.disabled && !document.querySelector('.caret')
})()`
const userTexts = `[...document.querySelectorAll('#thread > .msg-user, #thread > .msg-user-row .msg-user')].map((el) => el.textContent)`

/** The card of the task named `title` in the conversation, as page code. */
const cardOf = (title: string) => `[...document.querySelectorAll('#thread .task-card')].find((el) => el.querySelector('.task-name')?.textContent === ${JSON.stringify(`#${title}`)})`
const cardState = (title: string) => `(() => {
  const card = ${cardOf(title)}
  return card ? { status: card.dataset.status, text: card.textContent, buttons: [...card.querySelectorAll('button')].map((el) => el.textContent) } : null
})()`
/** The card once its task has ended, else nothing yet. */
const doneCard = (title: string) => `(() => { const card = ${cardState(title)}; return card?.status === 'done' && card })()`
/** A button on the task's view of the 后台 page, by what it says (an approval's, a question's choice). */
const pageButton = (label: string) => `[...document.querySelectorAll('#tasks-page .tp-main button')].find((el) => el.textContent.trim().startsWith(${JSON.stringify(label)}))`
const pageState = `(() => {
  const page = document.getElementById('tasks-page')
  return {
    open: page.dataset.open === 'true',
    title: page.querySelector('.tp-title')?.textContent ?? '',
    rows: [...page.querySelectorAll('.tp-row .tp-name')].map((el) => el.textContent),
    said: [...page.querySelectorAll('.tp-thread .msg-text, .tp-thread .msg-user')].map((el) => el.textContent),
    act: page.querySelector('.tp-act')?.textContent ?? '',
  }
})()`
const escape = `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`

/** A task's line in the conversation has no buttons of its own: a click opens the task on the 后台 page. */
async function openFromLine(win: SmokeWindow, title: string) {
  await run(win, `(${cardOf(title)}).click()`)
  return until(win, `(() => { const seen = ${pageState}; return seen.open && seen.title === ${JSON.stringify(`#${title}`)} && seen })()`, `#${title} on the 后台 page`)
}

/** What a task waits on, answered where it is answered: its page, opened from its line. */
async function answerOnPage(win: SmokeWindow, title: string, label: string) {
  await openFromLine(win, title)
  await until(win, `Boolean(${pageButton(label)})`, `「${label}」 on #${title}'s page`)
  await run(win, `${pageButton(label)}.click()`)
  await run(win, escape)
}

/**
 * Said to the agent in the conversation, once it is free (a task that just ended may be reporting back: those words
 * would go into that turn); waits for its turn to end.
 */
async function tellAgent(win: SmokeWindow, words: string) {
  await until(win, mainIdle, 'the conversation free')
  await wait(UI_WAIT_MS)
  await until(win, mainIdle, 'the conversation still free')
  const before = await run(win, `${userTexts}.length`)
  await submit(win, words)
  await until(win, `${userTexts}.length > ${before} && ${mainIdle}`, `the agent done with 「${words}」`)
}

/** The agent routes `text` to a new background task (commit_route start, the fake model's 「后台做：」). */
const startInBackground = (win: SmokeWindow, text: string) => tellAgent(win, `后台做：${text}`)
/** The agent finds the task titled `title` and routes `words` to it (commit_route message). */
const tellTask = (win: SmokeWindow, title: string, words: string) => tellAgent(win, `告诉后台的「${title}」：${words}`)

/**
 * Asked to, the agent starts a task of its own from its brief: only its line joins the conversation, beside what
 * the agent said; the task answers on its card, the conversation on screen free.
 */
async function agentStartSteps(win: SmokeWindow, outDir: string, expect: Expect, hooks: SmokeHooks) {
  await startInBackground(win, OTHER_ASK)
  const done = await until(win, doneCard(OTHER_ASK), 'the task the agent started answering')
  expect(done.text.includes(`收到：「${OTHER_ASK}」`), 'the task should answer its brief', done)
  // Its result comes back to the conversation as a turn of the agent's own: no words of the user's for it.
  const asked = await run(win, `${userTexts}.length`)
  const back = await until(win, `[...document.querySelectorAll('#thread > .msg-agent .msg-text')].map((el) => el.textContent).find((text) => text.includes(${JSON.stringify(`已看过后台结果：${OTHER_ASK}`)})) ?? null`, 'the result back in the conversation')
  await until(win, mainIdle, 'the report turn over')
  expect(Boolean(back) && (await run(win, `${userTexts}.length`)) === asked, 'the result should come back as the agent\'s turn, with no user words', { back, asked })
  const front = await run(win, `({
    answers: [...document.querySelectorAll('#thread > .msg-agent .msg-text')].map((el) => el.textContent),
    busy: document.getElementById('send-btn').dataset.busy,
  })`)
  // A handover ends the turn with its notice as the answer; the task answers on its own card.
  expect(front.answers.some((text: string) => text.includes('已经交给后台')) && !front.answers.some((text: string) => text.includes(`收到：「${OTHER_ASK}」`))
    && !front.answers.some((text: string) => /请求 ID|commit_route/.test(text)),
    'the agent should say it handed the work over, the task answering on its own card, no routing step showing', front)
  // The task's own session begins with its brief: nothing of the conversation comes before it.
  const firstWords = (request: { messages?: Array<{ content?: unknown }> }) => {
    const content = request.messages?.[0]?.content
    return typeof content === 'string' ? content : Array.isArray(content) ? (content[0] as { text?: string })?.text ?? '' : ''
  }
  const fresh = (hooks.model?.()?.requests ?? []).some((request: unknown) => firstWords(request as { messages?: Array<{ content?: unknown }> }) === OTHER_ASK)
  expect(fresh, 'the task should start afresh from its brief, not from the conversation')
  await run(win, `(${cardOf(OTHER_ASK)}).scrollIntoView({ block: 'center' })`)
  await wait(UI_WAIT_MS)
  await capture(win, outDir, 'tasks-agent-start')
  await pageSteps(win, outDir, expect)
}

/**
 * An ended task's line in the conversation opens the 后台 page (the island counts only tasks going on): the task's
 * whole conversation and what to do with it; ← 返回 / Esc closes it. The drawer has no tabs of tasks any more.
 */
async function pageSteps(win: SmokeWindow, outDir: string, expect: Expect) {
  expect(await run(win, `document.querySelector('#island .isl-bg') === null`), 'with none going on, the island should count no task')
  await run(win, `(${cardOf(OTHER_ASK)}).click()`)
  const page = await until(win, `(() => { const seen = ${pageState}; return seen.open && seen.title && seen })()`, 'the 后台 page')
  expect(page.title === `#${OTHER_ASK}` && page.rows.includes(OTHER_ASK) && page.act === '关掉这件' && page.said.some((text: string) => text.includes(`收到：「${OTHER_ASK}」`)),
    'its line should open the 后台 page, the task shown whole', page)
  await capture(win, outDir, 'tasks-page')
  // Its list folds to a narrow strip (« at its head) and unfolds from there (»); the task shown stays.
  await run(win, `document.querySelector('#tasks-page .tp-side .tp-fold').click()`)
  const folded = await until(win, `(() => {
    const side = document.querySelector('#tasks-page .tp-side')
    return side?.classList.contains('tp-side-folded') && { width: Math.round(side.getBoundingClientRect().width), rows: side.querySelectorAll('.tp-row').length, title: ${pageState}.title }
  })()`, 'the list folded to its strip')
  expect(folded.width <= 40 && folded.rows === 0 && folded.title === `#${OTHER_ASK}`, 'folded, the list should be a narrow strip and the task stay shown', folded)
  await capture(win, outDir, 'tasks-list-folded')
  await run(win, `document.querySelector('#tasks-page .tp-side .tp-fold').click()`)
  await until(win, `(${pageState}).rows.length > 0`, 'the list unfolded again')
  // One of the hub's pages: its sidebar stays, so 关于你 is a click away and 后台 a click back.
  await run(win, `document.querySelector('.hub-nav[data-page="profile"]').click()`)
  const profile = await until(win, `(() => {
    const hub = document.getElementById('hub')
    const shown = document.querySelector('.hub-page[data-page="profile"]')
    return hub.dataset.open === 'true' && shown && !shown.hidden && document.getElementById('tasks-page').hidden && { hub: hub.dataset.open }
  })()`, '关于你 from the 后台 page, within the hub')
  expect(profile, 'from the 后台 page, 关于你 should open in the same place')
  await run(win, `document.querySelector('.hub-nav[data-page="tasks"]').click()`)
  await until(win, `(() => { const seen = ${pageState}; return seen.open && !document.getElementById('tasks-page').hidden && seen })()`, 'back on the 后台 page')
  await run(win, escape)
  await wait(UI_WAIT_MS)
  const closed = await run(win, `({ open: document.getElementById('tasks-page').dataset.open, tabs: document.querySelectorAll('#drawer .tab-task').length })`)
  expect(closed.open === 'false' && closed.tabs === 0, 'Esc should close the page; the drawer has no task tabs', closed)
}

const BIG_ASK = '把全部文档整理好，顺手接入演示服务'

/**
 * A longer job given to 后台做 while the conversation is idle: it waits on its approval in the background, the
 * conversation staying free; declined on its page (opened from its line), the task ends and reports back.
 */
async function longJobSteps(win: SmokeWindow, outDir: string, expect: Expect) {
  await startInBackground(win, BIG_ASK)
  await until(win, `(${cardOf(BIG_ASK)})?.dataset.status === 'waiting'`, 'the task waiting on its approval')
  const after = await run(win, `({
    busy: document.getElementById('send-btn').dataset.busy,
    asked: ${userTexts},
    count: document.querySelector('#island .isl-bg b')?.textContent ?? null,
    card: ${cardState(BIG_ASK)},
  })`)
  expect(after.busy === 'false' && !after.asked.includes(BIG_ASK) && after.count === '1' && after.card?.status === 'waiting',
    'the task should wait in the background, its card asking, and the conversation be free', after)
  await answerOnPage(win, BIG_ASK, '拒绝')
  await until(win, `(${cardOf(BIG_ASK)})?.dataset.status === 'done'`, 'the task ending')
  await reportSteps(win, outDir, expect)
}

const FOLLOW_UP = '刚才那件做得怎么样了'

/**
 * An ended task asked again from its page (opened from its line): sent, the task works again in its own session
 * and reports back once more, the conversation on screen left alone.
 */
async function followUpSteps(win: SmokeWindow, outDir: string, expect: Expect) {
  const opened = await openFromLine(win, BIG_ASK)
  expect(opened.act === '关掉这件', 'an ended task\'s page should offer to close it', opened)
  await run(win, escape)
  await tellTask(win, BIG_ASK, FOLLOW_UP)
  await openFromLine(win, BIG_ASK)
  const answered = await until(win, `(() => {
    const seen = ${pageState}
    return seen.said.some((text) => text.includes('收到：「${FOLLOW_UP}」')) && seen
  })()`, 'the task answering the follow-up on its page')
  expect(answered.said.includes(FOLLOW_UP), 'the follow-up should be in the task\'s conversation', answered.said)
  await wait(UI_WAIT_MS)
  await capture(win, outDir, 'tasks-follow-up')
  await run(win, escape)
  const card = await until(win, `(() => { const card = ${cardState(BIG_ASK)}; return card?.status === 'done' && card.text.includes(${JSON.stringify(FOLLOW_UP)}) && card })()`, 'the line after the follow-up')
  expect(card.text.includes('看结果'), 'asked again, the task should report back once more on its line', card)
  const answers = await run(win, `[...document.querySelectorAll('#thread > .msg-agent .msg-text')].map((el) => el.textContent)`)
  expect(!answers.some((text: string) => text.includes(`收到：「${FOLLOW_UP}」`)), 'the task\'s answer should not land in the conversation on screen', answers)
}

/**
 * An ended task reports back on its line, one quiet row with no buttons of its own; asked again from its page;
 * opened from its line once more, 关掉这件 puts it away.
 */
async function reportSteps(win: SmokeWindow, outDir: string, expect: Expect) {
  const report = await until(win, doneCard(BIG_ASK), 'the task\'s report')
  expect(report.text.includes('做完了') && report.text.includes('看结果') && report.buttons.length === 0,
    'the ended task\'s line should say so and lead to its result, with no buttons of its own', report)
  await run(win, `(${cardOf(BIG_ASK)}).scrollIntoView({ block: 'center' })`)
  await wait(UI_WAIT_MS)
  await capture(win, outDir, 'tasks-report')
  // The island's tail, if any (it counts tasks going on), stays inside it, a long task name giving way (…) instead.
  const tail = await run(win, `(() => {
    const island = document.querySelector('#island .isl')?.getBoundingClientRect()
    const cell = document.querySelector('#island .isl-bg')?.getBoundingClientRect()
    return island && cell ? { islandRight: Math.round(island.right), tailRight: Math.round(cell.right), text: document.querySelector('#island .isl-bg').textContent } : null
  })()`)
  expect(!tail || tail.tailRight <= tail.islandRight, 'the island\'s tail should stay inside the island', tail)
  await followUpSteps(win, outDir, expect)
  const page = await openFromLine(win, BIG_ASK)
  expect(page.act === '关掉这件', 'its line should open the task\'s page', page)
  expect(await run(win, `document.getElementById('hub').dataset.open === 'true' && document.querySelector('.hub-nav[data-page="tasks"]')?.getAttribute('aria-current') === 'page'`),
    'the 后台 page should be one of the hub\'s, its sidebar there with 后台 marked')
  await capture(win, outDir, 'tasks-closing')
  await run(win, `document.querySelector('#tasks-page .tp-act').click()`)
  const after = await until(win, `(() => {
    const seen = ${pageState}
    return !seen.rows.includes(${JSON.stringify(BIG_ASK)}) && { ...seen, card: Boolean(${cardOf(BIG_ASK)}) }
  })()`, 'the task put away')
  expect(!after.card, 'closed, the task\'s card should go too', after)
  await run(win, escape)
}

const ASKS_LATER = '接入演示服务，再问我城市'

/**
 * A task asks something after it went to the background: its line says it waits and leads to its page, where
 * it is answered; the task carries on to its end and reports back.
 */
async function laterQuestionSteps(win: SmokeWindow, outDir: string, expect: Expect) {
  await startInBackground(win, ASKS_LATER)
  const asking = await until(win, `(() => { const card = ${cardState(ASKS_LATER)}; return card?.status === 'waiting' && card })()`, 'the task waiting on its approval')
  expect(asking.text.includes('等你处理') && asking.text.includes('去处理') && asking.buttons.length === 0,
    'the task\'s line should say it waits and lead to where it is answered, with no buttons of its own', asking)
  await run(win, `(${cardOf(ASKS_LATER)}).scrollIntoView({ block: 'center' })`)
  await wait(UI_WAIT_MS)
  await capture(win, outDir, 'tasks-line-waiting')
  // Its page has the approval, and its steps unfold there.
  await openFromLine(win, ASKS_LATER)
  await run(win, `document.querySelector('#tasks-page .tp-toggle')?.click()`)
  await wait(UI_WAIT_MS)
  const onPage = await run(win, `({
    asks: Boolean(document.querySelector('#tasks-page .confirm:not(.ask)')),
    steps: [...document.querySelectorAll('#tasks-page .trace-title')].map((el) => el.textContent),
    act: document.querySelector('#tasks-page .tp-act')?.textContent ?? '',
  })`)
  expect(onPage.asks && onPage.act === '停下' && onPage.steps.some((title: string) => title.includes('viva_mcp_add') || title.includes('请求你确认')),
    'a waiting task\'s page should show its approval and unfold its steps', onPage)
  await capture(win, outDir, 'tasks-page-waiting')
  // Declined there, the task goes on to ask which city.
  await run(win, `${pageButton('拒绝')}.click()`)
  await run(win, escape)
  // Its name says 城市 too: wait for the question itself on its line, its choices on its page.
  const card = await until(win, `(() => { const card = ${cardState(ASKS_LATER)}; return card?.status === 'waiting' && card.text.includes('哪个城市') && card })()`, "the task's question")
  expect(card.text.includes('去处理'), "the task's question should be said on its line", card)
  await openFromLine(win, ASKS_LATER)
  const choices = await until(win, `Boolean(${pageButton('上海')}) && Boolean(${pageButton('北京')})`, "the question's choices on its page")
  expect(choices, "the task's question should be answered on its page")
  await wait(UI_WAIT_MS)
  await capture(win, outDir, 'tasks-question')
  await run(win, `${pageButton('上海')}.click()`)
  await run(win, escape)
  const report = await until(win, `(() => { const card = ${cardState(ASKS_LATER)}; return card?.status === 'done' && card.text })()`, "the task's report after the answer")
  expect(report.includes('按上海来看'), 'answered, the task should carry on and report what it said', report)
  const asked = await run(win, userTexts)
  expect(!asked.includes('上海'), 'the answer should go to the task, not the conversation on screen', asked)
}

const ON_ITS_OWN = '帮我列一下这周要交的东西'

/**
 * 后台做: only the task card joins the main conversation; its original request remains in the details.
 */
async function startSteps(win: SmokeWindow, outDir: string, expect: Expect) {
  await startInBackground(win, ON_ITS_OWN)
  const started = await until(win, `(() => {
    const card = ${cardState(ON_ITS_OWN)}
    const rows = [...document.querySelectorAll('#thread > *')]
    const words = rows.findIndex((el) => [...el.querySelectorAll('.msg-user'), el].some((bubble) => bubble.classList.contains('msg-user') && bubble.textContent === ${JSON.stringify(ON_ITS_OWN)}))
    const at = rows.findIndex((el) => el === ${cardOf(ON_ITS_OWN)})
    return card && { card, onlyCard: words === -1 && at >= 0, busy: document.getElementById('send-btn').dataset.busy, input: document.getElementById('composer-input').value }
  })()`, 'the task started on its own')
  expect(started.onlyCard && started.input === '' && started.busy === 'false', '后台做 should show only its task card and leave the conversation free', started)
  const done = await until(win, doneCard(ON_ITS_OWN), 'the task started on its own reporting back')
  expect(done.text.includes(`收到：「${ON_ITS_OWN}」`), 'the task should answer the words it was given', done)
  const answers = await run(win, `[...document.querySelectorAll('#thread > .msg-agent .msg-text')].map((el) => el.textContent)`)
  expect(!answers.some((text: string) => text.includes(`收到：「${ON_ITS_OWN}」`)), 'its answer should not be in the conversation on screen', answers)
  await run(win, `(${cardOf(ON_ITS_OWN)}).scrollIntoView({ block: 'center' })`)
  await wait(UI_WAIT_MS)
  await capture(win, outDir, 'tasks-started')
  const details = await openFromLine(win, ON_ITS_OWN)
  expect(details.said.includes(ON_ITS_OWN), 'task details should retain the original request', details)
  await run(win, escape)
}

const LEFT_ASK = '帮我接入演示服务，留到下次'

/** Last in the memory phase: a task left going in the background, waiting on its approval, as Viva quits. */
async function leaveRunning(win: SmokeWindow) {
  await startInBackground(win, LEFT_ASK)
  await until(win, `(${cardOf(LEFT_ASK)})?.dataset.status === 'waiting'`, 'the task left going')
}

/**
 * Build only the three real task sessions that the restart acceptance reads, started as the user starts them: the
 * agent asked to (start_background_task), each once the conversation is free.
 */
export async function prepareResume(win: SmokeWindow, outDir: string): Promise<string[]> {
  const start = (text: string) => startInBackground(win, text)
  await start(ASKS_LATER)
  await until(win, `(${cardOf(ASKS_LATER)})?.dataset.status === 'waiting'`, 'the question task approval before restart')
  await answerOnPage(win, ASKS_LATER, '拒绝')
  await answerOnPage(win, ASKS_LATER, '上海')
  await until(win, doneCard(ASKS_LATER), 'the completed question task for restart')
  await openFromLine(win, ASKS_LATER)
  await run(win, escape)
  await start(ON_ITS_OWN)
  await until(win, doneCard(ON_ITS_OWN), 'the completed ordinary task for restart')
  await openFromLine(win, ON_ITS_OWN)
  await run(win, escape)
  await start(LEFT_ASK)
  await until(win, `(${cardOf(LEFT_ASK)})?.dataset.status === 'waiting'`, 'the approval task prepared for restart')
  await capture(win, outDir, 'resume-prepared')
  return []
}

/** @param {(ok: boolean, message: string, seen?: unknown) => void} expect */
export async function taskSteps(win: SmokeWindow, outDir: string, expect: Expect, hooks: SmokeHooks) {
  await checkTaskCardRetention(win, expect)
  await agentStartSteps(win, outDir, expect, hooks)
  await longJobSteps(win, outDir, expect)
  await laterQuestionSteps(win, outDir, expect)
  await startSteps(win, outDir, expect)
  await columnSteps(win, outDir, expect)
  await leaveRunning(win)
}

/**
 * The `resume` phase, on its real prepared profile (or package memory profile): the task Viva quit on is back, interrupted, its line in the
 * conversation; told to go on, the agent takes it up again and it reports back once done.
 * @returns {Promise<string[]>} failed expectations
 */
export async function checkResume(win: SmokeWindow, outDir: string): Promise<string[]> {
  const failures: string[] = []
  const expect: Expect = (ok, message, seen) => { if (!ok) failures.push(`${message}${seen === undefined ? '' : `: ${JSON.stringify(seen)}`}`) }
  const card = await until(win, `(() => { const card = ${cardState(LEFT_ASK)}; return card?.status === 'interrupted' && card })()`, 'the task Viva quit on')
  expect(card.text.includes('已中断') && card.buttons.length === 0, 'the task Viva quit on should be back, interrupted, with no buttons of its own', card)
  expect(!(await run(win, `Boolean(document.querySelector('#thread .task-unfinished'))`)), 'there is no card offering to take it up any more')
  await run(win, `(${cardOf(LEFT_ASK)}).scrollIntoView({ block: 'center' })`)
  await wait(UI_WAIT_MS)
  await capture(win, outDir, 'tasks-unfinished')
  await tellTask(win, LEFT_ASK, '接着做')
  const report = await until(win, `(() => { const card = ${cardState(LEFT_ASK)}; return card?.status === 'done' && card.text })()`, 'the task taken up reporting back')
    .catch(async (err) => {
      // What the card shows instead, and a picture of it, so a run that times out says where the task stood.
      await capture(win, outDir, 'tasks-resume-stuck')
      throw new Error(`${err.message}: ${JSON.stringify(await run(win, cardState(LEFT_ASK)))}`)
    })
  expect(report.includes('做完了'), 'taken up, the task should carry on to its end', report)
  await wait(UI_WAIT_MS)
  await capture(win, outDir, 'tasks-resumed')
  await restoredSteps(win, outDir, expect)
  return failures
}

const RESTORED_ASK = '后来呢'

/**
 * Tasks that had ended by the last launch (laterQuestionSteps's, startSteps's) are back on the 后台 page; asked
 * again through the agent, a task's session is taken up first, and it answers on its page.
 */
async function restoredSteps(win: SmokeWindow, outDir: string, expect: Expect) {
  // Seen last time, they are not reminded of at the island's tail any more: the 后台 page from the hub's sidebar.
  await run(win, `document.getElementById('open-profile').click()`)
  await until(win, `document.getElementById('hub').dataset.open === 'true'`, 'the hub')
  await run(win, `document.querySelector('.hub-nav[data-page="tasks"]').click()`)
  const page = await until(win, `(() => { const seen = ${pageState}; return seen.open && seen.rows.length && seen })()`, 'the 后台 page after the relaunch')
  expect(page.rows.includes(ASKS_LATER) && page.rows.includes(ON_ITS_OWN), 'tasks that ended last time should be back on the 后台 page', page.rows)
  await run(win, `[...document.querySelectorAll('#tasks-page .tp-row')].find((el) => el.querySelector('.tp-name').textContent === ${JSON.stringify(ASKS_LATER)}).click()`)
  await until(win, `(${pageState}).title === ${JSON.stringify(`#${ASKS_LATER}`)}`, 'the task from last time on show')
  await run(win, escape)
  await tellTask(win, ASKS_LATER, RESTORED_ASK)
  await openFromLine(win, ASKS_LATER)
  await until(win, `(${pageState}).said.some((text) => text.includes('收到：「${RESTORED_ASK}」'))`, 'the task from last time answering')
    .catch(async (err) => {
      // Where the page stood instead, and a picture of it.
      await capture(win, outDir, 'tasks-restored-stuck')
      const toast = await run(win, `document.getElementById('toast')?.textContent ?? ''`)
      throw new Error(`${err.message}: ${JSON.stringify({ page: await run(win, pageState), toast })}`)
    })
  await wait(UI_WAIT_MS)
  await capture(win, outDir, 'tasks-restored')
  await run(win, escape)
  const answers = await run(win, `[...document.querySelectorAll('#thread > .msg-agent .msg-text')].map((el) => el.textContent)`)
  expect(!answers.some((text: string) => text.includes(`收到：「${RESTORED_ASK}」`)), 'the task\'s answer should not land in the conversation on screen', answers)
}

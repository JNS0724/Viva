import { capture, run, submit, until, UI_WAIT_MS, wait, type Expect, type SmokeHooks, type SmokeWindow } from './smoke-kit.ts'
import { dockSteps } from './smoke-dock.ts'

/**
 * Background tasks on the real dsh (phase 3): while a turn waits on an approval, words about something else
 * say over the input that they go to the background; sent, they start a task of their own and the turn stays
 * in front. 后台做 does the same at any time; 放到后台 moves a long turn there. Each task has one card in the
 * conversation, answered in place, and a place on the 后台 page.
 */
/** Unlike configSteps's words, which stay earlier in the same session. */
const BUSY_ASK = '再帮我接入演示服务一次'
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
const clickOnCard = (title: string, label: string) => `[...(${cardOf(title)}).querySelectorAll('button')].find((el) => el.textContent === ${JSON.stringify(label)}).click()`
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

/** 后台做: the words typed go to a task of their own (the button beside 发送). */
const startInBackground = (win: SmokeWindow, text: string) => run(win, `(() => {
  const input = document.getElementById('composer-input')
  input.value = ${JSON.stringify(text)}
  input.dispatchEvent(new Event('input', { bubbles: true }))
  document.getElementById('bg-send').click()
})()`)

/**
 * While a turn waits on an approval, words about something else go to a task of their own: the turn and its
 * approval stay in front, the task starts from before that turn and answers on its card.
 */
async function routeSteps(win: SmokeWindow, outDir: string, expect: Expect, hooks: SmokeHooks) {
  await submit(win, BUSY_ASK)
  await until(win, `document.querySelector('.confirm:not(.ask)')`, 'the approval card')
  const hint = await run(win, `(() => {
    const input = document.getElementById('composer-input')
    input.value = ${JSON.stringify(OTHER_ASK)}
    input.dispatchEvent(new Event('input', { bubbles: true }))
    const route = document.getElementById('route-hint')
    return { hidden: route.hidden, route: route.dataset.route, text: route.textContent }
  })()`)
  expect(!hint.hidden && hint.route === 'other' && hint.text.includes('交给后台做'), 'words about something else should say they go to the background', hint)
  await wait(UI_WAIT_MS)
  await capture(win, outDir, 'tasks-route')

  await run(win, `document.getElementById('composer').requestSubmit()`)
  const done = await until(win, doneCard(OTHER_ASK), 'the task the words started answering')
  expect(done.text.includes(`收到：「${OTHER_ASK}」`), 'the task should answer the words', done)
  const front = await run(win, `({
    asked: ${userTexts},
    confirms: [...document.querySelectorAll('.confirm:not(.ask) .confirm-head')].map((el) => el.textContent),
    folds: document.querySelectorAll('#thread .fold-task').length,
    busy: document.getElementById('send-btn').dataset.busy,
  })`)
  expect(front.asked.includes(BUSY_ASK) && !front.asked.includes(OTHER_ASK) && front.folds === 0,
    'the turn should stay in front, the words not landing in it', front)
  expect(front.confirms.length === 1 && !front.confirms[0].startsWith('#'), 'the turn\'s approval should still be the conversation\'s', front)
  const answering = (hooks.model?.()?.requests ?? []).map((request: unknown) => JSON.stringify(request)).find((json: string) => json.includes(OTHER_ASK)) ?? ''
  const at = answering.indexOf(BUSY_ASK)
  expect(answering && at < 0, 'the task answering the new words should start from before the turn running', { found: Boolean(answering), around: answering.slice(Math.max(0, at - 300), at + 60) })
  await run(win, `(${cardOf(OTHER_ASK)}).scrollIntoView({ block: 'center' })`)
  await wait(UI_WAIT_MS)
  await capture(win, outDir, 'tasks-moved')
  await pageSteps(win, outDir, expect)
  await mentionSteps(win, outDir, expect)
  // Declined, the turn in front ends without setting the server up again.
  await run(win, `document.querySelector('.confirm:not(.ask) .btn-secondary').click()`)
  await until(win, mainIdle, 'the turn ending')
}

const MENTION_WORDS = '顺便说一声'

/** 「#name words」 go to the background task named, here one that ended: asked again, it answers on its card. */
async function mentionSteps(win: SmokeWindow, outDir: string, expect: Expect) {
  const hint = await run(win, `(() => {
    const input = document.getElementById('composer-input')
    input.value = '#帮我订一张周五 ${MENTION_WORDS}'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return document.getElementById('route-hint').textContent
  })()`)
  expect(hint.includes(`交给 #${OTHER_ASK}`) && hint.includes('接着做'), '「#name」 should say the words go to that task', hint)
  await wait(UI_WAIT_MS)
  await capture(win, outDir, 'tasks-mention')
  await run(win, `document.getElementById('composer').requestSubmit()`)
  await until(win, `(() => { const card = ${cardState(OTHER_ASK)}; return card?.status === 'done' && card.text.includes('收到：「${MENTION_WORDS}」') })()`, 'the task answering 「#name」')
  const asked = await run(win, userTexts)
  expect(!asked.some((text: string) => text.includes(MENTION_WORDS)), 'the words should not land in the conversation on screen', asked)
}

/**
 * The count at the island's tail opens the 后台 page: the task's whole conversation and what to do with it;
 * ← 返回 / Esc closes it. The drawer has no tabs of tasks any more.
 */
async function pageSteps(win: SmokeWindow, outDir: string, expect: Expect) {
  await run(win, `document.querySelector('#island .isl-bg').click()`)
  const page = await until(win, `(() => { const seen = ${pageState}; return seen.open && seen.title && seen })()`, 'the 后台 page')
  expect(page.title === `#${OTHER_ASK}` && page.rows.includes(OTHER_ASK) && page.act === '关掉这件' && page.said.some((text: string) => text.includes(`收到：「${OTHER_ASK}」`)),
    'the tail should open the 后台 page, the task shown whole', page)
  await capture(win, outDir, 'tasks-page')
  await run(win, escape)
  await wait(UI_WAIT_MS)
  const closed = await run(win, `({ open: document.getElementById('tasks-page').dataset.open, tabs: document.querySelectorAll('#drawer .tab-task').length })`)
  expect(closed.open === 'false' && closed.tabs === 0, 'Esc should close the page; the drawer has no task tabs', closed)
}

const BIG_ASK = '把全部文档整理好，顺手接入演示服务'

/**
 * The agent says first that the job will take long: 放到后台 shows beside the turn; taken, the turn goes on in
 * the background with no new words, and the conversation is free.
 */
async function offerSteps(win: SmokeWindow, outDir: string, expect: Expect) {
  await submit(win, BIG_ASK)
  const offer = await until(win, `document.querySelector('#thread .offer')?.textContent ?? null`, 'the offer beside the turn', UI_WAIT_MS * 20)
    .catch(async (err) => {
      await capture(win, outDir, 'tasks-offer-failed')
      const seen = await run(win, `JSON.stringify({
        users: [...document.querySelectorAll('#thread .msg-user')].map((el) => el.textContent).slice(-3),
        trace: [...document.querySelectorAll('#drawer .trace-title')].map((el) => el.textContent).slice(-4),
        busy: document.getElementById('send-btn').dataset.busy,
      })`)
      throw new Error(`${err.message}: ${seen}`)
    })
  expect(offer.includes('要逐个读完所有文档') && offer.includes('放到后台'), 'the offer should say why, with 放到后台', offer)
  await until(win, `document.querySelector('.confirm:not(.ask)')`, 'the turn holding on its approval')
  await wait(UI_WAIT_MS)
  await capture(win, outDir, 'tasks-offer')
  await run(win, `document.querySelector('#thread .offer .offer-act').click()`)
  await until(win, `document.querySelector('#thread .fold-task') && !document.querySelector('#thread .offer')`, 'the turn in the background')
  const after = await run(win, `({
    busy: document.getElementById('send-btn').dataset.busy,
    asked: ${userTexts},
    count: document.querySelector('#island .isl-bg b')?.textContent ?? null,
    card: ${cardState(BIG_ASK)},
  })`)
  expect(after.busy === 'false' && !after.asked.includes(BIG_ASK) && after.count === '1' && after.card?.status === 'waiting',
    'taken, the turn should go on in the background, its card asking, and the conversation be free', after)
  // Done with: its approval declined on its card, the task ends.
  await run(win, clickOnCard(BIG_ASK, '拒绝'))
  await until(win, `(${cardOf(BIG_ASK)})?.dataset.status === 'done'`, 'the task ending')
  await reportSteps(win, outDir, expect)
}

const FOLLOW_UP = '刚才那件做得怎么样了'

/**
 * 接着问 on an ended task's card: its page, the cursor in its input; sent, the task works again in its own
 * session and reports back once more, the conversation on screen left alone.
 */
async function followUpSteps(win: SmokeWindow, outDir: string, expect: Expect) {
  await run(win, clickOnCard(BIG_ASK, '接着问'))
  const opened = await until(win, `(() => {
    const seen = ${pageState}
    return seen.open && seen.title && { ...seen, focused: document.activeElement?.classList.contains('tp-input') ?? false }
  })()`, 'the task\'s page')
  expect(opened.title === `#${BIG_ASK}` && opened.focused && opened.act === '关掉这件', '接着问 should open the task\'s page with the cursor in its input', opened)
  await run(win, `(() => {
    const field = document.querySelector('#tasks-page .tp-input')
    field.value = ${JSON.stringify(FOLLOW_UP)}
    field.closest('form').requestSubmit()
  })()`)
  const answered = await until(win, `(() => {
    const seen = ${pageState}
    return seen.said.some((text) => text.includes('收到：「${FOLLOW_UP}」')) && seen
  })()`, 'the task answering the follow-up on its page')
  expect(answered.said.includes(FOLLOW_UP), 'the follow-up should be in the task\'s conversation', answered.said)
  await wait(UI_WAIT_MS)
  await capture(win, outDir, 'tasks-follow-up')
  await run(win, escape)
  const card = await until(win, `(() => { const card = ${cardState(BIG_ASK)}; return card?.status === 'done' && card.text.includes(${JSON.stringify(FOLLOW_UP)}) && card })()`, 'the card after the follow-up')
  expect(card.buttons.includes('接着问'), 'asked again, the task should report back once more on its card', card)
  const asked = await run(win, userTexts)
  expect(!asked.some((text: string) => text.includes(FOLLOW_UP)), 'the follow-up should not land in the conversation on screen', asked)
}

/** An ended task reports back on its card; 接着问 asks it again; 详情 → opens its page, and 关掉这件 puts it away. */
async function reportSteps(win: SmokeWindow, outDir: string, expect: Expect) {
  const report = await until(win, doneCard(BIG_ASK), 'the task\'s report')
  expect(report.text.includes('做完了') && report.buttons.join() === '详情 →,接着问,×', 'the ended task\'s card should say so, with what to do next', report)
  await run(win, `(${cardOf(BIG_ASK)}).scrollIntoView({ block: 'center' })`)
  await wait(UI_WAIT_MS)
  await capture(win, outDir, 'tasks-report')
  await followUpSteps(win, outDir, expect)
  await run(win, clickOnCard(BIG_ASK, '详情 →'))
  const page = await until(win, `(() => { const seen = ${pageState}; return seen.open && seen.title && seen })()`, 'the task\'s page')
  expect(page.title === `#${BIG_ASK}` && page.act === '关掉这件', '详情 → should open the task\'s page', page)
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
 * A task asks something after it went to the background: its card asks it, named, and is answered there;
 * the task carries on to its end and reports back.
 */
async function laterQuestionSteps(win: SmokeWindow, outDir: string, expect: Expect) {
  await startInBackground(win, ASKS_LATER)
  const asking = await until(win, `(() => { const card = ${cardState(ASKS_LATER)}; return card?.status === 'waiting' && card })()`, 'the task\'s approval on its card')
  expect(asking.buttons.includes('允许') && asking.buttons.includes('拒绝') && asking.text.includes('等你确认'), 'the task\'s approval should be asked on its card', asking)
  // Its page has the approval too, and its steps unfold there.
  await run(win, clickOnCard(ASKS_LATER, '详情 →'))
  await until(win, `(${pageState}).title === ${JSON.stringify(`#${ASKS_LATER}`)}`, 'the waiting task\'s page')
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
  await run(win, escape)
  // Declined on its card, the task goes on to ask which city.
  await run(win, clickOnCard(ASKS_LATER, '拒绝'))
  // Its name says 城市 too: wait for the question itself, with its choices on the card.
  const card = await until(win, `(() => { const card = ${cardState(ASKS_LATER)}; return card?.status === 'waiting' && card.text.includes('哪个城市') && card })()`, "the task's question")
  expect(card.status === 'waiting' && card.buttons.includes('上海') && card.buttons.includes('北京'), "the task's question should be asked on its card, named", card)
  await run(win, `(${cardOf(ASKS_LATER)}).scrollIntoView({ block: 'center' })`)
  await wait(UI_WAIT_MS)
  await capture(win, outDir, 'tasks-question')
  await run(win, clickOnCard(ASKS_LATER, '上海'))
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
  await run(win, clickOnCard(ON_ITS_OWN, '详情 →'))
  const details = await until(win, `(() => { const seen = ${pageState}; return seen.open && seen.title === ${JSON.stringify(`#${ON_ITS_OWN}`)} && seen })()`, 'the original request in task details')
  expect(details.said.includes(ON_ITS_OWN), 'task details should retain the original request', details)
  await run(win, escape)
}

const LEFT_ASK = '帮我接入演示服务，留到下次'

/** Last in the memory phase: a task left going in the background, waiting on its approval, as Viva quits. */
async function leaveRunning(win: SmokeWindow) {
  await startInBackground(win, LEFT_ASK)
  await until(win, `(${cardOf(LEFT_ASK)})?.dataset.status === 'waiting'`, 'the task left going')
}

/** @param {(ok: boolean, message: string, seen?: unknown) => void} expect */
export async function taskSteps(win: SmokeWindow, outDir: string, expect: Expect, hooks: SmokeHooks) {
  await routeSteps(win, outDir, expect, hooks)
  await offerSteps(win, outDir, expect)
  await laterQuestionSteps(win, outDir, expect)
  await startSteps(win, outDir, expect)
  await dockSteps(win, outDir, expect)
  await leaveRunning(win)
}

/**
 * The `resume` phase, on the profile `memory` left: the task Viva quit on is offered; taken up, it goes on
 * in the background and reports back once done. @returns {Promise<string[]>} failed expectations
 */
export async function checkResume(win: SmokeWindow, outDir: string): Promise<string[]> {
  const failures: string[] = []
  const expect: Expect = (ok, message, seen) => { if (!ok) failures.push(`${message}${seen === undefined ? '' : `: ${JSON.stringify(seen)}`}`) }
  const card = await until(win, `document.querySelector('#thread .task-unfinished')?.textContent ?? null`, 'the task Viva quit on')
  expect(card.includes(`#${LEFT_ASK}`) && card.includes('接着做') && card.includes('不做了'), 'the task Viva quit on should be offered', card)
  await run(win, `document.querySelector('#thread .task-unfinished').scrollIntoView({ block: 'center' })`)
  await wait(UI_WAIT_MS)
  await capture(win, outDir, 'tasks-unfinished')
  // 接着做 waits for the agent to be connected, as a user would find it.
  const goOn = `[...document.querySelectorAll('#thread .task-unfinished button')].find((el) => el.textContent === '接着做')`
  await until(win, `!(${goOn}).disabled`, '接着做 once the agent is connected')
  await run(win, `(${goOn}).click()`)
  const report = await until(win, `(() => { const card = ${cardState(LEFT_ASK)}; return card?.status === 'done' && card.text })()`, 'the task taken up reporting back')
    .catch(async (err) => {
      // What the card shows instead, and a picture of it, so a run that times out says where the task stood.
      await capture(win, outDir, 'tasks-resume-stuck')
      throw new Error(`${err.message}: ${JSON.stringify(await run(win, cardState(LEFT_ASK)))}`)
    })
  expect(report.includes('做完了'), 'taken up, the task should carry on to its end', report)
  expect(!(await run(win, `Boolean(document.querySelector('#thread .task-unfinished'))`)), 'taken up, it is no longer offered')
  await wait(UI_WAIT_MS)
  await capture(win, outDir, 'tasks-resumed')
  const left = await run(win, `window.agent.unfinishedTasks()`)
  expect(left.length === 0, 'done with, nothing is left to offer at the next launch', left)
  await restoredSteps(win, outDir, expect)
  return failures
}

const RESTORED_ASK = '后来呢'

/**
 * Tasks that had ended by the last launch (laterQuestionSteps's, startSteps's) are back on the 后台 page;
 * asked again there, a task's session is taken up first, and it answers on its page.
 */
async function restoredSteps(win: SmokeWindow, outDir: string, expect: Expect) {
  await run(win, `document.querySelector('#island .isl-bg').click()`)
  const page = await until(win, `(() => { const seen = ${pageState}; return seen.open && seen.rows.length && seen })()`, 'the 后台 page after the relaunch')
  expect(page.rows.includes(ASKS_LATER) && page.rows.includes(ON_ITS_OWN), 'tasks that ended last time should be back on the 后台 page', page.rows)
  await run(win, `[...document.querySelectorAll('#tasks-page .tp-row')].find((el) => el.querySelector('.tp-name').textContent === ${JSON.stringify(ASKS_LATER)}).click()`)
  await until(win, `(${pageState}).title === ${JSON.stringify(`#${ASKS_LATER}`)}`, 'the task from last time on show')
  await run(win, `(() => {
    const field = document.querySelector('#tasks-page .tp-input')
    field.value = ${JSON.stringify(RESTORED_ASK)}
    field.closest('form').requestSubmit()
  })()`)
  await until(win, `(${pageState}).said.some((text) => text.includes('收到：「${RESTORED_ASK}」'))`, 'the task from last time answering')
  await wait(UI_WAIT_MS)
  await capture(win, outDir, 'tasks-restored')
  await run(win, escape)
  const asked = await run(win, userTexts)
  expect(!asked.some((text: string) => text.includes(RESTORED_ASK)), 'the words should not land in the conversation on screen', asked)
}

import { capture, run, submit, until, UI_WAIT_MS, wait } from './smoke-kit.js'

/**
 * Background tasks on the real dsh (phase 3): while a turn waits on an approval, words about something else
 * say over the input that the turn will move to the background; sent, it does, the conversation answers them
 * without it, and the task's approval is asked on its card. 撤销 brings the turn back with its approval, the
 * words going into it. Each task has one card in the conversation and a place on the 后台 page.
 */
/** Unlike configSteps's words, which stay earlier in the same session. */
const BUSY_ASK = '再帮我接入演示服务一次'
const OTHER_ASK = '帮我订一张周五的机票'

const lastAgentText = `[...document.querySelectorAll('#thread > .msg-agent .msg-text')].at(-1)?.textContent ?? ''`
/** Idle without approving anything (smoke-kit finishTurn would allow the task's card too). */
const mainIdle = `(() => {
  const send = document.getElementById('send-btn')
  return send.dataset.busy === 'false' && !send.disabled && !document.querySelector('.caret')
})()`
const userTexts = `[...document.querySelectorAll('#thread > .msg-user, #thread > .msg-user-row .msg-user')].map((el) => el.textContent)`

/** The card of the task named `title` in the conversation, as page code. */
const cardOf = (title) => `[...document.querySelectorAll('#thread .task-card')].find((el) => el.querySelector('.task-name')?.textContent === ${JSON.stringify(`#${title}`)})`
const cardState = (title) => `(() => {
  const card = ${cardOf(title)}
  return card ? { status: card.dataset.status, text: card.textContent, buttons: [...card.querySelectorAll('button')].map((el) => el.textContent) } : null
})()`
/** The card once its task has ended, else nothing yet. */
const doneCard = (title) => `(() => { const card = ${cardState(title)}; return card?.status === 'done' && card })()`
const clickOnCard = (title, label) => `[...(${cardOf(title)}).querySelectorAll('button')].find((el) => el.textContent === ${JSON.stringify(label)}).click()`
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

async function moveSteps(win, outDir, expect, hooks) {
  await submit(win, BUSY_ASK)
  await until(win, `document.querySelector('.confirm:not(.ask)')`, 'the approval card')
  const hint = await run(win, `(() => {
    const input = document.getElementById('composer-input')
    input.value = ${JSON.stringify(OTHER_ASK)}
    input.dispatchEvent(new Event('input', { bubbles: true }))
    const route = document.getElementById('route-hint')
    return { hidden: route.hidden, route: route.dataset.route, text: route.textContent }
  })()`)
  expect(!hint.hidden && hint.route === 'other' && hint.text.includes('挪到后台'), 'words about something else should say the turn moves to the background', hint)
  await wait(UI_WAIT_MS)
  await capture(win, outDir, 'tasks-route')

  const logged = []
  win.webContents.on('console-message', (event) => logged.push(`${event.level}: ${event.message}`))
  await run(win, `document.getElementById('composer').requestSubmit()`)
  const left = await until(win, `document.querySelector('#thread .fold-task') ? 'moved' : document.querySelector('.toast')?.textContent`, 'the line the move leaves')
    .catch(async () => {
      await capture(win, outDir, 'tasks-failed')
      return run(win, `JSON.stringify({ logged: ${JSON.stringify(logged)}, users: [...document.querySelectorAll('#thread .msg-user')].map((el) => el.textContent), cards: document.querySelectorAll('.confirm').length, busy: document.getElementById('send-btn').dataset.busy })`)
    })
  if (left !== 'moved') throw new Error(`the turn did not move to the background: ${left}`)
  await until(win, `(() => ${mainIdle} && (${lastAgentText}).length > 0)()`, 'the conversation answering the new words')
  const moved = await run(win, `({
    fold: document.querySelector('#thread .fold-task')?.textContent ?? '',
    asked: ${userTexts},
    confirms: document.querySelectorAll('.confirm:not(.ask)').length,
    card: ${cardState(BUSY_ASK)},
  })`)
  expect(moved.fold.includes('挪到后台接着做了') && moved.fold.includes(`#${BUSY_ASK}`) && moved.fold.includes('撤销'), 'the move should leave a line to undo it', moved.fold)
  expect(moved.asked.includes(OTHER_ASK) && !moved.asked.includes(BUSY_ASK), 'the conversation should go on with the new words, without the turn moved', moved.asked)
  expect(moved.confirms === 0 && moved.card?.status === 'waiting' && moved.card.buttons.includes('详情 →') && moved.card.text.includes('等你确认'),
    'the moved turn\'s approval should be asked on its card, not as the conversation\'s', moved)
  const answering = (hooks.model?.()?.requests ?? []).map((request) => JSON.stringify(request)).find((json) => json.includes(OTHER_ASK)) ?? ''
  const at = answering.indexOf(BUSY_ASK)
  expect(answering && at < 0, 'the agent answering the new words should not see the turn moved', { found: Boolean(answering), around: answering.slice(Math.max(0, at - 300), at + 60) })
  const island = await run(win, `(() => {
    const el = document.querySelector('#island .isl')
    return { tone: el?.dataset.tone, text: el?.textContent ?? '', count: el?.querySelector('.isl-bg b')?.textContent ?? null }
  })()`)
  expect(island.tone === 'waiting' && island.text.includes(`#${BUSY_ASK}`) && island.count === '1',
    'the island should turn to the task that waits, named, with one in the background at its tail', island)
  await run(win, `document.querySelector('#thread .fold-task').scrollIntoView({ block: 'start' })`)
  await wait(UI_WAIT_MS)
  await capture(win, outDir, 'tasks-moved')
  await pageSteps(win, outDir, expect)
  await mentionSteps(win, outDir, expect)
}

const MENTION_WORDS = '顺便说一声'

/** 「#name words」 go to the background task named: the hint says so, and the conversation on screen is left alone. */
async function mentionSteps(win, outDir, expect) {
  const hint = await run(win, `(() => {
    const input = document.getElementById('composer-input')
    input.value = '#再帮我 ${MENTION_WORDS}'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return document.getElementById('route-hint').textContent
  })()`)
  expect(hint.includes(`交给 #${BUSY_ASK}`), '「#name」 should say the words go to that task', hint)
  await wait(UI_WAIT_MS)
  await capture(win, outDir, 'tasks-mention')
  await run(win, `document.getElementById('composer').requestSubmit()`)
  await wait(UI_WAIT_MS)
  const asked = await run(win, userTexts)
  expect(!asked.some((text) => text.includes(MENTION_WORDS)), 'the words should not land in the conversation on screen', asked)
}

/**
 * The count at the island's tail opens the 后台 page, on the task that waits: its whole conversation, its steps,
 * its approval there too; ← 返回 / Esc closes it. The drawer has no tabs of tasks any more.
 */
async function pageSteps(win, outDir, expect) {
  await run(win, `document.querySelector('#island .isl-bg').click()`)
  const page = await until(win, `(() => { const seen = ${pageState}; return seen.open && seen.title && seen })()`, 'the 后台 page')
  expect(page.title === `#${BUSY_ASK}` && page.rows.includes(BUSY_ASK) && page.act === '停下', 'the tail should open the 后台 page on the task', page)
  const asks = await run(win, `Boolean(document.querySelector('#tasks-page .confirm:not(.ask)'))`)
  expect(asks, 'the task\'s approval should be on its page too', asks)
  await run(win, `document.querySelector('#tasks-page .tp-toggle')?.click()`)
  await wait(UI_WAIT_MS)
  const steps = await run(win, `[...document.querySelectorAll('#tasks-page .trace-title')].map((el) => el.textContent)`)
  expect(steps.some((title) => title.includes('viva_mcp_add') || title.includes('请求你确认')), 'its steps should unfold on its page', steps)
  await capture(win, outDir, 'tasks-page')
  await run(win, escape)
  await wait(UI_WAIT_MS)
  const closed = await run(win, `({ open: document.getElementById('tasks-page').dataset.open, tabs: document.querySelectorAll('#drawer .tab-task').length })`)
  expect(closed.open === 'false' && closed.tabs === 0, 'Esc should close the page; the drawer has no task tabs', closed)
}

async function undoSteps(win, outDir, expect) {
  await run(win, `[...document.querySelectorAll('#thread .fold-task .fold-act')].find((el) => el.textContent === '撤销').click()`)
  await until(win, `!document.querySelector('#thread .fold-task') && document.querySelector('.confirm:not(.ask)')`, 'the turn back on screen')
  await wait(UI_WAIT_MS)
  const back = await run(win, `({
    asked: ${userTexts},
    cards: [...document.querySelectorAll('.confirm:not(.ask) .confirm-head')].map((el) => el.textContent),
    taskCards: document.querySelectorAll('#thread .task-card').length,
  })`)
  expect(back.asked.includes(BUSY_ASK) && back.asked.at(-1) === OTHER_ASK, 'undone, the turn should be back and the words go into it', back.asked)
  expect(back.cards.length === 1 && !back.cards[0].startsWith('#') && back.taskCards === 0, 'undone, its approval should be the conversation\'s again', back)
  await capture(win, outDir, 'tasks-undone')
  // Declined, the turn ends without setting the server up again.
  await run(win, `document.querySelector('.confirm:not(.ask) .btn-secondary').click()`)
  await until(win, mainIdle, 'the turn ending')
}

const BIG_ASK = '把全部文档整理好，顺手接入演示服务'

/**
 * The agent says first that the job will take long: 放到后台 shows beside the turn; taken, the turn goes on in
 * the background with no new words, and the conversation is free.
 */
async function offerSteps(win, outDir, expect) {
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
async function followUpSteps(win, outDir, expect) {
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
  expect(!asked.some((text) => text.includes(FOLLOW_UP)), 'the follow-up should not land in the conversation on screen', asked)
}

/** An ended task reports back on its card; 接着问 asks it again; 详情 → opens its page, and 关掉这件 puts it away. */
async function reportSteps(win, outDir, expect) {
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
const TRAIN_ASK = '帮我订一张下周的火车票'

/**
 * A task asks something after it went to the background: its card asks it, named, and is answered there;
 * the task carries on to its end and reports back.
 */
async function laterQuestionSteps(win, outDir, expect) {
  await submit(win, ASKS_LATER)
  await until(win, `document.querySelector('.confirm:not(.ask)')`, 'the approval card')
  await submit(win, TRAIN_ASK)
  await until(win, `document.querySelector('#thread .fold-task') && ${JSON.stringify(TRAIN_ASK)}`, 'the turn in the background')
  // Declined on its card, the task goes on to ask which city.
  await until(win, `(${cardOf(ASKS_LATER)})?.dataset.status === 'waiting'`, 'the task\'s approval on its card')
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
 * 后台做: the words go to a task of their own, started from the conversation so far; they stay in the
 * conversation with the task's card under them, and the conversation on screen is not busy for it.
 */
async function startSteps(win, outDir, expect) {
  await run(win, `(() => {
    const input = document.getElementById('composer-input')
    input.value = ${JSON.stringify(ON_ITS_OWN)}
    input.dispatchEvent(new Event('input', { bubbles: true }))
    document.getElementById('bg-send').click()
  })()`)
  const started = await until(win, `(() => {
    const card = ${cardState(ON_ITS_OWN)}
    // The words sit in a row of their own (with the bar to go back there); the card comes right after it.
    const rows = [...document.querySelectorAll('#thread > *')]
    const words = rows.findIndex((el) => [...el.querySelectorAll('.msg-user'), el].some((bubble) => bubble.classList.contains('msg-user') && bubble.textContent === ${JSON.stringify(ON_ITS_OWN)}))
    const at = rows.findIndex((el) => el === ${cardOf(ON_ITS_OWN)})
    return card && { card, under: words >= 0 && at === words + 1, busy: document.getElementById('send-btn').dataset.busy, input: document.getElementById('composer-input').value }
  })()`, 'the task started on its own')
  expect(started.under && started.input === '' && started.busy === 'false', '后台做 should leave the words with the task\'s card under them, and the conversation free', started)
  const done = await until(win, doneCard(ON_ITS_OWN), 'the task started on its own reporting back')
  expect(done.text.includes(`收到：「${ON_ITS_OWN}」`), 'the task should answer the words it was given', done)
  const answers = await run(win, `[...document.querySelectorAll('#thread > .msg-agent .msg-text')].map((el) => el.textContent)`)
  expect(!answers.some((text) => text.includes(`收到：「${ON_ITS_OWN}」`)), 'its answer should not be in the conversation on screen', answers)
  await run(win, `(${cardOf(ON_ITS_OWN)}).scrollIntoView({ block: 'center' })`)
  await wait(UI_WAIT_MS)
  await capture(win, outDir, 'tasks-started')
}

const LEFT_ASK = '帮我接入演示服务，留到下次'

/** Last in the memory phase: a task left going in the background, waiting on its approval, as Viva quits. */
async function leaveRunning(win) {
  await submit(win, LEFT_ASK)
  await until(win, `document.querySelector('.confirm:not(.ask)')`, 'the approval card')
  await submit(win, '帮我订一张下周的船票')
  await until(win, `[...document.querySelectorAll('#thread .fold-task')].some((el) => el.textContent.includes(${JSON.stringify(LEFT_ASK)}))`, 'the task left going')
}

/** @param {(ok: boolean, message: string, seen?: unknown) => void} expect */
export async function taskSteps(win, outDir, expect, hooks) {
  await moveSteps(win, outDir, expect, hooks)
  await undoSteps(win, outDir, expect)
  await offerSteps(win, outDir, expect)
  await laterQuestionSteps(win, outDir, expect)
  await startSteps(win, outDir, expect)
  await leaveRunning(win)
}

/**
 * The `resume` phase, on the profile `memory` left: the task Viva quit on is offered; taken up, it goes on
 * in the background and reports back once done. @returns {Promise<string[]>} failed expectations
 */
export async function checkResume(win, outDir) {
  const failures = []
  const expect = (ok, message, seen) => { if (!ok) failures.push(`${message}${seen === undefined ? '' : `: ${JSON.stringify(seen)}`}`) }
  const card = await until(win, `document.querySelector('#thread .task-unfinished')?.textContent ?? null`, 'the task Viva quit on')
  expect(card.includes(`#${LEFT_ASK}`) && card.includes('接着做') && card.includes('不做了'), 'the task Viva quit on should be offered', card)
  await run(win, `document.querySelector('#thread .task-unfinished').scrollIntoView({ block: 'center' })`)
  await wait(UI_WAIT_MS)
  await capture(win, outDir, 'tasks-unfinished')
  await run(win, `[...document.querySelectorAll('#thread .task-unfinished button')].find((el) => el.textContent === '接着做').click()`)
  const report = await until(win, `(() => { const card = ${cardState(LEFT_ASK)}; return card?.status === 'done' && card.text })()`, 'the task taken up reporting back')
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
async function restoredSteps(win, outDir, expect) {
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
  expect(!asked.some((text) => text.includes(RESTORED_ASK)), 'the words should not land in the conversation on screen', asked)
}

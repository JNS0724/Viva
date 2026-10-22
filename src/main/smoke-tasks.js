import { capture, run, submit, until, UI_WAIT_MS, wait } from './smoke-kit.js'

/**
 * Background tasks on the real dsh (phase 3): while a turn waits on an approval, words about something else
 * say over the input that the turn will move to the background; sent, it does, the conversation answers them
 * without it, and its approval stays, marked as the task's. 撤销 brings the turn back with its approval, the
 * words going into it.
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
    asked: [...document.querySelectorAll('#thread > .msg-user, #thread > .msg-user-row .msg-user')].map((el) => el.textContent),
    cards: [...document.querySelectorAll('.confirm:not(.ask) .confirm-head')].map((el) => el.textContent),
  })`)
  expect(moved.fold.includes('挪到后台接着做了') && moved.fold.includes(`#${BUSY_ASK}`) && moved.fold.includes('撤销'), 'the move should leave a line to undo it', moved.fold)
  expect(moved.asked.includes(OTHER_ASK) && !moved.asked.includes(BUSY_ASK), 'the conversation should go on with the new words, without the turn moved', moved.asked)
  expect(moved.cards.length === 1 && moved.cards[0].startsWith(`#${BUSY_ASK}`), 'the moved turn\'s approval should stay, marked as the task\'s', moved.cards)
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
  await drawerSteps(win, outDir, expect)
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
  const asked = await run(win, `[...document.querySelectorAll('#thread > .msg-user, #thread > .msg-user-row .msg-user')].map((el) => el.textContent)`)
  expect(!asked.some((text) => text.includes(MENTION_WORDS)), 'the words should not land in the conversation on screen', asked)
}

/** The task's own tab in the drawer shows what it did, apart from the conversation's 过程. */
async function drawerSteps(win, outDir, expect) {
  await run(win, `(() => {
    if (document.getElementById('drawer').dataset.open !== 'true') document.getElementById('toggle-drawer').click()
  })()`)
  await until(win, `document.querySelector('#drawer .tab-task')`, 'the task\'s tab in the drawer')
  await run(win, `document.querySelector('#drawer .tab-task').click()`)
  await wait(UI_WAIT_MS)
  const shown = await run(win, `({
    tab: document.querySelector('#drawer .tab[aria-selected="true"]')?.textContent ?? '',
    trace: [...document.querySelectorAll('#drawer .trace-title')].map((el) => el.textContent),
  })`)
  expect(shown.tab === `#${BUSY_ASK}` && shown.trace.some((title) => title.includes('viva_mcp_add') || title.includes('请求你确认')),
    'the task\'s tab should show what the task did', shown)
  await capture(win, outDir, 'tasks-drawer')
  await run(win, `[...document.querySelectorAll('#drawer .tab')].find((el) => el.textContent === '过程').click()`)
}

async function undoSteps(win, outDir, expect) {
  await run(win, `[...document.querySelectorAll('#thread .fold-task .fold-act')].find((el) => el.textContent === '撤销').click()`)
  await until(win, `!document.querySelector('#thread .fold-task') && document.querySelector('.confirm:not(.ask)')`, 'the turn back on screen')
  await wait(UI_WAIT_MS)
  const back = await run(win, `({
    asked: [...document.querySelectorAll('#thread > .msg-user, #thread > .msg-user-row .msg-user')].map((el) => el.textContent),
    cards: [...document.querySelectorAll('.confirm:not(.ask) .confirm-head')].map((el) => el.textContent),
  })`)
  expect(back.asked.includes(BUSY_ASK) && back.asked.at(-1) === OTHER_ASK, 'undone, the turn should be back and the words go into it', back.asked)
  expect(back.cards.length === 1 && !back.cards[0].startsWith('#'), 'undone, its approval should be the conversation\'s again', back.cards)
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
    asked: [...document.querySelectorAll('#thread > .msg-user, #thread > .msg-user-row .msg-user')].map((el) => el.textContent),
    count: document.querySelector('#island .isl-bg b')?.textContent ?? null,
  })`)
  expect(after.busy === 'false' && !after.asked.includes(BIG_ASK) && after.count === '1', 'taken, the turn should go on in the background and the conversation be free', after)
  // Done with: its approval declined from the island-marked card, the task ends.
  await run(win, `document.querySelector('.confirm:not(.ask) .btn-secondary').click()`)
  await until(win, `!document.querySelector('#island .isl-bg')`, 'the task ending')
  await reportSteps(win, outDir, expect)
}

/** An ended task reports back in the conversation; 看全部 opens its tab, and 关掉这件 puts it away. */
async function reportSteps(win, outDir, expect) {
  const report = await until(win, `document.querySelector('#thread .task-report')?.textContent ?? null`, 'the task\'s report')
  expect(report.includes(`#${BIG_ASK}`), 'the report should name the task', report)
  await run(win, `document.querySelector('#thread .task-report').scrollIntoView({ block: 'center' })`)
  await wait(UI_WAIT_MS)
  await capture(win, outDir, 'tasks-report')
  await run(win, `document.querySelector('#thread .task-report-open').click()`)
  const tab = await until(win, `document.querySelector('#drawer .task-tab-act')?.textContent ?? null`, 'the task\'s tab')
  expect(tab === '关掉这件', 'an ended task\'s tab should offer to close it', tab)
  await wait(UI_WAIT_MS)
  await capture(win, outDir, 'tasks-closing')
  await run(win, `document.querySelector('#drawer .task-tab-act').click()`)
  const after = await until(win, `(() => {
    const tabs = [...document.querySelectorAll('#drawer .tab-task')].map((el) => el.textContent)
    return !tabs.includes('#${BIG_ASK}') && { tabs, report: Boolean(document.querySelector('#thread .task-report')) }
  })()`, 'the task put away')
  expect(!after.report, 'closed, the task\'s report should go too', after)
}

const ASKS_LATER = '接入演示服务，再问我城市'
const TRAIN_ASK = '帮我订一张下周的火车票'

/**
 * A task asks something after it went to the background: its own card in the thread, named, answers it, and
 * the task carries on to its end and reports back.
 */
async function laterQuestionSteps(win, outDir, expect) {
  await submit(win, ASKS_LATER)
  await until(win, `document.querySelector('.confirm:not(.ask)')`, 'the approval card')
  await submit(win, TRAIN_ASK)
  await until(win, `document.querySelector('#thread .fold-task') && ${JSON.stringify(TRAIN_ASK)}`, 'the turn in the background')
  // Declined, the task goes on to ask which city.
  await run(win, `document.querySelector('.confirm:not(.ask) .btn-secondary').click()`)
  const card = await until(win, `(() => {
    const card = document.querySelector('.confirm.ask')
    return card && { head: card.querySelector('.confirm-head')?.textContent ?? '', options: [...card.querySelectorAll('.ask-option')].map((el) => el.textContent) }
  })()`, "the task's question")
  expect(card.head.startsWith(`#${ASKS_LATER}`) && card.options.join() === '上海,北京', "the task's question should be its own card, named", card)
  await run(win, `document.querySelector('.confirm.ask').scrollIntoView({ block: 'center' })`)
  await wait(UI_WAIT_MS)
  await capture(win, outDir, 'tasks-question')
  await run(win, `[...document.querySelectorAll('.confirm.ask .ask-option')].find((el) => el.textContent === '上海').click()`)
  const report = await until(win, `[...document.querySelectorAll('#thread .task-report')].map((el) => el.textContent).find((text) => text.includes(${JSON.stringify(ASKS_LATER)})) ?? null`, "the task's report after the answer")
  expect(report.includes('按上海来看'), 'answered, the task should carry on and report what it said', report)
  const asked = await run(win, `[...document.querySelectorAll('#thread > .msg-user, #thread > .msg-user-row .msg-user')].map((el) => el.textContent)`)
  expect(!asked.includes('上海'), 'the answer should go to the task, not the conversation on screen', asked)
}

/** @param {(ok: boolean, message: string, seen?: unknown) => void} expect */
export async function taskSteps(win, outDir, expect, hooks) {
  await moveSteps(win, outDir, expect, hooks)
  await undoSteps(win, outDir, expect)
  await offerSteps(win, outDir, expect)
  await laterQuestionSteps(win, outDir, expect)
}

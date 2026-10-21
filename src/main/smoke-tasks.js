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

/** @param {(ok: boolean, message: string, seen?: unknown) => void} expect */
export async function taskSteps(win, outDir, expect, hooks) {
  await moveSteps(win, outDir, expect, hooks)
  await undoSteps(win, outDir, expect)
}

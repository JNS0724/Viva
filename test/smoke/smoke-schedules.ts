import { FOLLOWUP, FOLLOWUP_AHEAD_MS } from '../fixtures/fake-llm.js'
import { capture, finishTurn, report, run, submit, UI_WAIT_MS, until, wait, type SmokeWindow } from './smoke-kit.ts'

/**
 * Schedules in the memory smoke run (smoke.ts), on the real dsh with the fake model (test/fixtures/fake-llm.js):
 * asked 「…到时候帮我…」, the model proposes a schedule a minute ahead; the card waits for 定时; 动态 lists it in
 * 接下来, where it pauses and resumes; when it is due its prompt runs where nobody watches, and its answer comes
 * into 动态 as a new item, counted in the title bar; 在对话里继续 puts it in the input for the user to send.
 */
const CARD = '#thread .fu-card'
const PAGE = '#feed-page'
/** Due a minute after it was proposed, then a run on the fake model: well within this. */
const RUN_TIMEOUT_MS = FOLLOWUP_AHEAD_MS + 90_000
const q = (selector: string) => `document.querySelector(${JSON.stringify(selector)})`
const clickText = (scope: string, text: string) =>
  `[...document.querySelectorAll(${JSON.stringify(`${scope} button`)})].find((b) => b.textContent === ${JSON.stringify(text)}).click()`
const row = (status: string) => `[...document.querySelectorAll('${PAGE} .fu-row[data-status="${status}"]')].find((el) => el.textContent.includes(${JSON.stringify(FOLLOWUP.title)}))`

interface FormSeen { title: string, prompt: string, repeat: string, time: string, shown: string[], weekly: string[] }
/** The form's values, and which rows show (by data-for); then, 每周 picked, which show for it. */
const READ_FORM = `(() => {
  const form = ${q(`${CARD} .fu-form`)}
  const value = (name) => form.querySelector('[name^="proposal-' + name + '-"]').value
  const shown = () => [...form.querySelectorAll('[data-for]')].filter((el) => getComputedStyle(el).display !== 'none').map((el) => el.dataset.for)
  const seen = { title: value('title'), prompt: value('prompt'), repeat: value('repeat'), time: value('time'), shown: shown() }
  const repeat = form.querySelector('[name^="proposal-repeat-"]')
  repeat.value = 'weekly'
  const weekly = shown()
  repeat.value = seen.repeat
  return { ...seen, weekly }
})()`

/**
 * 修改 on the card: the proposal as a form, in plain fields (no cron to edit), the rows for the repeat picked; 取消
 * puts the card back as it was. Nothing is changed here: the run below is timed by the proposal as it came.
 * @returns failures
 */
async function checkEditForm(win: SmokeWindow, outDir: string): Promise<string[]> {
  await run(win, clickText(CARD, '修改'))
  await until(win, q(`${CARD} .fu-form`), '修改 opens the form')
  const seen = await run(win, READ_FORM) as FormSeen
  report(`schedule form: ${JSON.stringify(seen)}`)
  const failures: string[] = []
  if (seen.title !== FOLLOWUP.title || seen.prompt !== FOLLOWUP.prompt || seen.repeat !== 'at' || !/^\d\d:\d\d$/.test(seen.time)) {
    failures.push(`the form should hold the proposal, once, at its time: ${JSON.stringify(seen)}`)
  }
  if (seen.shown.join('|') !== 'at|at daily weekly monthly') failures.push(`a once schedule should show its date and time only: ${JSON.stringify(seen.shown)}`)
  if (seen.weekly.join('|') !== 'weekly|at daily weekly monthly') failures.push(`每周 should show the weekdays and time: ${JSON.stringify(seen.weekly)}`)
  await capture(win, outDir, 'schedule-edit')
  await run(win, `(() => { const repeat = ${q(`${CARD} [name^="proposal-repeat-"]`)}; repeat.value = 'weekly'; ${q(CARD)}.scrollIntoView({ block: 'end' }) })()`)
  await wait(UI_WAIT_MS)
  await capture(win, outDir, 'schedule-edit-weekly')
  await run(win, clickText(CARD, '取消'))
  await until(win, `!${q(`${CARD} .fu-form`)} && Boolean(${q(`${CARD} .confirm-title`)})`, '取消 puts the card back')
  return failures
}

/**
 * The renderer's own nodes: a card proposed in the first turn stays under that turn's answer once the conversation
 * has gone on, before what the user said next (proposal-state.ts proposalHost), not under everything.
 */
const CARD_PLACE = `(async () => {
  const { initialState, reduce } = await import('./state.js')
  const { renderThread } = await import('./view/thread.js')
  const container = document.createElement('div')
  container.style.cssText = 'position:fixed;left:-10000px;top:0;width:760px'
  document.body.append(container)
  const handlers = new Proxy({}, { get: () => () => {} })
  const said = (role, text) => ({ role, text })
  let state = reduce(initialState, { type: 'history_loaded', conversationId: 'card-place', savedAt: 1,
    messages: [said('user', '第一个问题'), said('assistant', '第一个回答'), said('user', '第二个问题'), said('assistant', '第二个回答')] })
  const proposal = { proposalId: 'place', title: '周报', prompt: '起草周报', firstAt: new Date(Date.now() + 3600000).toISOString(), rule: { kind: 'at' } }
  state = { ...state, proposals: [{ id: 'place', proposal, status: 'open', after: 1 }] }
  try {
    renderThread(container, state, handlers, Date.now())
    const card = container.querySelector('.fu-card'), texts = [...container.querySelectorAll('.msg-user, .msg-agent')]
    const before = (a, b) => Boolean(a && b && a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
    const answer = texts.find((el) => el.textContent.includes('第一个回答')), next = texts.find((el) => el.textContent.includes('第二个问题'))
    return { card: Boolean(card), afterAnswer: before(answer, card), beforeNext: before(card, next) }
  } finally { container.remove() }
})()`

/** @returns failures */
export async function checkSchedules(win: SmokeWindow, outDir: string): Promise<string[]> {
  const failures: string[] = []
  const place = await run(win, CARD_PLACE) as { card: boolean, afterAnswer: boolean, beforeNext: boolean }
  report(`schedule card place: ${JSON.stringify(place)}`)
  if (!place.card || !place.afterAnswer || !place.beforeNext) failures.push(`a card should stay under its turn's answer, before the next question: ${JSON.stringify(place)}`)
  await submit(win, '周五下班前要交周报，到时候帮我弄一下')
  await finishTurn(win)
  await until(win, q(`${CARD}[aria-label="要我定时做吗？"]`), 'the proposal card under the conversation')
  await run(win, `${q(CARD)}.scrollIntoView({ block: 'center' })`)
  await wait(UI_WAIT_MS)
  await capture(win, outDir, 'schedule-card')
  failures.push(...await checkEditForm(win, outDir))
  await run(win, clickText(CARD, '定时'))
  await until(win, q(`${CARD}.fu-done`), 'kept: the card says when it runs')

  await run(win, `${q('#open-feed')}.click()`)
  await until(win, `Boolean(${row('active')})`, 'the schedule in 动态, coming up')
  await run(win, `${row('active')}.click()`)
  await until(win, `${q(`${PAGE} .fu-main`)}?.textContent.includes(${JSON.stringify(FOLLOWUP.prompt)})`, 'its prompt, shown')
  await run(win, clickText(`${PAGE} .fu-main`, '暂停'))
  await until(win, `Boolean(${row('paused')})`, 'paused')
  await run(win, clickText(`${PAGE} .fu-main`, '恢复'))
  await until(win, `Boolean(${row('active')})`, 'resumed')
  await capture(win, outDir, 'schedule-next')

  await until(win, `Boolean(${row('new')})`, 'due, it ran, and its answer is new in 动态', RUN_TIMEOUT_MS)
  const count = String(await run(win, `${q('#feed-count')}.hidden ? '' : ${q('#feed-count')}.textContent`))
  if (count !== '1') failures.push(`the title bar should count the one new item: ${JSON.stringify(count)}`)
  await run(win, `${row('new')}.click()`)
  await until(win, q(`${PAGE} .fu-draft`), 'its answer')
  const answer = String(await run(win, `${q(`${PAGE} .fu-draft`)}.textContent`))
  report(`schedule answer: ${answer.slice(0, 80)}`)
  if (!answer.includes(FOLLOWUP.prompt)) failures.push(`the answer should be the run of its prompt: ${answer.slice(0, 120)}`)
  await capture(win, outDir, 'schedule-ran')

  await run(win, clickText(`${PAGE} .fu-main`, '在对话里继续'))
  await until(win, `document.getElementById('composer-input').value.startsWith('来自动态的「${FOLLOWUP.title}」')`, '在对话里继续 puts it in the input')
  await capture(win, outDir, 'schedule-continue')
  await run(win, `(() => { const input = document.getElementById('composer-input'); input.value = ''; input.dispatchEvent(new Event('input')) })()`)
  return failures
}

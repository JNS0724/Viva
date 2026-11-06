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

/** @returns failures */
export async function checkSchedules(win: SmokeWindow, outDir: string): Promise<string[]> {
  const failures: string[] = []
  await submit(win, '周五下班前要交周报，到时候帮我弄一下')
  await finishTurn(win)
  await until(win, q(`${CARD}[aria-label="要我定时做吗？"]`), 'the proposal card under the conversation')
  await run(win, `${q(CARD)}.scrollIntoView({ block: 'center' })`)
  await wait(UI_WAIT_MS)
  await capture(win, outDir, 'schedule-card')
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

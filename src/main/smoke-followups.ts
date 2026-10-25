import { capture, finishTurn, report, run, submit, UI_WAIT_MS, until, wait, type SmokeHooks, type SmokeWindow } from './smoke-kit.ts'

/**
 * Follow-ups in the memory smoke run (smoke.ts), on the real dsh with the fake model (test/fixtures/fake-llm.js):
 * asked 「…到时候帮我…」, the model proposes; the card waits for 跟进; the first follow-up that needs preparing asks
 * for windows (每天三次); the 后台 page (opened as a notification opens it) lists it as scheduled; 现在就准备 makes
 * the draft at once, with no tools offered to the model; ready, 接着做 puts it in the input for the user to send.
 */
const CARD = '#thread .fu-card'
const PAGE = '#tasks-page'
const PREPARE_TIMEOUT_MS = 90_000
const q = (selector: string) => `document.querySelector(${JSON.stringify(selector)})`
const clickText = (scope: string, text: string) =>
  `[...document.querySelectorAll(${JSON.stringify(`${scope} button`)})].find((b) => b.textContent === ${JSON.stringify(text)}).click()`
const anyText = (selector: string, text: string) =>
  `[...document.querySelectorAll(${JSON.stringify(selector)})].some((el) => el.textContent.includes(${JSON.stringify(text)}))`

/** @returns failures */
export async function checkFollowups(win: SmokeWindow, outDir: string, hooks: SmokeHooks): Promise<string[]> {
  const failures: string[] = []
  await submit(win, '周五下班前要交周报，到时候帮我弄一下')
  await finishTurn(win)
  await until(win, q(`${CARD}[aria-label="要我跟进吗？"]`), 'the proposal card under the conversation')
  await run(win, `${q(CARD)}.scrollIntoView({ block: 'center' })`)
  await wait(UI_WAIT_MS)
  await capture(win, outDir, 'followup-card')
  await run(win, clickText(CARD, '跟进'))
  await until(win, q(`${CARD} .fu-choose`), 'the first follow-up that needs preparing asks for windows')
  await capture(win, outDir, 'followup-windows')
  await run(win, `${q(`${CARD} .fu-preset`)}.click()`)
  await until(win, anyText(`${CARD} .fu-note`, '每天三次'), 'the windows chosen')

  hooks.openTasksPage()
  await until(win, q(`${PAGE} .fu-row[data-status="scheduled"]`), 'the follow-up on the 后台 page, scheduled')
  await run(win, `${q(`${PAGE} .fu-row[data-status="scheduled"]`)}.click()`)
  await until(win, q(`${PAGE} .fu-main`), 'its detail')
  await run(win, clickText(`${PAGE} .fu-main`, '现在就准备'))
  await until(win, q(`${PAGE} .fu-draft`), 'the draft prepared in the background', PREPARE_TIMEOUT_MS)
  const draft = String(await run(win, `${q(`${PAGE} .fu-draft`)}.textContent`))
  report(`followup draft: ${draft.slice(0, 80)}`)
  if (!draft.includes('草稿（工具 0 个）')) failures.push(`the draft should be written with no tools offered: ${draft.slice(0, 120)}`)
  await capture(win, outDir, 'followup-ready')

  await run(win, clickText(`${PAGE} .fu-main`, '接着做'))
  await until(win, `document.getElementById('composer-input').value.startsWith('接着做「周报」')`, '接着做 puts the draft in the input')
  await capture(win, outDir, 'followup-continue')
  await run(win, `(() => { const input = document.getElementById('composer-input'); input.value = ''; input.dispatchEvent(new Event('input')) })()`)
  return failures
}

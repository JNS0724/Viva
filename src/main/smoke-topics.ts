import { capture, finishTurn, report, run, submit, UI_WAIT_MS, until, wait, type Expect, type SmokeWindow } from './smoke-kit.ts'
// newTopic: ⌘N, the first time; ＋ 新话题 above the input, the second.

/**
 * Topics in the walkthrough smoke run (smoke.js): ⌘N shows at once where the new topic starts, the label by
 * the input goes back to nothing, and 撤销 takes the last topic up again; said something in a new topic, the
 * topic above folds to a line that says the assistant no longer has it, and 回到这个话题 takes it up again.
 */
const TIMELINE = `(() => ({
  start: document.querySelector('#earlier .topic-start')?.textContent ?? null,
  undo: Boolean(document.querySelector('#earlier .topic-start .topic-back')),
  note: document.querySelector('#earlier .topic-note')?.textContent ?? null,
  old: document.querySelectorAll('#earlier .topic-old').length,
  // Folded to its line: what it is in the line, that the assistant no longer has it in its tooltip.
  oldHead: ((head) => head && head.title + ' ' + head.textContent)(document.querySelector('#earlier .topic-old .topic-head')),
  label: document.querySelector('#ctx-area .ctx-chip')?.textContent ?? null,
  switching: document.getElementById('send-btn').disabled,
}))()`

/** Waits until the timeline shows what `test` (page code over `seen`) asks, and returns what it showed. */
const timelineWhen = (win: SmokeWindow, test: string, what: string) => until(win, `(() => { const seen = ${TIMELINE}; return (${test}) && seen })()`, what)

/** @returns {Promise<string[]>} failures */
export async function checkTopics(win: SmokeWindow, outDir: string) {
  const failures: string[] = []
  const expect: Expect = (ok, message, seen) => { if (!ok) failures.push(`topics: ${message}: ${JSON.stringify(seen)}`) }

  const immediate = await run(win, `(() => {
    const input = document.getElementById('composer-input')
    input.value = '新话题准备期间保留的草稿'
    window.topicProbeStart = performance.now()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', metaKey: true, bubbles: true }))
    return { disabled: document.getElementById('send-btn').disabled, editable: !input.disabled,
      focused: document.activeElement === input, draft: input.value,
      handlerMs: performance.now() - window.topicProbeStart,
      label: document.querySelector('#ctx-area .ctx-new')?.textContent }
  })()`)
  expect(immediate.disabled && immediate.editable && immediate.focused, 'new topic should focus an editable draft immediately, before sending is ready', immediate)
  expect(immediate.label?.includes('准备'), 'preparation should be visible immediately', immediate)
  const fresh = await timelineWhen(win, 'seen.undo && !seen.switching', 'a new topic shown where it starts')
  const ready = await run(win, `(() => {
    const input = document.getElementById('composer-input')
    const result = { draft: input.value, observedReadyMs: performance.now() - window.topicProbeStart }
    input.value = ''
    return result
  })()`)
  expect(ready.draft === immediate.draft, 'runtime readiness must preserve the draft', ready)
  report('new-topic responsiveness: ' + JSON.stringify({ immediate, ready }))
  await wait(UI_WAIT_MS)
  await capture(win, outDir, 'topic-new')
  expect(fresh.start?.includes('新话题'), 'the new topic should say where it starts', fresh)
  expect(fresh.note?.includes('重新开始'), 'it should say the assistant starts afresh', fresh)
  expect(fresh.label?.includes('本话题 · 0 条'), 'the label should go back to nothing', fresh)

  await run(win, `document.querySelector('#earlier .topic-start .topic-back').click()`)
  const undone = await timelineWhen(win, '!seen.start && !seen.switching', 'the new topic undone')
  // Topics the walkthrough started before stay dimmed; only the one just left is taken up again.
  expect(undone.old === fresh.old - 1 && !undone.label?.includes('· 0 条'), 'undone, the topic above is the one on screen again', { fresh, undone })

  // The second time with ＋ 新话题 above the input, as most people will.
  await run(win, `document.querySelector('#ctx-area .ctx-new').click()`)
  await timelineWhen(win, 'seen.undo && !seen.switching', 'a second new topic, from ＋ 新话题')
  await submit(win, '换个话题问问')
  await finishTurn(win)
  const moved = await timelineWhen(win, 'seen.old >= 1', 'the topic left behind, dimmed')
  expect(moved.oldHead?.includes('助手不记得这段'), 'the topic left behind should say the assistant no longer has it', moved)
  expect(!moved.undo, 'once something is said the new topic can no longer be undone', moved)
  await run(win, `document.querySelector('#earlier .topic-old').scrollIntoView({ block: 'start' })`)
  await wait(UI_WAIT_MS)
  await capture(win, outDir, 'topic-old')

  await run(win, `[...document.querySelectorAll('#earlier .topic-old .topic-back')].at(-1).click()`)
  const back = await timelineWhen(win, `seen.start?.includes('回到') && !seen.switching`, 'back to the earlier topic')
  await run(win, `document.getElementById('scroll').scrollTop = 1e9`)
  await wait(UI_WAIT_MS)
  await capture(win, outDir, 'topic-back')

  await run(win, `document.querySelector('#ctx-area .ctx-chip').click()`)
  const menu = await until(win, `document.querySelector('#ctx-area .ctx-menu')?.textContent`, 'the label\'s menu')
  await wait(UI_WAIT_MS)
  await capture(win, outDir, 'topic-menu')
  expect(menu.includes('记得') && !menu.includes('压缩成要点'), 'the label should say what is remembered, and offer nothing not built', menu)
  await run(win, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  report(`topics: ${JSON.stringify({ fresh, undone, moved, back, menu })}`)
  return failures
}

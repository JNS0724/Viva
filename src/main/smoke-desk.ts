import { MISSING } from './island-files.ts'
import { capture, finishTurn, report, run, UI_WAIT_MS, until, wait, type SmokeWindow } from './smoke-kit.ts'

/**
 * The desktop island's input in the walkthrough smoke run (smoke.js): opened as by the shortcut, it takes the
 * keyboard; files dragged over it open it up; a file the system gives no path for is refused; a question
 * typed there lands in the window's conversation, marked as asked on the island; asked again while the agent
 * works, it goes into that turn, marked as said while it worked.
 */
const QUESTION = '在岛上问一句'
const STEER = '顺便用英文回答'

const INPUT_STATE = `(() => {
  const island = document.querySelector('.isl')
  return island?.dataset.form === 'input' && {
    focused: document.activeElement?.classList.contains('isl-field') ?? false,
    hint: island.querySelector('.isl-hint')?.textContent ?? '',
  }
})()`

// Files dragged over the island: the page hears dragover again and again while they are there.
const DRAG_OVER = `(() => {
  const files = new DataTransfer()
  files.items.add(new File(['x'], '笔记.txt', { type: 'text/plain' }))
  const island = document.querySelector('.isl')
  const over = () => island.dispatchEvent(new DragEvent('dragover', { dataTransfer: files, bubbles: true, cancelable: true }))
  over()
  window.smokeDrag = { files, timer: setInterval(over, 100) }
})()`

const DROP = `(() => {
  clearInterval(window.smokeDrag.timer)
  document.querySelector('.isl').dispatchEvent(new DragEvent('drop', { dataTransfer: window.smokeDrag.files, bubbles: true, cancelable: true }))
})()`

const typeAndSend = (text: string) => `(() => {
  const field = document.querySelector('.isl-field')
  field.value = ${JSON.stringify(text)}
  field.dispatchEvent(new Event('input', { bubbles: true }))
  field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
})()`

const ASKED_IN_THREAD = `(() => {
  const last = [...document.querySelectorAll('.msg-user')].at(-1)
  return Boolean(last?.textContent.includes(${JSON.stringify(QUESTION)}) && document.querySelector('.msg-via'))
})()`

/** While the agent is on the turn the input takes words for that turn. */
const STEERING = `(() => {
  const field = document.querySelector('.isl')?.dataset.form === 'input' && document.querySelector('.isl-field')
  return field && !field.disabled && field.placeholder.includes('插话') && field.placeholder
})()`

const STEERED_IN_THREAD = `(() => {
  const last = [...document.querySelectorAll('.msg-user')].at(-1)
  const note = last?.nextElementSibling
  return Boolean(last?.textContent.includes(${JSON.stringify(STEER)}) && note?.textContent.includes('工作中插话') && !note.textContent.includes('没有送到'))
})()`

/** @returns {Promise<string[]>} failures */
export async function checkDeskAsk(win: SmokeWindow, outDir: string, desk: any) {
  if (!desk) return ['the desktop island was not created']
  desk.force(true)
  try {
    if (!desk.openInput()) return ['the desktop island would not open its input']
    const page = { webContents: desk.webContents() }
    const logged: string[] = []
    page.webContents.on('console-message', (event: { level: string, message: string }) => logged.push(`${event.level}: ${event.message}`))
    const opened = await until(page, INPUT_STATE, 'the island input opening').catch(async (err) => {
      const shown = await run(page, `document.querySelector('.isl')?.dataset.form ?? null`)
      throw new Error(`${err.message}; input open: ${desk.inputOpen()}, island showing ${shown}, logged ${JSON.stringify(logged)}`)
    })
    await wait(UI_WAIT_MS)
    await capture(page, outDir, 'desk-input')

    await run(page, DRAG_OVER)
    const drop = await until(page, `document.querySelector('.isl')?.dataset.form === 'drop' && document.querySelector('.isl-drop')?.textContent`, 'the island opening for dropped files')
    await wait(UI_WAIT_MS)
    await capture(page, outDir, 'desk-drop')
    await run(page, DROP)
    const refused = await until(page, `document.querySelector('.isl-error')?.textContent`, 'the island refusing a file it has no path for')

    await run(page, typeAndSend(QUESTION))
    await until(win, ASKED_IN_THREAD, 'the question asked on the island in the thread')
    await until(page, `document.querySelector('.isl')?.dataset.form !== 'input'`, 'the island input closing once it was sent')
    desk.openInput()
    const steering = await until(page, STEERING, 'the island input taking words for the turn while the agent works')
    await wait(UI_WAIT_MS)
    await capture(page, outDir, 'desk-steer')
    await run(page, typeAndSend(STEER))
    await until(win, STEERED_IN_THREAD, 'the words said on the island in the thread, into the running turn')
    desk.closeInput()
    await finishTurn(win)
    await capture(win, outDir, 'desk-asked')
    report(`desk input: ${JSON.stringify({ opened, drop, refused, steering })}`)

    const failures: string[] = []
    if (!opened.focused) failures.push('the island input should take the keyboard')
    if (!opened.hint.includes('发到当前对话')) failures.push(`the island input should say where the question goes: ${opened.hint}`)
    if (refused !== MISSING) failures.push(`a dropped file without a path should be refused with "${MISSING}", was "${refused}"`)
    return failures
  } finally {
    desk.closeInput()
    desk.force(false)
  }
}

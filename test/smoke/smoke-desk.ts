import type { SmokeDesk } from './smoke-kit.ts'
import { MISSING } from '../../src/shell/island-files.ts'
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
const PANEL_HEIGHT = `document.querySelector('.isl-surface:not([hidden])')?.offsetHeight ?? 0`

const heightWithDraft = (text: string) => `(() => {
  const field = document.querySelector('.isl-field')
  field.value = ${JSON.stringify(text)}
  return ${PANEL_HEIGHT}
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

const readyToSteer = `field?.closest('.isl')?.dataset.form === 'input' && field.checkVisibility()
  && !field.disabled && !field.readOnly && field.placeholder.includes('下一步会读到')`

const typeAndSend = (text: string, requireSteering = false) => `(() => {
  const field = document.querySelector('.isl-field')
  ${requireSteering ? `if (!(${readyToSteer})) return false` : ''}
  field.value = ${JSON.stringify(text)}
  field.dispatchEvent(new Event('input', { bubbles: true }))
  field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  return true
})()`

const ASKED_IN_THREAD = `(() => {
  const last = [...document.querySelectorAll('.msg-user')].at(-1)
  return Boolean(last?.textContent.includes(${JSON.stringify(QUESTION)}) && document.querySelector('.msg-via'))
})()`

/** While the agent is on the turn the input takes words for that turn. */
const STEERING = `(() => {
  const field = document.querySelector('.isl-field')
  return ${readyToSteer} && field.placeholder
})()`

const STEERED_IN_THREAD = `(() => {
  const last = [...document.querySelectorAll('.msg-user')].at(-1)
  const note = last?.closest('.msg-user-row')?.nextElementSibling ?? last?.nextElementSibling
  return Boolean(last?.textContent.includes(${JSON.stringify(STEER)}) && note?.textContent.includes('工作中插话') && !note.textContent.includes('没有送到'))
})()`

/** @returns {Promise<string[]>} failures */
export async function checkDeskAsk(win: SmokeWindow, outDir: string, desk: SmokeDesk) {
  if (!desk) return ['the desktop island was not created']
  await desk.force(true)
  try {
    if (!(await desk.openInput())) return ['the desktop island would not open its input']
    const page = { webContents: (await desk.webContents()) }
    const logged: string[] = []
    page.webContents.on('console-message', (event: { level: string, message: string }) => logged.push(`${event.level}: ${event.message}`))
    const opened = await until(page, INPUT_STATE, 'the island input opening').catch(async (err) => {
      const shown = await run(page, `document.querySelector('.isl')?.dataset.form ?? null`)
      throw new Error(`${err.message}; input open: ${(await desk.inputOpen())}, island showing ${shown}, logged ${JSON.stringify(logged)}`)
    })
    await wait(UI_WAIT_MS)
    const emptyHeight: number = await run(page, PANEL_HEIGHT)
    await capture(page, outDir, 'desk-input')
    const singleLineHeight: number = await run(page, heightWithDraft('整理会议纪要'))
    const multilineHeight: number = await run(page, heightWithDraft('整理会议纪要\n把待办事项单独列出来'))
    const clearedHeight: number = await run(page, heightWithDraft(''))

    // The field and the document both hear the key. Assert that neither consumes it in the
    // dispatch itself, so a later native window blur cannot be reported as an IME key failure.
    const readyForComposition = `(() => {
      const field = document.querySelector('.isl[data-form="input"] .isl-field')
      return field && !field.disabled && !field.readOnly
    })()`
    if (!await run(page, readyForComposition)) await desk.openInput()
    await until(page, readyForComposition, 'the island draft being editable for IME confirmation')
    const composition: Array<{ key: string, legacy: boolean, kept: boolean }> = await run(page, `(() => {
      const field = document.querySelector('.isl-field')
      const draft = field.value
      const candidate = '尚未确认的中文 🐈'
      const samples = []
      field.value = candidate
      try {
        for (const key of ['Enter', 'Escape']) for (const legacy of [false, true]) {
          const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true,
            isComposing: !legacy, keyCode: legacy ? 229 : 0 })
          const allowed = field.dispatchEvent(event)
          const kept = allowed && field.value === candidate
            && event.isComposing === !legacy && event.keyCode === (legacy ? 229 : 0)
          samples.push({ key, legacy, kept })
        }
      } finally { field.value = draft }
      return samples
    })()`)

    await run(page, DRAG_OVER)
    const drop = await until(page, `document.querySelector('.isl')?.dataset.form === 'drop' && document.querySelector('.isl-drop')?.textContent`, 'the island opening for dropped files')
    await wait(UI_WAIT_MS)
    const dropHeight: number = await run(page, PANEL_HEIGHT)
    await capture(page, outDir, 'desk-drop')
    await run(page, DROP)
    const refused = await until(page, `document.querySelector('.isl-error')?.textContent`, 'the island refusing a file it has no path for')

    await run(page, typeAndSend(QUESTION))
    await until(win, ASKED_IN_THREAD, 'the question asked on the island in the thread')
    await until(page, `document.querySelector('.isl')?.dataset.form !== 'input'`, 'the island input closing once it was sent')
    await desk.openInput()
    const steering = await until(page, STEERING, 'the island input taking words for the turn while the agent works')
    await wait(UI_WAIT_MS)
    await capture(page, outDir, 'desk-steer')
    // A native blur can collapse the editor while the screenshot is taken.
    const sendSteer = typeAndSend(STEER, true)
    if (!await run(page, sendSteer)) {
      await desk.openInput()
      await until(page, sendSteer, 'sending the island interjection from its visible editor')
    }
    await until(win, STEERED_IN_THREAD, 'the words said on the island in the thread, into the running turn')
    await desk.closeInput()
    await finishTurn(win)
    await capture(win, outDir, 'desk-asked')
    const heights = { emptyHeight, singleLineHeight, multilineHeight, clearedHeight, dropHeight }
    report(`desk input: ${JSON.stringify({ opened, heights, composition, drop, refused, steering })}`)

    const failures: string[] = []
    if (emptyHeight !== 112 || singleLineHeight !== emptyHeight || clearedHeight !== emptyHeight) failures.push(`the empty and single-line desktop input should stay at 112px: ${JSON.stringify(heights)}`)
    if (multilineHeight <= emptyHeight || dropHeight <= emptyHeight) failures.push(`the desktop input should expand for multiple lines and files dragged over it: ${JSON.stringify(heights)}`)
    if (composition.some(item => !item.kept)) failures.push(`IME confirmation must keep the desktop island input: ${JSON.stringify(composition)}`)
    if (!opened.focused) failures.push('the island input should take the keyboard')
    if (!opened.hint.includes('发到当前对话')) failures.push(`the island input should say where the question goes: ${opened.hint}`)
    if (refused !== MISSING) failures.push(`a dropped file without a path should be refused with "${MISSING}", was "${refused}"`)
    return failures
  } finally {
    await desk.closeInput()
    await desk.force(false)
  }
}

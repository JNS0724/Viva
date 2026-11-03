import type { SmokeDesk } from './smoke-kit.ts'
import { capture, finishTurn, report, run, UI_WAIT_MS, until, wait, type SmokeWindow } from './smoke-kit.ts'

/**
 * Pictures in the walkthrough smoke run (smoke.js): a picture copied with words that came only as formatted
 * text (as from WeChat or a web page, which pasted nothing before) is pasted into the main input; both come
 * in; it is sent and the agent gets it; pasted on the desktop island, it lands in the window's conversation
 * too; settings count them, and emptying the folder empties it.
 */
const HTML_WORDS = '网页里的文字'
const ISLAND_WORDS = '岛上这张图呢'

/** A real PNG drawn in the page, pasted with HTML only, as WeChat and browsers copy a picture with words. */
const pasteInto = (selector: string, withWords: boolean) => `(async () => {
  const canvas = document.createElement('canvas')
  canvas.width = 24
  canvas.height = 16
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#5aa9ff'
  ctx.fillRect(0, 0, 24, 16)
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
  const data = new DataTransfer()
  data.items.add(new File([blob], 'image.png', { type: 'image/png' }))
  ${withWords ? `data.setData('text/html', '<p>${HTML_WORDS}</p><img src="x.png">')` : ''}
  const field = document.querySelector(${JSON.stringify(selector)})
  field.focus()
  field.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  return true
})()`

const DRAFT = `(() => {
  const img = document.querySelector('.draft-pic img')
  return img?.complete && img.naturalWidth > 0 && { words: document.getElementById('composer-input').value }
})()`

const SENT = `(() => {
  const last = [...document.querySelectorAll('.msg-user')].at(-1)
  const img = last?.querySelector('.msg-pic')
  const answer = [...document.querySelectorAll('.msg-agent')].at(-1)?.textContent ?? ''
  return img?.complete && img.naturalWidth > 0 && answer.includes('看到了 1 张图片') && {
    words: last.textContent, answer, draftLeft: !document.getElementById('draft-pics').hidden,
  }
})()`

const ISLAND_CHIP = `(() => {
  const img = document.querySelector('.isl-image .isl-file-thumb')
  return img?.complete && img.naturalWidth > 0
})()`

const ISLAND_SENT = `(() => {
  const last = [...document.querySelectorAll('.msg-user')].at(-1)
  return Boolean(last?.textContent.includes(${JSON.stringify(ISLAND_WORDS)}) && last.querySelector('.msg-pic'))
})()`

/** @returns {Promise<string[]>} failures */
export async function checkPictures(win: SmokeWindow, outDir: string, desk: SmokeDesk) {
  const failures: string[] = []
  await run(win, pasteInto('#composer-input', true))
  const draft = await until(win, DRAFT, 'the pasted picture shown in the input')
  if (!draft.words.includes(HTML_WORDS)) failures.push(`words copied only as HTML should be pasted too: ${JSON.stringify(draft)}`)
  await wait(UI_WAIT_MS)
  await capture(win, outDir, 'images-draft')
  await run(win, `document.getElementById('composer').requestSubmit()`)
  const sent = await until(win, SENT, 'the picture sent and seen by the agent')
  await finishTurn(win)
  await capture(win, outDir, 'images-sent')
  if (sent.draftLeft) failures.push('the input should be emptied of pictures once they are sent')

  if (desk) failures.push(...await islandPicture(win, outDir, desk))

  const usage = await run(win, 'window.agent.imagesUsage()')
  if (usage.count < 1 || usage.bytes <= 0) failures.push(`settings should count the pictures: ${JSON.stringify(usage)}`)
  // 设置 › 贴过的图片: how many and how much, and 清空 asks first.
  await run(win, `document.getElementById('open-profile').click()`)
  await run(win, `document.querySelector('.hub-nav[data-page="settings"]').click()`)
  // The section is drawn at once and counts the pictures when the main process answers: wait for the count.
  const section = await until(win, `(() => {
    const text = document.querySelector('[aria-label="贴过的图片"]')?.textContent ?? ''
    return text.includes('1 张') ? text : null
  })()`, 'the pictures counted in settings')
  await run(win, `[...document.querySelectorAll('[aria-label="贴过的图片"] button')].find((b) => b.textContent === '清空').click()`)
  const warning = await until(win, `document.querySelector('.images-confirm')?.textContent`, 'emptying asking first')
  await run(win, `document.querySelector('[aria-label="贴过的图片"]').scrollIntoView({ block: 'center' })`)
  await wait(UI_WAIT_MS)
  await capture(win, outDir, 'images-settings')
  if (!section.includes('1 张') || !warning.includes('图已清理')) failures.push(`settings should count the pictures and warn before emptying: ${JSON.stringify({ section, warning })}`)
  // Emptied after the yes: the folder is empty, and the pictures on screen say so at once.
  await run(win, `[...document.querySelectorAll('.images-confirm button')].find((b) => b.textContent === '清空').click()`)
  await until(win, `document.querySelector('[aria-label="贴过的图片"]')?.textContent.includes('0 张')`, 'the pictures emptied')
  await run(win, `document.getElementById('hub-back').click()`)
  const emptied = await run(win, 'window.agent.imagesUsage()')
  if (emptied.bytes !== 0 || emptied.count !== 0) failures.push(`emptying should leave nothing: ${JSON.stringify(emptied)}`)
  const shown = await run(win, `({ pictures: document.querySelectorAll('#thread img.msg-pic').length, gone: document.querySelectorAll('#thread .msg-pic.pic-gone').length })`)
  if (shown.pictures !== 0 || shown.gone < 1) failures.push(`pictures on screen should show as gone once emptied: ${JSON.stringify(shown)}`)
  await wait(UI_WAIT_MS)
  await capture(win, outDir, 'images-gone')
  report(`pictures: ${JSON.stringify({ draft, sent, usage, emptied })}`)
  return failures
}

async function islandPicture(win: SmokeWindow, outDir: string, desk: SmokeDesk) {
  await desk.force(true)
  try {
    if (!(await desk.openInput())) return ['the desktop island would not open its input for a picture']
    const page = { webContents: (await desk.webContents()) }
    await until(page, `document.querySelector('.isl')?.dataset.form === 'input'`, 'the island input opening')
    await run(page, pasteInto('.isl-field', false))
    await until(page, ISLAND_CHIP, 'the picture pasted on the island shown as a chip')
    await wait(UI_WAIT_MS)
    await capture(page, outDir, 'images-island')
    await run(page, `(() => {
      const field = document.querySelector('.isl-field')
      field.value = ${JSON.stringify(ISLAND_WORDS)}
      field.dispatchEvent(new Event('input', { bubbles: true }))
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })()`)
    await until(win, ISLAND_SENT, 'the picture asked on the island in the window\'s thread')
    await finishTurn(win)
    return []
  } finally {
    await desk.closeInput()
    await desk.force(false)
  }
}

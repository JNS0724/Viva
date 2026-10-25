import fs from 'node:fs/promises'
import path from 'node:path'
import { BrowserWindow, screen } from 'electron'
import { report, run, UI_WAIT_MS, until, wait, type SmokeWindow } from './smoke-kit.ts'

/**
 * The desktop island for the README (src/main/smoke-showcase.ts): asking to allow a step, and its input as after
 * ⌘⇧Space, each cut out of its window with room for its shadow, then laid side by side on a backdrop with a line
 * under each. The layout is a page of its own, so the words are in the app's fonts (the ffmpeg at hand may have
 * no text filter).
 */
const SHADOW_PX = 48
const PANEL = Object.freeze({ width: 1600, height: 330 })
const ASK = '把桌面上这份合同的要点列一下'
const CAPTIONS = Object.freeze({
  waiting: '关掉窗口后，要你确认的事直接在岛上处理',
  input: '在任何程序里按 ⌘⇧Space 提问，或者把文件拖给猫',
})

/** The island alone: the window around it is mostly clear. */
async function captureIsland(page: SmokeWindow, outDir: string, name: string) {
  const rect = await run(page, `(() => { const r = document.querySelector('.isl').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })()`)
  const pad = (n: number) => Math.max(0, Math.floor(n - SHADOW_PX))
  const x = pad(rect.x)
  const y = pad(rect.y)
  const shot = await page.webContents.capturePage({ x, y, width: Math.ceil(rect.width + rect.x - x + SHADOW_PX), height: Math.ceil(rect.height + rect.y - y + SHADOW_PX) })
  const file = path.join(outDir, `${name}.png`)
  await fs.writeFile(file, shot.toPNG())
  report(`saved ${file}`)
}

/** While a step waits for the user in the window: the island says so, with 允许 and 拒绝 on it. */
export async function deskWaiting(outDir: string, desk: any) {
  if (!desk) return
  desk.force(true)
  try {
    const page = { webContents: desk.webContents() }
    await until(page, `document.querySelector('.isl')?.dataset.form === 'waiting' && Boolean(document.querySelector('.isl .isl-btn-primary'))`, 'the desktop island asking to allow')
    await wait(UI_WAIT_MS)
    await captureIsland(page, outDir, 'desk-waiting')
  } finally {
    desk.force(false)
  }
}

/** The island's input, a question typed in. */
export async function deskInput(outDir: string, desk: any) {
  if (!desk) return
  desk.force(true)
  try {
    if (!desk.openInput()) return
    const page = { webContents: desk.webContents() }
    await until(page, `['TEXTAREA', 'INPUT'].includes(document.activeElement?.tagName)`, 'the desk input')
    await run(page, `(() => { const field = document.activeElement; field.value = ${JSON.stringify(ASK)}; field.dispatchEvent(new Event('input', { bubbles: true })) })()`)
    await wait(UI_WAIT_MS)
    await captureIsland(page, outDir, 'desk-input')
  } finally {
    desk.closeInput()
    desk.force(false)
  }
}

const dataUrl = async (file: string) => `data:image/png;base64,${(await fs.readFile(file)).toString('base64')}`

function panelPage(shots: ReadonlyArray<{ src: string, caption: string }>, scale: number) {
  const column = ({ src, caption }: { src: string, caption: string }) =>
    `<figure><div class="shot"><img src="${src}" style="zoom:${1 / scale}"></div><figcaption>${caption}</figcaption></figure>`
  return `<!doctype html><meta charset="utf-8"><style>
    html, body { margin: 0; height: 100%; }
    body { display: flex; background: linear-gradient(120deg, #0b1a33, #2a1846); font: 15px "PingFang SC", "Microsoft YaHei", sans-serif; }
    figure { flex: 1; margin: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; }
    .shot { height: 230px; width: 100%; display: flex; align-items: center; justify-content: center; }
    img { max-width: 92%; }
    figcaption { color: #93a1b8; }
  </style>${shots.map(column).join('')}`
}

/** Both islands side by side, as desk-island.png. */
export async function composeDesk(outDir: string) {
  const files = { waiting: path.join(outDir, 'desk-waiting.png'), input: path.join(outDir, 'desk-input.png') }
  const shots = [
    { src: await dataUrl(files.waiting), caption: CAPTIONS.waiting },
    { src: await dataUrl(files.input), caption: CAPTIONS.input },
  ]
  const page = new BrowserWindow({ show: false, width: PANEL.width, height: PANEL.height, useContentSize: true, frame: false })
  try {
    await page.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(panelPage(shots, screen.getPrimaryDisplay().scaleFactor))}`)
    await run(page, `Promise.all([...document.images].map((img) => img.decode())).then(() => true)`)
    await wait(UI_WAIT_MS)
    const file = path.join(outDir, 'desk-island.png')
    await fs.writeFile(file, (await page.webContents.capturePage()).toPNG())
    report(`saved ${file}`)
  } finally {
    page.destroy()
  }
}

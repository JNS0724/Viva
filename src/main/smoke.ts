import fs from 'node:fs/promises'
import path from 'node:path'
import type { BrowserWindow } from 'electron'
import { checkDeskAsk } from './smoke-desk.ts'
import { checkPictures } from './smoke-images.ts'
import { checkTopics } from './smoke-topics.ts'
import { checkPermission } from './smoke-permission.ts'
import { capture, click, finishTurn, newTopic, report, run, submit, UI_WAIT_MS, until, wait, type Expect, type SmokeHooks, type SmokeWindow } from './smoke-kit.ts'
import { checkMemory } from './smoke-memory.ts'
import { checkResume } from './smoke-tasks.ts'
import { checkSources } from './smoke-sources.ts'
import { checkFollowups } from './smoke-followups.ts'
import { runLive } from './live.ts'
import { checkTimeline } from './smoke-timeline.ts'
import { checkPerf } from './smoke-perf.ts'
import { runShowcase } from './smoke-showcase.ts'
import { checkComposition } from './smoke-composition.ts'
import { checkInputBoundaries } from './smoke-input-boundaries.ts'
import { checkMarkdownLists } from './smoke-markdown-lists.ts'
import { checkStarLayouts } from './smoke-star-layout.ts'
import { checkAnswerExpansion } from './smoke-answer-expansion.ts'

const BOOT_WAIT_MS = 1500
const DRAWER_PARK_AFTER_MS = 2200
const DRAWER_HOLD_MS = 1500
const LONG_ANSWER_WAIT_MS = 5500
const DRAWER_PARK_TOP = 120
/** The latest question may sit a little below the top (gap + padding), but must stay on screen. */
const QUESTION_TOP_RANGE = [0, 80]
/** Narrowest window the app allows; the title bar must still hold together there. */
const NARROW_SIZE: readonly [number, number] = [880, 640]
/** What the page assumes the Windows caption buttons take when env(titlebar-area-width) is unavailable. */
const SIMULATED_CONTROLS_PX = 140
const TITLEBAR_GUTTER_PX = 12
const LAYOUT_SLACK_PX = 2
const SMOKE_PROMPT = '帮我把工作区里的资料整理成一份摘要'
const SECOND_PROMPT = '第二段对话：明天的天气'
const SEARCH_TEXT = '整理成'
const LONG_PROMPT = '演示一个长任务'
const MARKDOWN_PROMPT = '格式演示'

/** Both prompts the walkthrough sends; the relaunch expects to find them again. */
const WALKTHROUGH_QUESTIONS = 2

const THREAD_METRICS = `(() => {
  const scroll = document.getElementById('scroll')
  const question = [...document.querySelectorAll('.msg-user')].pop()
  return {
    questionTop: Math.round(question.getBoundingClientRect().top - scroll.getBoundingClientRect().top),
    jumpVisible: !document.getElementById('jump-latest').hidden,
    fromBottom: Math.round(scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight),
  }
})()`

/** Past the 30 seconds after which the opened island offers the background (view/island-dom.js OFFER_MS). */
const OFFER_SHIFT_MS = 31_000
const OFFER_WAIT_MS = 5000

/**
 * D: a turn that has run a while is offered 放到后台 on the opened island. The page's clock is moved on
 * rather than waiting half a minute; the fake dsh here cannot fork, so the move itself is left to the memory
 * phase (smoke-tasks.js), which takes the background on the real dsh.
 */
async function checkOffer(win: SmokeWindow, outDir: string) {
  await run(win, `(() => {
    window.smokeNow = Date.now
    Date.now = () => window.smokeNow() + ${OFFER_SHIFT_MS}
    document.querySelector('#island .isl-head').click()
  })()`)
  const offer = await until(win, `document.querySelector('#island .isl-offer')?.textContent ?? null`, 'the offer on the opened island', OFFER_WAIT_MS)
    .catch(() => null)
  const shown = await run(win, `(() => {
    const el = document.querySelector('#island .isl')
    return { open: el?.dataset.open, time: el?.querySelector('.isl-time')?.textContent, height: el?.style.height }
  })()`)
  report(`offer: ${JSON.stringify({ offer, ...shown })}`)
  await wait(UI_WAIT_MS)
  if (offer) await capture(win, outDir, 'long-offer')
  await run(win, `(() => {
    Date.now = window.smokeNow
    document.querySelector('#island .isl-head').click()
  })()`)
  return offer?.includes('放到后台') ? [] : [`a turn past 30 seconds should be offered the background on the opened island: ${offer}`]
}

/** Long run: the reader parks the trace mid-way, then a long answer streams in. Returns failed expectations. */
async function checkLongTask(win: BrowserWindow, outDir: string) {
  const size = win.getSize()
  // A tall desktop hides anchoring regressions because the preceding turn does not need to scroll.
  // Exercise the short CI/laptop viewport on every machine, without changing the 0–80px expectation.
  win.setSize(Math.min(size[0], 921), Math.min(size[1], 648))
  try {
    await wait(UI_WAIT_MS)
    return await longTaskAtCurrentSize(win, outDir)
  } finally {
    win.setSize(size[0], size[1])
    await wait(UI_WAIT_MS)
  }
}

async function longTaskAtCurrentSize(win: SmokeWindow, outDir: string) {
  const failures: string[] = []
  await click(win, 'toggle-drawer')
  await submit(win, LONG_PROMPT)
  await wait(DRAWER_PARK_AFTER_MS)
  const parked = await run(win, `(() => {
    const body = document.querySelector('.drawer-body')
    body.scrollTop = ${DRAWER_PARK_TOP}
    return { top: body.scrollTop, overflow: body.scrollHeight - body.clientHeight }
  })()`)
  await wait(DRAWER_HOLD_MS)
  const drawerTop = await run(win, `document.querySelector('.drawer-body').scrollTop`)
  report(`drawer: parked at ${parked.top} (overflow ${parked.overflow}px), after new steps at ${drawerTop}`)
  if (parked.overflow <= DRAWER_PARK_TOP) failures.push('drawer did not overflow; scroll check is inconclusive')
  else if (Math.abs(drawerTop - parked.top) > 1) failures.push(`drawer jumped from ${parked.top} to ${drawerTop}`)
  await capture(win, outDir, 'long-drawer')
  failures.push(...await checkOffer(win, outDir))

  await wait(LONG_ANSWER_WAIT_MS)
  const during = await run(win, THREAD_METRICS)
  report(`thread during long answer: ${JSON.stringify(during)}`)
  if (during.questionTop < QUESTION_TOP_RANGE[0] || during.questionTop > QUESTION_TOP_RANGE[1]) {
    failures.push(`question should stay near the top, was at ${during.questionTop}px`)
  }
  if (!during.jumpVisible) failures.push('jump-to-latest button should be visible')
  await capture(win, outDir, 'long-answer')

  await click(win, 'jump-latest')
  await wait(UI_WAIT_MS)
  const after = await run(win, THREAD_METRICS)
  report(`thread after jump: ${JSON.stringify(after)}`)
  if (after.fromBottom > 2 || after.jumpVisible) failures.push('jump-to-latest should land on the bottom and hide itself')
  return failures
}

const TITLEBAR_METRICS = `(() => {
  const rect = (selector) => document.querySelector(selector).getBoundingClientRect()
  const island = rect('#island .isl')
  const actions = rect('.titlebar-right')
  // On real Windows the system reports where its caption buttons start; elsewhere they are only simulated.
  const overlay = navigator.windowControlsOverlay
  const area = overlay?.visible ? overlay.getTitlebarAreaRect() : null
  return {
    width: window.innerWidth,
    controlsLeft: area ? Math.round(area.x + area.width) : null,
    islandCenter: Math.round((island.left + island.right) / 2),
    islandRight: Math.round(island.right),
    actionsLeft: Math.round(actions.left),
    actionsRight: Math.round(actions.right),
    drawerPosition: getComputedStyle(document.getElementById('drawer')).position,
  }
})()`

/** Title bar on one platform at the current window size: island centred, clear of the buttons, buttons clear of the system's. */
async function checkTitlebarOn(win: SmokeWindow, platform: string) {
  await run(win, `document.documentElement.dataset.platform = ${JSON.stringify(platform)}`)
  await wait(UI_WAIT_MS)
  const m = await run(win, TITLEBAR_METRICS)
  const reserve = platform === 'darwin' ? 0 : m.width - (m.controlsLeft ?? m.width - SIMULATED_CONTROLS_PX)
  const failures: string[] = []
  const label = `${platform}${platform !== 'darwin' && m.controlsLeft === null ? ' (simulated)' : ''} @ ${m.width}px`
  if (Math.abs(m.islandCenter - m.width / 2) > LAYOUT_SLACK_PX) failures.push(`${label}: island is off centre (${JSON.stringify(m)})`)
  if (m.islandRight > m.actionsLeft - 8) failures.push(`${label}: island overlaps the buttons (${JSON.stringify(m)})`)
  if (Math.abs(m.actionsRight - (m.width - reserve - TITLEBAR_GUTTER_PX)) > LAYOUT_SLACK_PX) failures.push(`${label}: buttons are not beside the system controls (${JSON.stringify(m)})`)
  report(`titlebar ${label}: ${JSON.stringify(m)}`)
  return failures
}

/** Both platforms (Windows simulated) at full and narrowest width, plus the floating drawer when narrow. */
async function checkLayouts(win: BrowserWindow, outDir: string) {
  const realPlatform = await run(win, 'document.documentElement.dataset.platform')
  const [width, height] = win.getSize()
  const failures: string[] = []
  for (const size of [[width, height] as const, NARROW_SIZE]) {
    win.setSize(...size)
    for (const platform of ['darwin', 'win32']) {
      failures.push(...await checkTitlebarOn(win, platform))
      await capture(win, outDir, `layout-${platform}-${size[0]}`)
    }
  }
  await click(win, 'toggle-drawer')
  await wait(UI_WAIT_MS)
  const narrow = await run(win, TITLEBAR_METRICS)
  if (narrow.drawerPosition !== 'absolute') failures.push(`narrow window: the open drawer should float over the conversation, was ${narrow.drawerPosition}`)
  await capture(win, outDir, 'layout-narrow-drawer')
  await click(win, 'toggle-drawer')
  await run(win, `document.documentElement.dataset.platform = ${JSON.stringify(realPlatform)}`)
  win.setSize(width, height)
  await wait(UI_WAIT_MS)
  return failures
}

/** No key yet: the home page guides to the settings panel and the composer is disabled. */
async function checkSetup(win: SmokeWindow, outDir: string) {
  const seen = await run(win, `(() => ({
    title: document.querySelector('.setup-title')?.textContent ?? '',
    composerDisabled: document.getElementById('composer-input').disabled,
    sendDisabled: document.getElementById('send-btn').disabled,
    titlebarLeft: document.getElementById('titlebar-left').textContent,
  }))()`)
  report(`setup: ${JSON.stringify(seen)}`)
  await capture(win, outDir, 'setup')
  const failures: string[] = []
  if (seen.title !== '连接模型') failures.push(`setup card missing: ${JSON.stringify(seen)}`)
  if (!seen.composerDisabled || !seen.sendDisabled) failures.push('composer should be disabled without a key')
  if (seen.titlebarLeft !== '') failures.push(`title bar left should be empty, was "${seen.titlebarLeft}"`)
  await run(win, `document.querySelector('.setup-action').click()`)
  await wait(UI_WAIT_MS)
  const settingsOpen = await run(win, `document.getElementById('hub').dataset.open === 'true' && Boolean(document.querySelector('#settings-root .settings'))`)
  if (!settingsOpen) failures.push('the setup button should open the 设置 page')
  await capture(win, outDir, 'setup-settings')
  return failures
}

/** Second launch on the same profile: last launch's conversation is back, at the bottom, and the agent resumed it. */
async function checkRelaunch(win: SmokeWindow, outDir: string) {
  const restored = await run(win, `(() => {
    const scroll = document.getElementById('scroll')
    return {
      questions: document.querySelectorAll('.msg-user').length,
      divider: document.querySelector('.history-divider')?.textContent ?? '',
      lastAnswer: [...document.querySelectorAll('.msg-agent .msg-text')].pop()?.textContent.slice(0, 12) ?? '',
      fromBottom: Math.round(scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight),
    }
  })()`)
  report(`relaunch: ${JSON.stringify(restored)}`)
  await capture(win, outDir, 'relaunch')
  const failures: string[] = []
  if (restored.questions !== WALKTHROUGH_QUESTIONS) failures.push(`expected ${WALKTHROUGH_QUESTIONS} restored questions, found ${restored.questions}`)
  if (!restored.divider.includes('助手记得')) failures.push(`divider should say the agent remembers, was "${restored.divider}"`)
  if (!restored.lastAnswer.startsWith('长任务演示完成')) failures.push('the last restored answer should be the long task summary')
  if (restored.fromBottom > 2) failures.push(`restored thread should open at the bottom, was ${restored.fromBottom}px away`)
  return failures
}

/** Clicked, the title bar's island unfolds its steps over the conversation, not under it. */
async function checkIslandOnTop(win: SmokeWindow, outDir: string) {
  await run(win, `document.querySelector('#island .isl-head').click()`)
  await wait(UI_WAIT_MS)
  const seen = await run(win, `(() => {
    const island = document.querySelector('#island .isl')
    const steps = island?.querySelector('.isl-steps')
    if (!steps) return { open: false, form: island?.dataset.form ?? null }
    const box = steps.getBoundingClientRect()
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
    return { open: island.dataset.open === 'true', onTop: island.contains(hit), rows: steps.children.length, hit: hit?.className ?? '' }
  })()`)
  await capture(win, outDir, 'island-panel')
  await run(win, 'document.body.click()')
  await wait(UI_WAIT_MS)
  return seen.open && seen.onTop && seen.rows > 0 ? [] : [`the island's steps should unfold on top of the thread: ${JSON.stringify(seen)}`]
}

const DESK_ISLAND_STATE = `(() => {
  const island = document.querySelector('.isl')
  return island && { form: island.dataset.form, title: island.querySelector('.isl-title')?.textContent ?? '', allow: Boolean(island.querySelector('.isl-btn-primary')), command: island.querySelector('.isl-detail')?.textContent ?? '' }
})()`

/**
 * With the window away, the desktop island shows what waits on the user, and allowing it there goes
 * through to the window: the card in the thread goes and the turn carries on.
 */
async function checkDeskIsland(win: SmokeWindow, outDir: string, desk: any) {
  if (!desk) return ['the desktop island was not created']
  desk.force(true)
  try {
    // The smoke helpers drive a window through its webContents.
    const contents = desk.webContents()
    if (!contents) return ['the desktop island did not open']
    const page = { webContents: contents }
    const logged: string[] = []
    contents.on('console-message', (event: { level: string, message: string }) => logged.push(`${event.level}: ${event.message}`))
    const seen = await until(page, `(() => { const s = ${DESK_ISLAND_STATE}; return s?.form === 'waiting' && s.allow && s })()`, 'the desktop island asking to allow')
      .catch(async (err) => {
        throw new Error(`${err.message}; it showed ${JSON.stringify(await run(page, DESK_ISLAND_STATE))}, logged ${JSON.stringify(logged)}`)
      })
    report(`desktop island: ${JSON.stringify(seen)}`)
    await wait(UI_WAIT_MS)
    await capture(page, outDir, 'desk-island')
    await run(page, `document.querySelector('.isl .isl-btn-primary').click()`)
    await until(win, `!document.querySelector('.confirm:not(.ask)')`, 'the card going after allowing on the desktop island')
    return seen.title === '写入 summary.md' ? [] : [`the desktop island should name what it asks to allow: ${JSON.stringify(seen)}`]
  } finally {
    desk.force(false)
  }
}

/**
 * Tour from a clean profile on the fake dsh: an answer waiting on a permission card, the layouts around it,
 * allowing it from the desktop island, the island's steps, the long task.
 */
async function walkthrough(win: BrowserWindow, outDir: string, hooks: SmokeHooks) {
  await capture(win, outDir, 'home')
  await submit(win, SMOKE_PROMPT)
  await until(win, `Boolean(document.querySelector('.confirm .btn-primary'))`, 'the permission card')
  await capture(win, outDir, 'chat')
  const failures = [...await checkLayouts(win, outDir), ...await checkDeskIsland(win, outDir, hooks.desk?.())]
  await finishTurn(win)
  failures.push(...await checkIslandOnTop(win, outDir))
  failures.push(...await checkLongTask(win, outDir))
  await finishTurn(win)
  failures.push(...await checkFiles(win, outDir, hooks.cwd))
  failures.push(...await checkPickers(win, outDir))
  return failures
}

/**
 * The model's button and the folder's chip open their menus from anywhere on them, not only the chevron:
 * the name is clicked here, which the re-render takes out of the page as the menu opens.
 */
async function checkPickers(win: SmokeWindow, outDir: string) {
  const failures: string[] = []
  await run(win, `document.querySelector('#model-btn .model-btn-name').click()`)
  await wait(UI_WAIT_MS)
  const model = await run(win, `Boolean(document.querySelector('#model-menu .model-menu'))`)
  if (!model) failures.push("a click on the model's name should open its menu")
  else await capture(win, outDir, 'picker-model')
  await run(win, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  await run(win, `document.querySelector('#composer-context .workdir-name').click()`)
  await wait(UI_WAIT_MS)
  const folder = await run(win, `Boolean(document.querySelector('#workdir-menu .workdir-menu'))`)
  if (!folder) failures.push("a click on the folder's name should open its menu")
  else await capture(win, outDir, 'picker-folder')
  await run(win, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  return failures
}

const FILES_STATE = `(() => ({
  rows: [...document.querySelectorAll('.file-row .file-name')].map((el) => el.textContent),
  doc: document.querySelector('.file-doc')?.textContent ?? '',
  heading: document.querySelector('.file-doc h1, .file-doc h2, .file-doc h3')?.textContent ?? '',
  buttons: [...document.querySelectorAll('.file-actions button')].map((el) => el.textContent),
  error: document.querySelector('.files .form-error')?.textContent ?? '',
}))()`

const clickRow = (name: string) => `[...document.querySelectorAll('.file-row')].find((el) => el.querySelector('.file-name')?.textContent === ${JSON.stringify(name)})?.click()`

/** The 文件 tab lists the workspace, opens a folder, shows a Markdown file laid out, and never offers to run a script. */
async function checkFiles(win: SmokeWindow, outDir: string, cwd: string) {
  if (!cwd) return ['the smoke run did not get the workspace path']
  await fs.mkdir(path.join(cwd, 'notes'), { recursive: true })
  await fs.mkdir(path.join(cwd, 'tools'), { recursive: true })
  await fs.writeFile(path.join(cwd, 'notes', '周报.md'), '# 周报\n\n- 完成对账\n')
  await fs.writeFile(path.join(cwd, 'tools', 'run.sh'), 'echo hi\n')
  await fs.writeFile(path.join(cwd, 'notes', 'app.ts'), 'const answer: number = 42\n')
  await fs.writeFile(path.join(cwd, 'notes', '账目.csv'), '日期,金额\n10-20,"1,200"\n')
  await fs.writeFile(path.join(cwd, 'notes', '损坏图片.md'), '# 正文仍可读\n\n![坏地址](%ZZ.png)\n\nQA-BROKEN-IMAGE-END\n')
  const failures: string[] = []
  const expect: Expect = (ok, message, seen) => { if (!ok) failures.push(`${message}: ${JSON.stringify(seen)}`) }
  // The long task left the drawer open; open it only if it is not.
  await run(win, `document.getElementById('drawer').dataset.open === 'true' || document.getElementById('toggle-drawer').click()`)
  await run(win, `[...document.querySelectorAll('.drawer .tab')].find((el) => el.textContent === '文件').click()`)
  await until(win, `[...document.querySelectorAll('.file-row .file-name')].some((el) => el.textContent === 'notes')`, 'the workspace tree')
  await run(win, clickRow('notes'))
  await until(win, `[...document.querySelectorAll('.file-row .file-name')].some((el) => el.textContent === '周报.md')`, 'the notes folder opening')
  await run(win, clickRow('周报.md'))
  const shown = await until(win, `(() => { const s = ${FILES_STATE}; return s.heading && s })()`, 'the Markdown preview')
  report(`files: ${JSON.stringify(shown)}`)
  expect(shown.heading === '周报' && shown.doc.includes('完成对账') && !shown.doc.includes('#'), 'Markdown should be laid out, not shown as source', shown)
  expect(shown.buttons.length === 2 && shown.buttons.includes('打开'), 'a document offers reveal and open', shown)
  await capture(win, outDir, 'files')
  await run(win, clickRow('app.ts'))
  const code = await until(win, `document.querySelectorAll('.file-code .hljs-keyword').length`, 'the highlighted code')
  expect(code > 0, 'code should be highlighted', code)
  await capture(win, outDir, 'files-code')
  await run(win, clickRow('账目.csv'))
  const cells = await until(win, `(() => { const cells = [...document.querySelectorAll('.file-table td')].map((el) => el.textContent); return cells.length && cells })()`, 'the CSV table')
  expect(cells.join('|') === '日期|金额|10-20|1,200', 'a CSV file should show as a table, quoted commas kept', cells)
  await capture(win, outDir, 'files-table')

  await run(win, clickRow('损坏图片.md'))
  const brokenImage = await until(win, `document.querySelector('.file-doc')?.textContent.includes('QA-BROKEN-IMAGE-END')`, 'a malformed image address leaves the rest of Markdown readable')
  expect(brokenImage, 'a malformed local image address should degrade to text without breaking preview', brokenImage)
  await capture(win, outDir, 'files-broken-image')
  await run(win, clickRow('账目.csv'))
  await until(win, `document.querySelector('.file-table')`, 'back to the CSV preview')
  await run(win, `document.querySelector('.open-more').click()`)
  await until(win, `Boolean(document.querySelector('.open-menu .open-reveal'))`, 'the open menu')
  // The system lists the apps that open the file; the first time it reads their icons too. A machine with none still shows the menu.
  await until(win, `document.querySelectorAll('.open-menu .open-item:not(.open-pending)').length > 1`, 'the apps for the file', 5_000).catch(() => {})
  await capture(win, outDir, 'files-open-menu')
  await run(win, `document.body.click()`)
  await run(win, clickRow('tools'))
  await until(win, `[...document.querySelectorAll('.file-row .file-name')].some((el) => el.textContent === 'run.sh')`, 'the tools folder opening')
  await run(win, clickRow('run.sh'))
  const script = await until(win, `(() => { const s = ${FILES_STATE}; return document.querySelector('.file-text') && s })()`, 'the script preview')
  expect(!script.buttons.includes('打开') && script.buttons.length === 1, 'a script is only shown in its folder, never opened', script)
  await run(win, `document.querySelector('.drawer [aria-label="收起抽屉"]').click()`)
  return failures
}

/** What the window made of the fake dsh's Markdown answer (test/fixtures/fake-dsh.js MARKDOWN_ANSWER). */
const MARKDOWN_STATE = `(() => {
  const md = [...document.querySelectorAll('.msg-agent .markdown')].at(-1)
  if (!md) return null
  const text = (selector) => md.querySelector(selector)?.textContent ?? null
  return {
    heading: text('h3'), strong: text('strong'), del: text('del'), code: text('.md-code-inline'),
    link: md.querySelector('a.md-link')?.getAttribute('href') ?? null, links: md.querySelectorAll('a').length,
    tasks: [...md.querySelectorAll('.md-task input')].map((input) => input.checked), nested: md.querySelectorAll('ul ol li').length,
    headers: [...md.querySelectorAll('th')].map((th) => th.textContent), right: text('td.md-align-right'),
    block: text('pre.md-code code'), lang: text('.md-code-lang'), quote: Boolean(md.querySelector('blockquote')), hr: Boolean(md.querySelector('hr')),
    loaded: md.querySelectorAll('script, img, iframe').length, hacked: window.hacked === true,
    stars: md.textContent.includes('**'), shownAsText: md.textContent.includes('<script>window.hacked = true</script>'),
  }
})()`

/** Markdown in an answer becomes real headings, lists, tables and code; nothing in it runs, loads or navigates. */
async function checkMarkdown(win: SmokeWindow, outDir: string) {
  const failures: string[] = await checkMarkdownLists(win)
  await checkAnswerExpansion(win, (ok, message, seen) => {
    if (!ok) failures.push(`answer expansion: ${message}: ${JSON.stringify(seen)}`)
  })
  await newTopic(win)
  await wait(UI_WAIT_MS)
  await submit(win, MARKDOWN_PROMPT)
  await finishTurn(win)
  await wait(UI_WAIT_MS)
  const seen = await run(win, MARKDOWN_STATE)
  const expected = {
    heading: '本周进展', strong: '按计划推进', del: '周三上线', code: 'recon_service', link: 'https://example.com/spec', links: 2,
    tasks: [true, false], nested: 2, headers: ['模块', '负责人', '进度'], right: '80%',
    block: 'def settle(day):\n    return [t for t in trades(day) if t.ok]', lang: 'python', quote: true, hr: true,
    loaded: 0, hacked: false, stars: false, shownAsText: true,
  }
  for (const [key, value] of Object.entries(expected)) {
    if (JSON.stringify(seen?.[key]) !== JSON.stringify(value)) failures.push(`markdown ${key}: expected ${JSON.stringify(value)}, saw ${JSON.stringify(seen?.[key])}`)
  }
  await run(win, `[...document.querySelectorAll('.markdown')].at(-1).scrollIntoView({ block: 'start' })`)
  await capture(win, outDir, 'markdown')
  // Neither a page script nor a link may take the window away from the app or open another one.
  const before = await run(win, 'location.href')
  await run(win, `window.location.assign('https://example.com/'); window.__opened = window.open('https://example.com/') !== null`)
  await wait(UI_WAIT_MS)
  const after = await run(win, '({ href: location.href, opened: window.__opened })')
  if (after.href !== before || after.opened) failures.push(`the window should stay on the app: ${JSON.stringify(after)}`)
  return failures
}

const PANEL_STATE = `(() => ({
  open: document.getElementById('hub').dataset.open === 'true' && !document.querySelector('.hub-search').hidden,
  titles: [...document.querySelectorAll('.history-title')].map((el) => el.textContent),
  marks: [...document.querySelectorAll('.history-snippet mark')].map((el) => el.textContent),
  contexts: [...document.querySelectorAll('.hit-context')].map((el) => el.textContent),
  list: document.getElementById('history-list').textContent,
}))()`

/** The hub covers what is under the title bar only: the island in the middle of it is still what a click there hits. */
const ISLAND_REACHABLE = `(() => {
  const box = document.getElementById('island').getBoundingClientRect()
  const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
  return Boolean(box.width && hit?.closest('#island'))
})()`

const typeSearch = (text: string) => `(() => {
  const input = (document.getElementById('history-search-frame')?.contentDocument?.getElementById('history-search') ?? document.getElementById('history-search'))
  input.value = ${JSON.stringify(text)}
  input.dispatchEvent(new Event('input'))
})()`

/** ⌘K, a new topic with the first kept above it, ⌘F and a jump to a hit. */
async function checkHistoryPanel(win: SmokeWindow, outDir: string) {
  const failures: string[] = []
  try {
    await historyPanelSteps(win, outDir, failures)
  } catch (err) {
    failures.push(`history panel: ${err instanceof Error ? err.message : String(err)}`)
  }
  return failures
}

async function historyPanelSteps(win: SmokeWindow, outDir: string, failures: string[]) {
  const expect: Expect = (ok, message, seen) => { if (!ok) failures.push(`${message}: ${JSON.stringify(seen)}`) }
  const panel = () => run(win, PANEL_STATE)

  // Nothing typed, the page is 回顾: the topics by day (view/review.ts), not search hits.
  await run(win, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }))`)
  await wait(UI_WAIT_MS)
  let seen = await panel()
  expect(seen.open && seen.titles.length === 0 && seen.list.includes('今天') && seen.list.includes('全部'), '⌘K should open 回顾 with the topics by day, no hits', seen)

  await run(win, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  await wait(UI_WAIT_MS)
  expect(!(await panel()).open, 'Esc should close the 搜索 page', null)
  expect(!await run(win, `Boolean(document.getElementById('new-session'))`), 'there should be no 新对话 button; ⌘N starts a new topic', null)
  await newTopic(win)
  await finishTurn(win)
  await submit(win, SECOND_PROMPT)
  await finishTurn(win)
  // One timeline: what was said before the new session stays above it, under its day (folded, it is named by its
  // first question; its messages are drawn when it is opened).
  const timeline = await run(win, `({
    earlier: [...document.querySelectorAll('#earlier .msg-user, #earlier .topic-title')].map((el) => el.textContent),
    days: [...document.querySelectorAll('#earlier .timeline-day')].map((el) => el.textContent),
    shown: !document.getElementById('earlier').hidden,
  })`)
  expect(timeline.shown && timeline.earlier.includes(SMOKE_PROMPT) && timeline.days.includes('今天'),
    'the conversation before the new session should stay above it in the timeline', timeline)

  // ⌘F searches what was said; a hit scrolls the timeline to that message and marks it.
  await run(win, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', metaKey: true, bubbles: true }))`)
  const focused = await run(win, `(document.getElementById('history-search-frame')?.contentDocument?.activeElement?.id || document.activeElement?.id) ?? ""`)
  expect(focused === 'history-search', '⌘F should put the cursor in the search field', focused)
  await run(win, typeSearch(SEARCH_TEXT))
  await wait(UI_WAIT_MS)
  seen = await panel()
  expect(seen.open && seen.titles.includes('你') && seen.marks.includes(SEARCH_TEXT), '⌘F should find the message and highlight the words', seen)
  expect(seen.contexts.length > 0, 'a hit should show what was said next to it', seen)
  expect(await run(win, ISLAND_REACHABLE), 'the island should stay in reach over the 搜索 page', null)
  await capture(win, outDir, 'history-search')

  await run(win, `[...document.querySelectorAll('.search-hit')].find((el) => el.querySelector('.history-title').textContent === '你').querySelector('.hit-open').click()`)
  await wait(UI_WAIT_MS)
  const found = await run(win, `(() => {
    const el = document.querySelector('.msg-found')
    const box = el?.getBoundingClientRect()
    const view = document.getElementById('scroll').getBoundingClientRect()
    return {
      text: el?.textContent ?? '', inEarlier: Boolean(el?.closest('#earlier')),
      inView: Boolean(box && box.top >= view.top && box.bottom <= view.bottom),
      panelOpen: document.getElementById('hub').dataset.open,
    }
  })()`)
  expect(found.text.includes(SMOKE_PROMPT) && found.inEarlier && found.inView && found.panelOpen === 'false',
    '详情 should close the page, scroll the earlier message into view and mark it', found)
  await capture(win, outDir, 'search-jump')
  expect(!seen.list.includes('null'), 'the list should not print "null"', seen.list)
  await run(win, typeSearch(''))
}

/**
 * Drives the real UI (on the fake dsh, with no key for `setup`, or on the real dsh and a fake model for
 * `memory`) and screenshots each step into `smokeOut`.
 * Fails on any console warning/error or any broken scroll / history expectation.
 */
export async function runSmoke(win: BrowserWindow, { smokeOut: outDir, smokePhase }: { smokeOut: string, smokePhase: string | null }, quit: (code: number) => void, hooks: SmokeHooks = {}) {
  const problems: string[] = []
  win.webContents.on('console-message', (event: { level: string, message: string }) => {
    if (event.level === 'warning' || event.level === 'error') problems.push(`${event.level}: ${event.message}`)
  })
  try {
    await fs.mkdir(outDir, { recursive: true })
    await wait(BOOT_WAIT_MS)
    if (smokePhase === 'setup') {
      problems.push(...await checkSetup(win, outDir))
      // On the settings page checkSetup leaves open.
      problems.push(...await checkSources(win, outDir, { userData: hooks.userData, fixtures: hooks.fixtures, pick: hooks.pickSourceFolder }))
    }
    else if (smokePhase === 'relaunch') {
      problems.push(...await checkRelaunch(win, outDir), ...await checkHistoryPanel(win, outDir), ...await checkMarkdown(win, outDir), ...await checkStarLayouts(win, outDir))
      // Last on this profile: they add questions to the conversation the checks above look at.
      problems.push(...await checkDeskAsk(win, outDir, hooks.desk?.()))
      problems.push(...await checkPictures(win, outDir, hooks.desk?.()))
      problems.push(...await checkTopics(win, outDir))
      problems.push(...await checkPermission(win, outDir))
      problems.push(...await checkComposition(win))
      problems.push(...await checkInputBoundaries(win))
    }
    else if (smokePhase === 'showcase') problems.push(...await runShowcase(win, outDir, hooks))
    else if (smokePhase === 'memory') problems.push(...await checkMemory(win, outDir, hooks), ...await checkFollowups(win, outDir, hooks))
    else if (smokePhase === 'resume') problems.push(...await checkResume(win, outDir))
    else if (smokePhase === 'live' || smokePhase === 'live-resume') problems.push(...await runLive(win, outDir, smokePhase, hooks))
    else if (smokePhase === 'timeline') problems.push(...await checkTimeline(win, outDir))
    else if (smokePhase === 'perf') problems.push(...await checkPerf(win, outDir))
    else problems.push(...await walkthrough(win, outDir, hooks))
  } catch (err) {
    problems.push(`smoke: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    report(problems.length ? `problems:\n${problems.join('\n')}` : `${smokePhase}: no console warnings or errors; checks passed`)
    quit(problems.length ? 1 : 0)
  }
}

import fs from 'node:fs/promises'
import { capture, click, finishTurn, report, run, submit, UI_WAIT_MS, until, wait } from './smoke-kit.js'
import { checkMemory } from './smoke-memory.js'

const BOOT_WAIT_MS = 1500
const DRAWER_PARK_AFTER_MS = 2200
const DRAWER_HOLD_MS = 1500
const LONG_ANSWER_WAIT_MS = 5500
const DRAWER_PARK_TOP = 120
/** The latest question may sit a little below the top (gap + padding), but must stay on screen. */
const QUESTION_TOP_RANGE = [0, 80]
/** Narrowest window the app allows; the title bar must still hold together there. */
const NARROW_SIZE = [880, 640]
/** What the page assumes the Windows caption buttons take when env(titlebar-area-width) is unavailable. */
const SIMULATED_CONTROLS_PX = 140
const TITLEBAR_GUTTER_PX = 12
const LAYOUT_SLACK_PX = 2
const SMOKE_PROMPT = '帮我把工作区里的资料整理成一份摘要'
const SECOND_PROMPT = '第二段对话：明天的天气'
const RENAMED_TITLE = '周报摘要'
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

/** Long run: the reader parks the trace mid-way, then a long answer streams in. Returns failed expectations. */
async function checkLongTask(win, outDir) {
  const failures = []
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
async function checkTitlebarOn(win, platform) {
  await run(win, `document.documentElement.dataset.platform = ${JSON.stringify(platform)}`)
  await wait(UI_WAIT_MS)
  const m = await run(win, TITLEBAR_METRICS)
  const reserve = platform === 'darwin' ? 0 : m.width - (m.controlsLeft ?? m.width - SIMULATED_CONTROLS_PX)
  const failures = []
  const label = `${platform}${platform !== 'darwin' && m.controlsLeft === null ? ' (simulated)' : ''} @ ${m.width}px`
  if (Math.abs(m.islandCenter - m.width / 2) > LAYOUT_SLACK_PX) failures.push(`${label}: island is off centre (${JSON.stringify(m)})`)
  if (m.islandRight > m.actionsLeft - 8) failures.push(`${label}: island overlaps the buttons (${JSON.stringify(m)})`)
  if (Math.abs(m.actionsRight - (m.width - reserve - TITLEBAR_GUTTER_PX)) > LAYOUT_SLACK_PX) failures.push(`${label}: buttons are not beside the system controls (${JSON.stringify(m)})`)
  report(`titlebar ${label}: ${JSON.stringify(m)}`)
  return failures
}

/** Both platforms (Windows simulated) at full and narrowest width, plus the floating drawer when narrow. */
async function checkLayouts(win, outDir) {
  const realPlatform = await run(win, 'document.documentElement.dataset.platform')
  const [width, height] = win.getSize()
  const failures = []
  for (const size of [[width, height], NARROW_SIZE]) {
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
async function checkSetup(win, outDir) {
  const seen = await run(win, `(() => ({
    title: document.querySelector('.setup-title')?.textContent ?? '',
    composerDisabled: document.getElementById('composer-input').disabled,
    sendDisabled: document.getElementById('send-btn').disabled,
    titlebarLeft: document.getElementById('titlebar-left').textContent,
  }))()`)
  report(`setup: ${JSON.stringify(seen)}`)
  await capture(win, outDir, 'setup')
  const failures = []
  if (seen.title !== '连接模型') failures.push(`setup card missing: ${JSON.stringify(seen)}`)
  if (!seen.composerDisabled || !seen.sendDisabled) failures.push('composer should be disabled without a key')
  if (seen.titlebarLeft !== '') failures.push(`title bar left should be empty, was "${seen.titlebarLeft}"`)
  await run(win, `document.querySelector('.setup-action').click()`)
  await wait(UI_WAIT_MS)
  const settingsOpen = await run(win, `Boolean(document.querySelector('#settings-root .settings'))`)
  if (!settingsOpen) failures.push('the setup button should open the settings panel')
  await capture(win, outDir, 'setup-settings')
  return failures
}

/** Second launch on the same profile: last launch's conversation is back, at the bottom, and the agent resumed it. */
async function checkRelaunch(win, outDir) {
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
  const failures = []
  if (restored.questions !== WALKTHROUGH_QUESTIONS) failures.push(`expected ${WALKTHROUGH_QUESTIONS} restored questions, found ${restored.questions}`)
  if (!restored.divider.includes('助手记得')) failures.push(`divider should say the agent remembers, was "${restored.divider}"`)
  if (!restored.lastAnswer.startsWith('长任务演示完成')) failures.push('the last restored answer should be the long task summary')
  if (restored.fromBottom > 2) failures.push(`restored thread should open at the bottom, was ${restored.fromBottom}px away`)
  return failures
}

/** Clicked, the title bar's island unfolds its steps over the conversation, not under it. */
async function checkIslandOnTop(win, outDir) {
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
  return island && { form: island.dataset.form, title: island.querySelector('.isl-title')?.textContent ?? '', allow: Boolean(island.querySelector('.isl-btn-hot')) }
})()`

/**
 * With the window away, the desktop island shows what waits on the user, and allowing it there goes
 * through to the window: the card in the thread goes and the turn carries on.
 */
async function checkDeskIsland(win, outDir, desk) {
  if (!desk) return ['the desktop island was not created']
  desk.force(true)
  try {
    // The smoke helpers drive a window through its webContents.
    const contents = desk.webContents()
    if (!contents) return ['the desktop island did not open']
    const page = { webContents: contents }
    const logged = []
    contents.on('console-message', (event) => logged.push(`${event.level}: ${event.message}`))
    const seen = await until(page, `(() => { const s = ${DESK_ISLAND_STATE}; return s?.form === 'waiting' && s.allow && s })()`, 'the desktop island asking to allow')
      .catch(async (err) => {
        throw new Error(`${err.message}; it showed ${JSON.stringify(await run(page, DESK_ISLAND_STATE))}, logged ${JSON.stringify(logged)}`)
      })
    report(`desktop island: ${JSON.stringify(seen)}`)
    await wait(UI_WAIT_MS)
    await capture(page, outDir, 'desk-island')
    await run(page, `document.querySelector('.isl .isl-btn-hot').click()`)
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
async function walkthrough(win, outDir, hooks) {
  await capture(win, outDir, 'home')
  await submit(win, SMOKE_PROMPT)
  await until(win, `Boolean(document.querySelector('.confirm .btn-ink'))`, 'the permission card')
  await capture(win, outDir, 'chat')
  const failures = [...await checkLayouts(win, outDir), ...await checkDeskIsland(win, outDir, hooks.desk?.())]
  await finishTurn(win)
  failures.push(...await checkIslandOnTop(win, outDir))
  failures.push(...await checkLongTask(win, outDir))
  await finishTurn(win)
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
async function checkMarkdown(win, outDir) {
  const failures = []
  await click(win, 'new-session')
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
  open: document.getElementById('history-panel').dataset.open === 'true',
  titles: [...document.querySelectorAll('.history-title')].map((el) => el.textContent),
  active: document.querySelector('.history-item[data-active="true"] .history-title')?.textContent ?? '',
  marks: [...document.querySelectorAll('.history-snippet mark')].map((el) => el.textContent),
  toast: document.querySelector('.toast')?.textContent ?? '',
}))()`

/** Opens an item's ⋯ menu and picks an entry; the list re-renders in between, so each step queries afresh. */
const itemAction = (title, action) => `(() => {
  const item = () => {
    const found = [...document.querySelectorAll('.history-item')]
      .find((el) => el.querySelector('.history-title')?.textContent === ${JSON.stringify(title)})
    if (!found) throw new Error('no history item titled ' + ${JSON.stringify(title)} + '; list: ' + document.getElementById('history-list').textContent)
    return found
  }
  item().querySelector('.history-more').click()
  ;[...item().querySelectorAll('.history-menu-item')].find((el) => el.textContent === ${JSON.stringify(action)}).click()
})()`

const typeSearch = (text) => `(() => {
  const input = document.getElementById('history-search')
  input.value = ${JSON.stringify(text)}
  input.dispatchEvent(new Event('input'))
})()`

/** ⌘K, a second conversation, search, reopening the first one, rename, delete and undo. */
async function checkHistoryPanel(win, outDir) {
  const failures = []
  try {
    await historyPanelSteps(win, outDir, failures)
  } catch (err) {
    failures.push(`history panel: ${err instanceof Error ? err.message : String(err)}`)
  }
  return failures
}

async function historyPanelSteps(win, outDir, failures) {
  const expect = (ok, message, seen) => { if (!ok) failures.push(`${message}: ${JSON.stringify(seen)}`) }
  const panel = () => run(win, PANEL_STATE)
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

  await run(win, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }))`)
  await wait(UI_WAIT_MS)
  let seen = await panel()
  expect(seen.open && same(seen.titles, [SMOKE_PROMPT]) && seen.active === SMOKE_PROMPT, '⌘K should open the panel on the restored conversation', seen)

  await run(win, 'document.body.click()')
  await click(win, 'new-session')
  await finishTurn(win)
  await submit(win, SECOND_PROMPT)
  await finishTurn(win)
  await click(win, 'toggle-history')
  await wait(UI_WAIT_MS)
  seen = await panel()
  expect(same(seen.titles, [SECOND_PROMPT, SMOKE_PROMPT]) && seen.active === SECOND_PROMPT, 'both conversations should be listed, newest first', seen)
  await capture(win, outDir, 'history-panel')

  await run(win, typeSearch(SEARCH_TEXT))
  await wait(UI_WAIT_MS)
  seen = await panel()
  expect(same(seen.titles, [SMOKE_PROMPT]) && seen.marks.includes(SEARCH_TEXT), 'search should find the first conversation and highlight the hit', seen)
  await capture(win, outDir, 'history-search')

  await run(win, `document.querySelector('.history-open').click()`)
  await wait(UI_WAIT_MS)
  const thread = await run(win, `({
    questions: [...document.querySelectorAll('.msg-user')].map((el) => el.textContent),
    panelOpen: document.getElementById('history-panel').dataset.open,
    toast: document.querySelector('.toast')?.textContent ?? '',
  })`)
  expect(thread.questions[0] === SMOKE_PROMPT && thread.questions.length === 2 && thread.panelOpen === 'false', 'opening a result should show that conversation and close the panel', thread)
  await capture(win, outDir, 'history-opened')

  await run(win, typeSearch(''))
  await click(win, 'toggle-history')
  await wait(UI_WAIT_MS)
  await run(win, itemAction(SMOKE_PROMPT, '重命名'))
  await run(win, `(() => {
    const input = document.querySelector('.history-rename')
    input.value = ${JSON.stringify(RENAMED_TITLE)}
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
  })()`)
  await wait(UI_WAIT_MS)
  seen = await panel()
  expect(seen.open && seen.titles.includes(RENAMED_TITLE), 'rename should update the list and keep the panel open', seen)

  await run(win, itemAction(SECOND_PROMPT, '删除'))
  await wait(UI_WAIT_MS)
  seen = await panel()
  const listText = await run(win, `document.getElementById('history-list').textContent`)
  expect(same(seen.titles, [RENAMED_TITLE]) && seen.toast.includes('撤销'), 'delete should hide the item and offer undo', seen)
  expect(!listText.includes('null'), 'the list should not print "null"', listText)
  await capture(win, outDir, 'history-undo')
  await run(win, `document.querySelector('.toast-action').click()`)
  await wait(UI_WAIT_MS)
  seen = await panel()
  expect(seen.titles.length === 2 && !seen.toast, 'undo should bring the conversation back', seen)
}

/**
 * Drives the real UI (on the fake dsh, with no key for `setup`, or on the real dsh and a fake model for
 * `memory`) and screenshots each step into `smokeOut`.
 * Fails on any console warning/error or any broken scroll / history expectation.
 */
export async function runSmoke(win, { smokeOut: outDir, smokePhase }, quit, hooks = {}) {
  const problems = []
  win.webContents.on('console-message', (event) => {
    if (event.level === 'warning' || event.level === 'error') problems.push(`${event.level}: ${event.message}`)
  })
  try {
    await fs.mkdir(outDir, { recursive: true })
    await wait(BOOT_WAIT_MS)
    if (smokePhase === 'setup') problems.push(...await checkSetup(win, outDir))
    else if (smokePhase === 'relaunch') problems.push(...await checkRelaunch(win, outDir), ...await checkHistoryPanel(win, outDir), ...await checkMarkdown(win, outDir))
    else if (smokePhase === 'memory') problems.push(...await checkMemory(win, outDir, hooks))
    else problems.push(...await walkthrough(win, outDir, hooks))
  } catch (err) {
    problems.push(`smoke: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    report(problems.length ? `problems:\n${problems.join('\n')}` : `${smokePhase}: no console warnings or errors; checks passed`)
    quit(problems.length ? 1 : 0)
  }
}

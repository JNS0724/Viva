import fs from 'node:fs'
import path from 'node:path'
import { capture, finishTurn, newTopic, run, submit, TURN_TIMEOUT_MS, UI_WAIT_MS, until, wait, type Expect, type SmokeHooks, type SmokeWindow } from './smoke-kit.ts'
import { mcpSteps } from './smoke-mcp.ts'
import { taskSteps } from './smoke-tasks.ts'

/**
 * Smoke steps on the real dsh with the app's plugins and the fake model (test/fixtures/fake-llm.js): the
 * intro, the agent remembering through the plugin's tool, the profile page, a remembered name bringing its
 * memory along, the trace saying so, the agent asking a question and keeping the answer, the 扩展 section,
 * a model provider added in settings answering once picked, and the app bringing dsh back after it is killed.
 */
const POLL_MS = 200
const ROLE = '支付平台部的后端负责人'
const FACT = '周报每周五下班前交给张三'
const PROVIDER = '本地网关'
const PROVIDER_MODEL = 'gw-smoke'
const DEMO_KEY = 'smoke-demo-key-7f3a'

/**
 * 「帮我接入演示服务」: the fake model sets up a server (viva_mcp_add). The approval card names it; allowed,
 * the window asks for its key; the key goes to the encrypted store and never to the model.
 */
async function configSteps(win: SmokeWindow, outDir: string, expect: Expect, hooks: SmokeHooks) {
  await submit(win, '帮我接入演示服务')
  const card = await until(win, `(() => { const c = document.querySelector('.confirm:not(.ask)'); return c && { title: c.querySelector('.confirm-title')?.textContent ?? '' } })()`, 'the approval card')
  expect(card.title === '接入 MCP 服务器「demo」', 'the card should say which server is set up', card)
  await run(win, `document.querySelector('.confirm:not(.ask) .btn-primary').click()`)
  const names = await until(win, `(() => { const inputs = [...document.querySelectorAll('.secret input')]; return inputs.length && inputs.map((el) => el.getAttribute('aria-label')) })()`, 'the key card')
  expect(names.join() === 'DEMO_TOKEN', 'the key card should ask for the key by name', names)
  await capture(win, outDir, 'config-secret')
  await run(win, `(() => {
    document.querySelector('.secret input').value = ${JSON.stringify(DEMO_KEY)}
    document.querySelector('.secret').requestSubmit()
  })()`)
  await finishTurn(win)
  const reply = await run(win, `[...document.querySelectorAll('.msg-agent .msg-text')].at(-1)?.textContent ?? ''`)
  expect(reply.includes('配置结果：已接入 MCP 服务器「demo」'), 'the model should hear the server was set up', reply)
  const stored = fs.readFileSync(path.join(hooks.userData, 'mcp-servers.json'), 'utf8')
  expect(stored.includes('demo') && !stored.includes(DEMO_KEY), 'the server is kept, its key only encrypted', stored.length)
  const sent = JSON.stringify(hooks.model?.()?.requests ?? [])
  expect(sent.length > 2 && !sent.includes(DEMO_KEY), 'the key should never reach the model', sent.length)
}

/**
 * 「明天天气怎么样」: the fake model asks which city (ask_user_question). The card offers the options, a click
 * answers, the answer joins the thread under the question, and the background pass keeps the city.
 */
async function questionSteps(win: SmokeWindow, outDir: string, expect: Expect) {
  await submit(win, '明天天气怎么样')
  const card = await until(win, `(() => {
    const card = document.querySelector('.ask')
    return card && { question: card.querySelector('.ask-question')?.textContent, options: [...card.querySelectorAll('.ask-option')].map((el) => el.textContent) }
  })()`, 'the question card')
  expect(card.question === '你想看哪个城市的天气？' && card.options.join() === '上海,北京', 'the card should show the question and its options', card)
  const island = await run(win, `(() => { const el = document.querySelector('#island .isl'); return { form: el?.dataset.form, text: el?.textContent ?? '' } })()`)
  expect(island.form === 'asking' && island.text.includes('需要你处理'), 'the island should say the user is needed', island)
  await capture(win, outDir, 'question')
  await run(win, `[...document.querySelectorAll('.ask-option')].find((el) => el.textContent === '上海').click()`)
  await finishTurn(win)
  await wait(UI_WAIT_MS)
  const thread = await run(win, `({
    asked: [...document.querySelectorAll('.msg-answer .msg-asked')].at(-1)?.textContent ?? '',
    // The answer's own text: not the question above it, nor the star a message gets once drawn (view/star-buttons).
    answer: [...([...document.querySelectorAll('.msg-answer')].at(-1)?.childNodes ?? [])]
      .filter((node) => !node.classList?.contains('msg-asked') && !node.classList?.contains('star-btn'))
      .map((node) => node.textContent).join('').trim(),
    reply: [...document.querySelectorAll('.msg-agent .msg-text')].at(-1)?.textContent ?? '',
    card: Boolean(document.querySelector('.ask')),
  })`)
  expect(thread.asked === '你想看哪个城市的天气？' && thread.answer === '上海' && !thread.card, 'the answer should join the thread under the question', thread)
  expect(thread.reply.startsWith('好的，按上海来看'), 'the agent should go on with the answer', thread.reply)
  await capture(win, outDir, 'question-answered')
  const kept = await until(win, `window.agent.listMemories('上海').then((list) => list.items.find((m) => m.text.includes('上海'))?.text ?? null)`, 'the city being remembered')
  expect(kept === '用户在上海', 'the answer should be remembered for next time', kept)
}

async function steps(win: SmokeWindow, outDir: string, expect: Expect, hooks: SmokeHooks) {
  await newTopic(win)
  await finishTurn(win)
  await wait(UI_WAIT_MS)
  expect(await run(win, `Boolean(document.getElementById('start-intro'))`), 'a fresh profile should offer the intro on the home page')
  await capture(win, outDir, 'memory-home')

  await run(win, `document.getElementById('start-intro').click()`)
  await wait(UI_WAIT_MS)
  await run(win, `(() => {
    const field = (name) => document.querySelector('[name="' + name + '"]')
    field('intro-role').value = ${JSON.stringify(ROLE)}
    field('intro-projects').value = 'Q4 对账系统重构'
    field('intro-analyze').checked = false
  })()`)
  await capture(win, outDir, 'memory-intro')
  await run(win, `document.querySelector('.intro-form').requestSubmit()`)
  await wait(UI_WAIT_MS)
  const afterIntro = await run(win, `({ panel: Boolean(document.querySelector('.profile')), intro: Boolean(document.getElementById('start-intro')) })`)
  expect(!afterIntro.panel && !afterIntro.intro, 'saving the intro should close it and retire the home tile', afterIntro)

  await submit(win, `记住：${FACT}`)
  const asked = await finishTurn(win)
  await wait(UI_WAIT_MS)
  const toast = await run(win, `document.querySelector('.toast')?.textContent ?? ''`)
  expect(asked === 0, 'memory tools should run without a permission card', asked)
  expect(toast.includes(`已记住：${FACT}`), 'the toast should say what was remembered', toast)
  await capture(win, outDir, 'memory-remembered')

  await run(win, `document.getElementById('open-profile').click()`)
  await run(win, `document.querySelector('.hub-nav[data-page="profile"]').click()`)
  await wait(UI_WAIT_MS)
  const page = await run(win, `({
    role: document.querySelector('[data-field="role"] .profile-value')?.textContent ?? '',
    memories: [...document.querySelectorAll('.memory-text')].map((el) => el.textContent),
    agentMarked: Boolean(document.querySelector('.memory-item[data-source="agent"]')),
  })`)
  expect(page.role === ROLE && page.memories.includes(FACT) && page.agentMarked, 'the profile page should show the intro and the memory', page)
  const meta = await run(win, `document.querySelector('.memory-item[data-source="agent"] .memory-meta')?.textContent ?? ''`)
  expect(meta.includes('关键词：周报、张三'), 'the memory should show the keywords the agent gave it', meta)
  await capture(win, outDir, 'memory-profile')
  await run(win, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  await wait(UI_WAIT_MS)

  await submit(win, '帮我写这周的周报')
  await finishTurn(win)
  await wait(UI_WAIT_MS)
  // The fake model says what background came with the question; 周报 is a keyword of the memory.
  const answers = await run(win, `[...document.querySelectorAll('.msg-agent .msg-text')].map((el) => el.textContent)`)
  expect(answers.some((text: string) => text.startsWith('我已经了解你的背景（1 条相关记忆）')), 'naming 周报 should bring its memory along', answers.map((t: string) => t.slice(0, 24)))
  await run(win, `document.getElementById('toggle-drawer').click()`)
  // The trace comes in after the turn (a slower machine, a packaged app): wait for its row rather than a fixed time.
  const rows = `[...document.querySelectorAll('.trace-row')].map((row) => row.textContent)`
  const memoryRow = `${rows}.some((row) => row.includes('带上记忆') && row.includes(${JSON.stringify(`因为提到「周报」：${FACT}`)}))`
  const trace = await until(win, memoryRow, 'the trace showing which memory went along', UI_WAIT_MS * 10).then(() => run(win, rows), () => run(win, rows))
  expect(trace.some((row: string) => row.includes('带上记忆') && row.includes(`因为提到「周报」：${FACT}`)), 'the trace should show which memory went along and why', trace)
  await capture(win, outDir, 'memory-trace')

  await questionSteps(win, outDir, expect)
  await configSteps(win, outDir, expect, hooks)

  // The icon opens the page last shown (关于你); the sidebar goes on to 设置.
  await run(win, `document.getElementById('open-profile').click()`)
  await wait(UI_WAIT_MS)
  const shown = await run(win, `document.querySelector('.hub-nav[aria-current="page"]')?.dataset.page ?? ''`)
  expect(shown === 'profile', 'the icon should open the page last shown', shown)
  await run(win, `document.querySelector('.hub-nav[data-page="settings"]').click()`)
  await wait(UI_WAIT_MS * 2)
  const ext = await run(win, `({
    memoryProblem: document.querySelector('.ext-memory')?.textContent ?? '',
    hint: document.querySelector('.ext-hint')?.textContent ?? '',
    form: Boolean(document.querySelector('.ext-form, #add-mcp, #import-skill')),
    servers: [...document.querySelectorAll('.ext-item .ext-name')].map((el) => el.textContent),
  })`)
  expect(!ext.memoryProblem && ext.hint.includes('帮我接入 GitHub') && !ext.form, 'settings should say MCP and skills are set up in the conversation, with no form', ext)
  expect(ext.servers.includes('demo'), 'the server set up in the conversation should be listed', ext)
  await run(win, `document.querySelector('.ext').scrollIntoView()`)
  await capture(win, outDir, 'memory-settings')
  await mcpSteps(win, outDir, expect, hooks)
  await modelSteps(win, outDir, expect)
}

/**
 * Adds a provider through the form (the fake model's address, speaking Anthropic Messages like it does),
 * then picks its model and talks to it. The conversation on screen has to survive the restart.
 */
async function modelSteps(win: SmokeWindow, outDir: string, expect: Expect) {
  const asked = await run(win, `document.querySelectorAll('.msg-user').length`)
  await run(win, `document.getElementById('add-model').click()`)
  await wait(UI_WAIT_MS)
  await run(win, `(() => {
    const field = (name) => document.querySelector('[name="' + name + '"]')
    field('model-name').value = ${JSON.stringify(PROVIDER)}
    field('model-api').value = 'anthropic-messages'
    field('model-url').value = ${JSON.stringify(process.env.DEEPSEEK_BASE_URL ?? '')}
    field('model-ids').value = ${JSON.stringify(PROVIDER_MODEL)}
    field('model-key').value = 'sk-smoke-provider-0001'
    field('model-name').closest('form').requestSubmit()
  })()`)
  const outcome = await until(win, `document.querySelector('[aria-label="模型"] [role="status"], [aria-label="模型"] [role="alert"]')?.textContent ?? ''`, 'adding a model provider')
  expect(outcome.includes(`已添加「${PROVIDER}」`), 'the provider should be added', outcome)
  await run(win, `document.querySelector('[aria-label="模型"]')?.scrollIntoView()`)
  await capture(win, outDir, 'models-settings')
  await run(win, `document.getElementById('hub-back').click()`)

  const options = await until(win, `(() => {
    const button = document.getElementById('model-btn')
    if (button.disabled) return null
    if (!document.querySelector('.model-menu')) button.click()
    const seen = [...document.querySelectorAll('.model-option')].map((el) => [el.querySelector('.model-option-name')?.textContent, el.querySelector('.model-option-group')?.textContent])
    return seen.some(([, group]) => group === ${JSON.stringify(PROVIDER)}) ? seen : null
  })()`, 'the added model showing in the picker')
  expect(options.some(([name]: string[]) => name === PROVIDER_MODEL), 'the picker should offer the added model', options)
  await capture(win, outDir, 'models-picker')
  await run(win, `[...document.querySelectorAll('.model-option')].find((el) => el.querySelector('.model-option-group')?.textContent === ${JSON.stringify(PROVIDER)}).click()`)
  const label = await until(win, `(() => { const name = document.querySelector('.model-btn-name')?.textContent; return name === ${JSON.stringify(PROVIDER_MODEL)} ? name : null })()`, 'switching to the added model')
  expect(label === PROVIDER_MODEL, 'the composer should name the picked model', label)
  expect(await run(win, `document.querySelectorAll('.msg-user').length`) === asked, 'the conversation should survive adding a provider')

  await submit(win, '你好')
  await finishTurn(win)
  await wait(UI_WAIT_MS)
  const last = await run(win, `[...document.querySelectorAll('.msg-agent .msg-text')].at(-1)?.textContent ?? ''`)
  expect(last.length > 0 && !(await run(win, `Boolean(document.querySelector('.msg-error'))`)), 'the added model should answer', last.slice(0, 40))
}

/** dsh is killed mid-conversation: the app says it reconnects, starts dsh again on the same conversation, and it answers. */
async function crashSteps(win: SmokeWindow, outDir: string, expect: Expect, hooks: SmokeHooks) {
  const pid = hooks.agentPid?.()
  expect(Boolean(pid), 'dsh should be running', pid)
  if (!pid) return
  const asked = await run(win, `document.querySelectorAll('.msg-user').length`)
  const answered = await run(win, `document.querySelectorAll('.msg-agent').length`)
  // The model menu from the previous step would cover the answer in the screenshot.
  if (await run(win, `Boolean(document.querySelector('.model-menu'))`)) await run(win, `document.getElementById('model-btn').click()`)
  process.kill(pid, 'SIGKILL')
  const notice = await until(win, `(() => { const text = document.querySelector('.msg-error')?.textContent ?? ''; return text.includes('自动重新连接') ? text : null })()`, 'the reconnect notice')
  expect(notice.includes('秒后自动重新连接'), 'the window should say the agent reconnects', notice)
  const deadline = Date.now() + TURN_TIMEOUT_MS
  while (!(hooks.agentPid() && hooks.agentPid() !== pid) && Date.now() < deadline) await wait(POLL_MS)
  expect(Boolean(hooks.agentPid()) && hooks.agentPid() !== pid, 'a new dsh should be running', hooks.agentPid())
  await until(win, `!document.getElementById('model-btn').disabled && !document.querySelector('.msg-error')`, 'the agent coming back')

  await submit(win, '还在吗')
  await finishTurn(win)
  await wait(UI_WAIT_MS)
  const after = await run(win, `({ answers: document.querySelectorAll('.msg-agent').length, last: [...document.querySelectorAll('.msg-agent .msg-text')].at(-1)?.textContent ?? '' })`)
  expect(after.answers === answered + 1 && after.last.length > 0, 'the restarted agent should answer the new question', { answered, ...after })
  expect(await run(win, `document.querySelectorAll('.msg-user').length`) === asked + 1, 'the conversation should carry on after the restart')
  await capture(win, outDir, 'dsh-recovered')
}

/**
 * The conversation goes on in another folder (single-conversation design): the first time it is asked, then
 * the chip names it, the timeline says where the folder changed with what was said before still above, and the
 * agent answers there. A name with a space and Chinese in it, as people's folders have.
 */
async function workDirSteps(win: SmokeWindow, outDir: string, expect: Expect, hooks: SmokeHooks) {
  const dir = path.join(path.dirname(hooks.cwd), '其他 项目')
  fs.mkdirSync(dir, { recursive: true })
  const asked = await run(win, `document.querySelectorAll('#earlier .msg-user, #thread .msg-user').length`)
  const first = await run(win, `window.agent.switchWorkDir(${JSON.stringify(dir)})`)
  expect(first.needsConfirm === true, 'a folder used for the first time should be confirmed first', first)
  const done = await run(win, `window.agent.switchWorkDir(${JSON.stringify(dir)}, { confirmed: true })`)
  expect(done.ok && done.state?.current === dir, 'the confirmed folder should become the working directory', done)
  const shown = await until(win, `(() => {
    const chip = document.getElementById('composer-context').textContent
    const line = document.querySelector('#earlier .timeline-workdir')?.textContent ?? ''
    return chip.includes('其他 项目') && line.includes('其他 项目') ? { chip, line } : null
  })()`, 'the chip and the timeline naming the new folder')
  expect(Boolean(shown), 'the window should show the new folder', shown)
  const kept = await run(win, `document.querySelectorAll('#earlier .msg-user').length`)
  expect(kept === asked, 'what was said before should stay above in the timeline', { asked, kept })

  await submit(win, '换了个项目，继续')
  await finishTurn(win)
  await wait(UI_WAIT_MS)
  const last = await run(win, `[...document.querySelectorAll('#thread .msg-agent .msg-text')].at(-1)?.textContent ?? ''`)
  expect(last.length > 0 && !(await run(win, `Boolean(document.querySelector('.msg-error'))`)), 'the agent should answer in the new folder', last.slice(0, 40))
  await capture(win, outDir, 'workdir-switched')

  await run(win, `document.getElementById('composer-context').click()`)
  const menu = await until(win, `(() => {
    const names = [...document.querySelectorAll('.workdir-item-name')].map((el) => el.textContent)
    return names.length ? names : null
  })()`, 'the working-directory menu')
  expect(menu.includes('其他 项目') && menu.includes('Viva 的文件') && menu.includes('选择文件夹…'), 'the menu should list both folders and the folder dialog', menu)
  await wait(UI_WAIT_MS)
  const box = await run(win, `(() => {
    const rect = document.querySelector('.workdir-menu')?.getBoundingClientRect()
    const top = rect && document.elementFromPoint(rect.left + rect.width / 2, rect.top + 12)
    return rect ? { top: Math.round(rect.top), height: Math.round(rect.height), onTop: Boolean(top?.closest('.workdir-menu')) } : null
  })()`)
  expect(Boolean(box?.onTop) && box.top >= 0, 'the menu should be open on top of the window, all of it on screen', box)
  await capture(win, outDir, 'workdir-menu')
  await run(win, `document.getElementById('composer-context').click()`)
  await dropSteps(win, outDir, expect)
}

const FIRST_ASK = '第一问：蓝色的伞'
const SECOND_ASK = '第二问：红色的伞'
const EDITED_ASK = '第二问：绿色的伞'

/**
 * 改了重发 on what the user said: the bubble turns into an editor in place with what follows dimmed; sent, the
 * agent goes back to before it (the model no longer sees the old words), and what followed folds there.
 */
async function rewindSteps(win: SmokeWindow, outDir: string, expect: Expect, hooks: SmokeHooks) {
  for (const text of [FIRST_ASK, SECOND_ASK]) {
    await submit(win, text)
    await finishTurn(win)
  }
  await wait(UI_WAIT_MS)
  const opened = await run(win, `(() => {
    const row = [...document.querySelectorAll('#thread .msg-user-row')].find((el) => el.querySelector('.msg-user')?.textContent === ${JSON.stringify(SECOND_ASK)})
    if (!row) return { bars: document.querySelectorAll('#thread .rewind-bar').length }
    ;[...row.querySelectorAll('.rewind-act')].find((el) => el.textContent.includes('改了重发')).click()
    return { bars: document.querySelectorAll('#thread .rewind-bar').length }
  })()`)
  const editing = await until(win, `(() => {
    const field = document.querySelector('#thread .rewind-field')
    return field && { value: field.value, focused: document.activeElement === field, dimmed: document.querySelectorAll('#thread .rewind-dim').length }
  })()`, 'the editor in place')
  expect(editing.value === SECOND_ASK && editing.focused && editing.dimmed > 0, 'the message should turn into an editor with the keyboard, what follows dimmed', { opened, editing })
  await capture(win, outDir, 'rewind-edit')

  await run(win, `(() => {
    const field = document.querySelector('#thread .rewind-field')
    field.value = ${JSON.stringify(EDITED_ASK)}
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  })()`)
  await until(win, `[...document.querySelectorAll('#thread .msg-user')].some((el) => el.textContent === ${JSON.stringify(EDITED_ASK)})`, 'the edited words sent')
  await finishTurn(win)
  await wait(UI_WAIT_MS)
  const after = await run(win, `({
    asked: [...document.querySelectorAll('#thread .msg-user')].map((el) => el.textContent),
    fold: document.querySelector('#thread .fold')?.textContent ?? '',
    editor: Boolean(document.querySelector('#thread .rewind-editor')),
  })`)
  expect(after.asked.includes(FIRST_ASK) && after.asked.includes(EDITED_ASK) && !after.asked.includes(SECOND_ASK) && !after.editor,
    'the edited words should replace the old ones, what came before kept', after)
  expect(after.fold.includes('另一条路') && after.fold.includes('2 条消息'), 'the old path should fold where it went another way', after.fold)
  // The first request with the new words is the agent answering them (the memory pass after a turn comes later).
  const answering = (hooks.model?.()?.requests ?? []).map((request: unknown) => JSON.stringify(request)).find((json: string) => json.includes(EDITED_ASK)) ?? ''
  expect(answering.includes(FIRST_ASK) && !answering.includes(SECOND_ASK), 'the agent should no longer see the old words',
    { found: Boolean(answering), first: answering.includes(FIRST_ASK), old: answering.includes(SECOND_ASK) })
  await run(win, `document.querySelector('#thread .fold')?.scrollIntoView({ block: 'center' })`)
  await wait(UI_WAIT_MS)
  await capture(win, outDir, 'rewind-folded')
  await switchBackSteps(win, outDir, expect, hooks)
}

const BACK_ASK = '回到红色那条接着说'

/** The folded path opens in place to be read; switched to, it is the conversation again, the agent with it. */
async function switchBackSteps(win: SmokeWindow, outDir: string, expect: Expect, hooks: SmokeHooks) {
  const foldAct = (label: string) => `[...document.querySelectorAll('#thread .fold .fold-act')].find((el) => el.textContent === ${JSON.stringify(label)}).click()`
  await run(win, foldAct('展开看看'))
  const body = await until(win, `document.querySelector('#thread .fold-body')?.textContent ?? null`, 'the folded path opened')
  expect(body.includes(SECOND_ASK), 'opened, the folded path should show what it holds', body.slice(0, 80))
  await run(win, `document.querySelector('#thread .fold').scrollIntoView({ block: 'start' })`)
  await wait(UI_WAIT_MS)
  await capture(win, outDir, 'rewind-fold-open')

  await run(win, foldAct('切到这条路'))
  await until(win, `[...document.querySelectorAll('#thread > .msg-user-row .msg-user, #thread > .msg-user')].some((el) => el.textContent === ${JSON.stringify(SECOND_ASK)})`, 'the old path on screen again')
  const back = await run(win, `({
    asked: [...document.querySelectorAll('#thread .msg-user')].filter((el) => !el.closest('.fold-body')).map((el) => el.textContent),
    fold: document.querySelector('#thread .fold')?.textContent ?? '',
  })`)
  expect(back.asked.includes(SECOND_ASK) && !back.asked.includes(EDITED_ASK) && back.fold.includes('2 条消息'),
    'switched back, the old words should be on screen and the edited path folded in their place', back)

  await submit(win, BACK_ASK)
  await finishTurn(win)
  const answering = (hooks.model?.()?.requests ?? []).map((request: unknown) => JSON.stringify(request)).find((json: string) => json.includes(BACK_ASK)) ?? ''
  expect(answering.includes(SECOND_ASK) && !answering.includes(EDITED_ASK), 'the agent should go on from the old path',
    { found: Boolean(answering), old: answering.includes(SECOND_ASK), edited: answering.includes(EDITED_ASK) })
  await capture(win, outDir, 'rewind-switched')
}

/** Something held over the window says letting go works there; what is not a folder on disk is turned down. */
async function dropSteps(win: SmokeWindow, outDir: string, expect: Expect) {
  const held = await run(win, `(() => {
    window.smokeDrop = new DataTransfer()
    window.smokeDrop.items.add(new File(['x'], '不在磁盘上.txt'))
    document.body.dispatchEvent(new DragEvent('dragover', { dataTransfer: window.smokeDrop, bubbles: true, cancelable: true }))
    return document.body.classList.contains('drop-folder')
  })()`)
  expect(held, 'a folder held over the window should be told what letting go does')
  await wait(UI_WAIT_MS)
  await capture(win, outDir, 'workdir-drop')
  await run(win, `document.body.dispatchEvent(new DragEvent('drop', { dataTransfer: window.smokeDrop, bubbles: true, cancelable: true }))`)
  const after = await until(win, `(() => {
    const toast = document.querySelector('.toast')?.textContent ?? ''
    return toast && { toast, held: document.body.classList.contains('drop-folder') }
  })()`, 'the toast for a drop that is not a folder')
  expect(after.toast.includes('这不是电脑上的文件夹') && !after.held, 'a drop that is not a folder on disk should be turned down', after)
}

/** @returns failed expectations */
export async function checkMemory(win: SmokeWindow, outDir: string, hooks: SmokeHooks = {}): Promise<string[]> {
  const failures: string[] = []
  const expect: Expect = (ok, message, seen) => { if (!ok) failures.push(`${message}${seen === undefined ? '' : `: ${JSON.stringify(seen)}`}`) }
  try {
    await steps(win, outDir, expect, hooks)
    await crashSteps(win, outDir, expect, hooks)
    await workDirSteps(win, outDir, expect, hooks)
    await rewindSteps(win, outDir, expect, hooks)
    await taskSteps(win, outDir, expect, hooks)
  } catch (err) {
    failures.push(`memory: ${err instanceof Error ? err.message : String(err)}`)
  }
  return failures
}

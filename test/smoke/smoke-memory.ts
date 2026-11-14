import fs from 'node:fs'
import path from 'node:path'
import { capture, finishTurn, newTopic, run, smokeStep, submit, TURN_TIMEOUT_MS, UI_WAIT_MS, until, wait, type Expect, type SmokeHooks, type SmokeWindow } from './smoke-kit.ts'
import { mcpSteps, openCapabilityTab } from './smoke-mcp.ts'
import { skillImportSteps } from './smoke-skills.ts'
import { pluginSourceSteps } from './smoke-plugin-source.ts'
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
 * answers, the answer joins the thread under the question, and the choice stays in that request.
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
  const kept = await run(win, `window.agent.listMemories('上海').then(list => list.items.map(memory => memory.text))`)
  expect(!kept.includes('上海'), 'a city chosen for one weather lookup should stay local to that request', kept)
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
  // Saving the profile and marking onboarding done are separate IPCs. The tile can disappear before the form closes.
  const afterIntro = await until(win, `(() => {
    const state = { panel: Boolean(document.querySelector('.profile')), intro: Boolean(document.getElementById('start-intro')),
      error: document.querySelector('.intro-form [role="alert"]')?.textContent ?? '' }
    return state.error || (!state.panel && !state.intro) ? state : null
  })()`, 'the intro save and onboarding to finish')
  expect(!afterIntro.error && !afterIntro.panel && !afterIntro.intro, 'saving the intro should close it and retire the home tile', afterIntro)
  const keptIntro = await run(win, `window.agent.getMemory().then(({ profile, onboarding }) => ({ role: profile.role?.value, onboarding }))`)
  expect(keptIntro.role === ROLE && keptIntro.onboarding === 'done', 'the intro role and completed onboarding should both be persisted', keptIntro)

  await submit(win, `记住：${FACT}`)
  const asked = await finishTurn(win)
  expect(asked === 0, 'memory tools should run without a permission card', asked)
  await until(win, `document.querySelector('.toast')?.textContent?.includes(${JSON.stringify(`已记住：${FACT}`)})`, 'the verified save notification')
  await capture(win, outDir, 'memory-remembered')

  await until(win, `window.agent.listMemories('周报').then(({ items }) =>
    items.some(item => item.text === ${JSON.stringify(FACT)} && !item.conditional))`, 'the saved report memory to be ready for injection')
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
  expect(meta.includes('关键词：') && meta.includes('周报') && meta.includes('张三'), 'the memory should show the verified keywords', meta)
  await capture(win, outDir, 'memory-profile')
  await run(win, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  await wait(UI_WAIT_MS)

  await submit(win, '帮我写这周的周报')
  await finishTurn(win)
  await wait(UI_WAIT_MS)
  // The fake model says what background came with the question; 周报 is a keyword of the memory.
  const answers = await run(win, `[...document.querySelectorAll('.msg-agent .msg-text')].map((el) => el.textContent)`)
  expect(answers.some((text: string) => /^我已经了解你的背景（(?:画像、)?1 条相关记忆）/.test(text)), 'naming 周报 should bring its memory along', answers.map((t: string) => t.slice(0, 24)))
  await run(win, `document.getElementById('toggle-drawer').click()`)
  // The trace comes in after the turn (a slower machine, a packaged app): wait for its row rather than a fixed time.
  const rows = `[...document.querySelectorAll('.trace-row')].map((row) => row.textContent)`
  const explainsMatch = (row: string) => row.includes('带上记忆') && /因为提到「[^」]*周报[^」]*」/u.test(row) && row.includes(`」：${FACT}`)
  const memoryRow = `${rows}.some((row) => row.includes('带上记忆') && /因为提到「[^」]*周报[^」]*」/u.test(row) && row.includes(${JSON.stringify(`」：${FACT}`)}))`
  const trace = await until(win, memoryRow, 'the trace showing which memory went along', UI_WAIT_MS * 10).then(() => run(win, rows), () => run(win, rows))
  expect(trace.some(explainsMatch), 'the trace should show which memory went along and why', trace)
  await capture(win, outDir, 'memory-trace')

  await questionSteps(win, outDir, expect)
  await configSteps(win, outDir, expect, hooks)

  // The icon opens the page last shown (关于你); the sidebar goes on to 设置.
  await run(win, `document.getElementById('open-profile').click()`)
  await wait(UI_WAIT_MS)
  const shown = await run(win, `document.querySelector('.hub-nav[aria-current="page"]')?.dataset.page ?? ''`)
  expect(shown === 'profile', 'the icon should open the page last shown', shown)
  await openCapabilityTab(win, 'mcp')
  const ext = await run(win, `({
    memoryProblem: document.querySelector('.ext-memory')?.textContent ?? '',
    hint: document.querySelector('#capabilities-root .cap-hint')?.textContent ?? '',
    form: Boolean(document.querySelector('#capabilities-root .cap-side .ext-form, #add-mcp, #import-skill')),
    servers: [...document.querySelectorAll('#capabilities-root .cap-row .tp-name')].map((el) => el.textContent),
  })`)
  expect(!ext.memoryProblem && ext.hint.includes('帮我接入 GitHub') && !ext.form, '能力 should say MCP is set up in the conversation, with no form', ext)
  expect(ext.servers.includes('demo'), 'the server set up in the conversation should be listed', ext)
  await capture(win, outDir, 'memory-settings')
  await mcpSteps(win, outDir, expect, hooks)
  await skillImportSteps(win, outDir, expect, hooks)
  await pluginSourceSteps(win, outDir, expect)
  await modelSteps(win, outDir, expect, hooks)
}

/**
 * Adds a provider through the form (the fake model's address, speaking Anthropic Messages like it does),
 * then picks its model and talks to it. The conversation on screen has to survive the restart.
 */
async function modelSteps(win: SmokeWindow, outDir: string, expect: Expect, hooks: SmokeHooks) {
  const asked = await run(win, `document.querySelectorAll('.msg-user').length`)
  // The MCP steps leave 能力 open; models are 设置's.
  await run(win, `document.querySelector('.hub-nav[data-page="settings"]').click()`)
  await until(win, `document.getElementById('add-model') || null`, 'the 设置 page')
  await run(win, `document.getElementById('add-model').click()`)
  await wait(UI_WAIT_MS)
  await run(win, `(() => {
    const field = (name) => document.querySelector('[name="' + name + '"]')
    field('model-name').value = ${JSON.stringify(PROVIDER)}
    field('model-api').value = 'anthropic-messages'
    field('model-url').value = ${JSON.stringify(hooks.model()?.url ?? '')}
    field('model-id-0').value = ${JSON.stringify(PROVIDER_MODEL)}
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
  const pid = await hooks.agentPid()
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
  let restarted = await hooks.agentPid()
  while (!(restarted && restarted !== pid) && Date.now() < deadline) {
    await wait(POLL_MS)
    restarted = await hooks.agentPid()
  }
  expect(Boolean(restarted) && restarted !== pid, 'a new dsh should be running', restarted)
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
 * The backend process is killed: the shell starts it again (backend-keeper.ts), the window reloads onto it with the
 * conversation as it was (app.db), dsh comes back, and the next question is answered.
 */
async function backendCrashSteps(win: SmokeWindow, outDir: string, expect: Expect, hooks: SmokeHooks) {
  const pid = await hooks.backendPid()
  expect(Boolean(pid), 'the backend should be running', pid)
  if (!pid) return
  const asked = await run(win, `document.querySelectorAll('.msg-user').length`)
  // The page reloads onto the new backend: marked now, the old page is told from the new one.
  await run(win, `window.smokeBeforeRestart = true`)
  process.kill(pid, 'SIGKILL')
  const deadline = Date.now() + TURN_TIMEOUT_MS
  let restarted = await hooks.backendPid()
  while (!(restarted && restarted !== pid) && Date.now() < deadline) {
    await wait(POLL_MS)
    restarted = await hooks.backendPid()
  }
  expect(Boolean(restarted) && restarted !== pid, 'a new backend should be running', restarted)
  const ready = `!window.smokeBeforeRestart && document.querySelectorAll('.msg-user').length === ${asked}
    && !document.getElementById('model-btn').disabled && !document.querySelector('.msg-error')`
  let back = false
  while (!back && Date.now() < deadline) {
    // A check that runs as the page reloads is cut off with it: that is the reload, not a failure.
    back = await run(win, ready).catch((err: Error) => {
      if (/context was destroyed|navigation/i.test(err.message)) return false
      throw err
    })
    if (!back) await wait(POLL_MS)
  }
  expect(back, 'the window should be back on the new backend: reloaded, the conversation as it was, the agent ready')
  if (!back) return

  await submit(win, '后端重启后还在吗')
  await finishTurn(win)
  await wait(UI_WAIT_MS)
  const last = await run(win, `[...document.querySelectorAll('.msg-agent .msg-text')].at(-1)?.textContent ?? ''`)
  expect(last.length > 0, 'the agent should answer after the backend restarted', last.slice(0, 40))
  expect(await run(win, `document.querySelectorAll('.msg-user').length`) === asked + 1, 'the conversation should carry on after the backend restarted')
  await capture(win, outDir, 'backend-recovered')
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
  const answering = (hooks.model?.()?.requests ?? []).map((request: unknown) => JSON.stringify(request))
    .find((json: string) => json.includes(EDITED_ASK) && !json.includes('UTF-16')) ?? ''
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
  const answering = (hooks.model?.()?.requests ?? []).map((request: unknown) => JSON.stringify(request))
    .find((json: string) => json.includes(BACK_ASK) && !json.includes('UTF-16')) ?? ''
  expect(answering.includes(FIRST_ASK) && !answering.includes(SECOND_ASK) && !answering.includes(EDITED_ASK),
    'the agent should carry the shared history and omit the withdrawn source and the other path',
    { found: Boolean(answering), shared: answering.includes(FIRST_ASK), withdrawn: answering.includes(SECOND_ASK), edited: answering.includes(EDITED_ASK) })
  await capture(win, outDir, 'rewind-switched')
}

/** Something held over the window says letting go works there; what is not a folder on disk is turned down. */
async function dropSteps(win: SmokeWindow, outDir: string, expect: Expect) {
  const held = await run(win, `(() => {
    window.smokeDrop = new DataTransfer()
    window.smokeDrop.items.add(new File(['x'], '不在磁盘上.txt'))
    document.body.dispatchEvent(new DragEvent('dragover', { dataTransfer: window.smokeDrop, bubbles: true, cancelable: true }))
    return { held: document.body.classList.contains('drop-folder'), hint: document.body.dataset.dropHint ?? null }
  })()`)
  // The words come from the language resources (styles.css shows the body's data-drop-hint), not from the style sheet.
  expect(held.held && held.hint === '松开，在这个文件夹里工作', 'a folder held over the window should be told what letting go does', held)
  await wait(UI_WAIT_MS)
  await capture(win, outDir, 'workdir-drop')
  await run(win, `document.body.dispatchEvent(new DragEvent('drop', { dataTransfer: window.smokeDrop, bubbles: true, cancelable: true }))`)
  const after = await until(win, `(() => {
    const toast = document.querySelector('.toast')?.textContent ?? ''
    return toast && { toast, held: document.body.classList.contains('drop-folder'), hint: document.body.dataset.dropHint ?? null }
  })()`, 'the toast for a drop that is not a folder')
  expect(after.toast.includes('这不是电脑上的文件夹') && !after.held && after.hint === null, 'a drop that is not a folder on disk should be turned down', after)
}

async function forgettingSteps(win: SmokeWindow, expect: Expect, hooks: SmokeHooks) {
  const marker = '紫藤城合成记忆七二一'
  const independent = '独立的合成对话背景九三五'
  const next = '继续这个话题并核对本轮合成请求'
  await newTopic(win)
  await submit(win, independent)
  await finishTurn(win)
  await submit(win, `记住：${marker}`)
  await finishTurn(win)
  const before = await run(win, `window.agent.getInfo()`)
  const entry = await until(win, `window.agent.listMemories(${JSON.stringify(marker)}).then(list => list.items[0] ?? null)`, 'the sourced memory')
  await submit(win, `忘掉 #${entry.id}`)
  await finishTurn(win)
  const after = await run(win, `window.agent.getInfo()`)
  expect(after.topicId === before.topicId && after.sessionId !== before.sessionId, 'forgetting should replace the DSH session and retain the Viva topic', { before: before.sessionId, after: after.sessionId })
  const offset = hooks.model?.()?.requests.length ?? 0
  await submit(win, next)
  await finishTurn(win)
  const sent = (hooks.model?.()?.requests ?? []).slice(offset).map((request: unknown) => JSON.stringify(request))
  const conversation = sent.find(text => text.includes(next) && !text.includes('UTF-16')) ?? ''
  expect(conversation.includes(independent) && !conversation.includes(marker), 'filtered continuation should preserve unrelated context and omit the forgotten source', { found: Boolean(conversation) })
  const active = await run(win, `window.agent.listMemories(${JSON.stringify(marker)}).then(list => list.items)`)
  expect(active.length === 0, 'forgotten content should remain absent from recall', active)
  const resumed = await run(win, `window.agent.resumeTopic(${JSON.stringify(before.conversationId)})`)
  expect(resumed.ok && resumed.info.topicId === before.topicId && resumed.info.sessionId !== before.sessionId,
    'review should open a fresh session for the same topic', { ok: resumed.ok, changed: resumed.info?.sessionId !== before.sessionId })
  const followup = '从回顾续接后的合成请求'
  const count = hooks.model()?.requests.length ?? 0
  await run(win, `window.agent.prompt(${JSON.stringify(followup)}, [], crypto.randomUUID())`)
  const request = (hooks.model()?.requests ?? []).slice(count).map(item => JSON.stringify(item))
    .find(item => item.includes(followup) && !item.includes('UTF-16')) ?? ''
  expect(request.includes(independent) && !request.includes(marker), 'resuming an old session should use filtered records', { found: Boolean(request) })

  const withdrawn = '海棠城合成记忆一七二'
  await newTopic(win)
  await submit(win, `记住：${withdrawn}`)
  await finishTurn(win)
  await until(win, `window.agent.listMemories(${JSON.stringify(withdrawn)}).then(list => list.items[0] ?? null)`, 'a memory with a single conversation as evidence')
  const host = await run(win, `window.agent.getInfo()`)
  await newTopic(win)
  await until(win, `window.agent.getInfo().then(info => info.topicId !== ${JSON.stringify(host.topicId)})`, 'a new topic before removing the source conversation')
  await run(win, `window.agent.deleteConversation(${JSON.stringify(host.conversationId)})`)
  await run(win, `window.agent.restoreConversation(${JSON.stringify(host.conversationId)})`)
  const afterWithdrawal = await run(win, `window.agent.listMemories(${JSON.stringify(withdrawn)}).then(list => list.items.length)`)
  expect(afterWithdrawal === 0, 'restoring the chat cannot revive the withdrawn memory', afterWithdrawal)
}

async function conflictSteps(win: SmokeWindow, outDir: string, expect: Expect, hooks: SmokeHooks) {
  const one = '我唯一的周报提交邮箱是 amber@example.com'
  const two = '我唯一的周报提交邮箱是 jade@example.com'
  await submit(win, one)
  await finishTurn(win)
  await until(win, `window.agent.listMemories('周报提交邮箱').then(value => value.items.some(item => item.fact?.predicate === 'report_email'))`, 'model-proposed email fact')
  await submit(win, two)
  await finishTurn(win)
  const conflicted = await until(win, `window.agent.listInvalidMemories().then(items => items.some(item => item.text === ${JSON.stringify(two)}) && items)`, 'model-proposed conflict')
  const alternatives = conflicted.filter((item: { text: string, state: string }) => [one, two].includes(item.text) && item.state === 'disputed')
  expect(alternatives.length === 2, 'the app should expose both unresolved claims')

  await submit(win, '只润色周报正文')
  await finishTurn(win)
  expect(!await run(win, `Boolean(document.querySelector('.ask'))`), 'polishing the report does not ask for its address')
  await submit(win, '按记忆填写周报提交邮箱')
  const clarification = await until(win, `(() => {
    const cards = [...document.querySelectorAll('.ask')]
    if (!cards.length) return null
    return cards.map(card => [...card.querySelectorAll('.ask-option')].map(option => option.textContent))
  })()`, 'the task-local memory question')
  expect(clarification.length === 1 && clarification[0].length === 2
    && clarification[0].some((text: string) => text.includes(one))
    && clarification[0].some((text: string) => text.includes(two)), 'the card shows both versions once', clarification)
  await capture(win, outDir, 'memory-clarification')
  await run(win, `[...document.querySelectorAll('.ask-option')].find(option => option.textContent.includes('jade@example.com')).click()`)
  await finishTurn(win)
  const answer = await run(win, `[...document.querySelectorAll('.msg-agent .msg-text')].at(-1)?.textContent ?? ''`)
  expect(answer.includes('这次填') && answer.includes('jade@example.com'), 'the reply uses the chosen address for this request', answer)
  const unresolved = await run(win, `window.agent.listInvalidMemories().then(items => items.filter(item => item.state === 'disputed'
    && [${JSON.stringify(one)}, ${JSON.stringify(two)}].includes(item.text)).length)`)
  const current = await run(win, `window.agent.listMemories('周报提交邮箱').then(result => result.items.length)`)
  expect(unresolved === 2 && current === 0, 'the task-local choice leaves both claims in dispute', { unresolved, current })
  const model = hooks.model?.()
  const next = model?.requests.length ?? 0
  const followUp = '再检查一下周报正文'
  await submit(win, followUp)
  await finishTurn(win)
  const sent = (model?.requests ?? []).slice(next).map(request => JSON.stringify(request))
    .find(request => request.includes(followUp) && !request.includes('UTF-16'))
  expect(Boolean(sent) && !sent?.includes('这次填') && !sent?.includes('jade@example.com'),
    'a later model request does not carry the task-local choice', { found: Boolean(sent) })

  await run(win, `document.getElementById('open-profile').click()`)
  await run(win, `document.querySelector('.hub-nav[data-page="profile"]').click()`)
  await until(win, `document.querySelector('.memory-invalid > button[name="memory-invalid"]')`, 'other memory records')
  await run(win, `document.querySelector('.memory-invalid > button[name="memory-invalid"]').click()`)
  const choose = `[...document.querySelectorAll('[data-memory-conflict] [data-memory-id]')].find(row => row.querySelector('.memory-text')?.textContent === ${JSON.stringify(two)})
    ?.querySelector('button.btn-outline')`
  await until(win, `Boolean(${choose})`, 'conflict confirmation')
  await run(win, `(${choose}).closest('[data-memory-conflict]').scrollIntoView({ block: 'center' })`)
  await capture(win, outDir, 'memory-conflict')
  await run(win, `(${choose}).click()`)
  const entries = await until(win, `window.agent.listMemories('周报提交邮箱').then(value => {
    const texts = value.items.map(item => item.text)
    return texts.includes(${JSON.stringify(two)}) && texts
  })`, 'the confirmed memory becomes active')
  expect(entries.includes(two) && !entries.includes(one), 'only the confirmed claim should be current', entries)
  await run(win, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)

  await submit(win, '从现在起，我的周报提交邮箱从 jade@example.com 改为 cobalt@example.com')
  await finishTurn(win)
  const change = await until(win, `window.agent.listMemoryChanges().then(changes => changes.find(change =>
    change.kind === 'supersede' && change.status === 'applied' && change.before === ${JSON.stringify(two)} &&
    change.after?.includes('cobalt@example.com')))`, 'the explicit replacement in memory history')
  const replaced = await run(win, `window.agent.listMemories('周报提交邮箱').then(value => value.items.map(item => item.text))`)
  expect(replaced.some((text: string) => text.includes('cobalt@example.com')) && !replaced.includes(two), 'the replacement is current before undo', replaced)
  const inspectModel = async (question: string, current: string, previous: string) => {
    const model = hooks.model?.()
    const first = model?.requests.length ?? 0
    await submit(win, question)
    await finishTurn(win)
    const sent = (model?.requests ?? []).slice(first).map(request => JSON.stringify(request))
      .find(request => request.includes(question) && !request.includes('UTF-16'))
    expect(Boolean(sent?.includes(current)) && !sent?.includes(previous), 'the next model request contains the current address and omits stale memory', {
      found: Boolean(sent), current: sent?.includes(current), stale: sent?.includes(previous),
    })
  }
  await inspectModel('核对刚生效的周报提交邮箱', 'cobalt@example.com', 'jade@example.com')
  const changeHistory = `document.querySelector('button[name="memory-changes"]')`
  await run(win, `document.getElementById('open-profile').click()`)
  await run(win, `document.querySelector('.hub-nav[data-page="profile"]').click()`)
  await until(win, changeHistory, 'memory changes')
  await run(win, `(${changeHistory}).click()`)
  const changeRow = `document.querySelector('[data-memory-change="${change.id}"]')`
  await until(win, `Boolean(${changeRow}?.querySelector('.btn-outline'))`, 'undo for the applied change')
  const displayed = await run(win, `${changeRow}.textContent`)
  expect(displayed.includes(two) && displayed.includes('cobalt@example.com') && displayed.includes('原文依据'), 'the change shows both values and source wording', displayed)
  await run(win, `${changeRow}.scrollIntoView({ block: 'center' })`)
  await capture(win, outDir, 'memory-change-history')
  await run(win, `${changeRow}.querySelector('.btn-outline').click()`)
  await until(win, `${changeRow}?.dataset.status === 'undone'`, 'the change is shown as undone')
  const restored = await run(win, `window.agent.listMemories('周报提交邮箱').then(value => value.items.map(item => item.text))`)
  expect(restored.includes(two) && !restored.some((text: string) => text.includes('cobalt@example.com')), 'undo restores the previously confirmed value', restored)
  await run(win, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  await inspectModel('核对撤销后的周报提交邮箱', two, 'cobalt@example.com')
}

/** @returns failed expectations */
export async function checkMemory(win: SmokeWindow, outDir: string, hooks: SmokeHooks): Promise<string[]> {
  const failures: string[] = []
  const expect: Expect = (ok, message, seen) => { if (!ok) throw new Error(`${message}${seen === undefined ? '' : `: ${JSON.stringify(seen)}`}`) }
  try {
    await smokeStep(hooks, 'memory, capabilities and models', () => steps(win, outDir, expect, hooks))
    await smokeStep(hooks, 'dsh crash recovery', () => crashSteps(win, outDir, expect, hooks))
    await smokeStep(hooks, 'backend crash recovery', () => backendCrashSteps(win, outDir, expect, hooks))
    await smokeStep(hooks, 'working directory', () => workDirSteps(win, outDir, expect, hooks))
    await smokeStep(hooks, 'rewind', () => rewindSteps(win, outDir, expect, hooks))
    await smokeStep(hooks, 'background task interactions', () => taskSteps(win, outDir, expect, hooks))
    await smokeStep(hooks, 'forgetting and filtered continuation', () => forgettingSteps(win, expect, hooks))
    await smokeStep(hooks, 'versioned conflict resolution', () => conflictSteps(win, outDir, expect, hooks))
  } catch (err) {
    failures.push(`memory: ${err instanceof Error ? err.message : String(err)}`)
  }
  return failures
}

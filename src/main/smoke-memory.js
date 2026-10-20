import { capture, finishTurn, run, submit, TURN_TIMEOUT_MS, UI_WAIT_MS, until, wait } from './smoke-kit.js'

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

/**
 * 「明天天气怎么样」: the fake model asks which city (ask_user_question). The card offers the options, a click
 * answers, the answer joins the thread under the question, and the background pass keeps the city.
 */
async function questionSteps(win, outDir, expect) {
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
    answer: [...document.querySelectorAll('.msg-answer')].at(-1)?.lastChild?.textContent ?? '',
    reply: [...document.querySelectorAll('.msg-agent .msg-text')].at(-1)?.textContent ?? '',
    card: Boolean(document.querySelector('.ask')),
  })`)
  expect(thread.asked === '你想看哪个城市的天气？' && thread.answer === '上海' && !thread.card, 'the answer should join the thread under the question', thread)
  expect(thread.reply.startsWith('好的，按上海来看'), 'the agent should go on with the answer', thread.reply)
  await capture(win, outDir, 'question-answered')
  const kept = await until(win, `window.agent.listMemories('上海').then((list) => list.items.find((m) => m.text.includes('上海'))?.text ?? null)`, 'the city being remembered')
  expect(kept === '用户在上海', 'the answer should be remembered for next time', kept)
}

async function steps(win, outDir, expect) {
  await run(win, `document.getElementById('new-session').click()`)
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
  expect(answers.some((text) => text.startsWith('我已经了解你的背景（1 条相关记忆）')), 'naming 周报 should bring its memory along', answers.map((t) => t.slice(0, 24)))
  await run(win, `document.querySelector('.rail-btn[aria-label="过程"]')?.click()`)
  await wait(UI_WAIT_MS)
  const trace = await run(win, `[...document.querySelectorAll('.trace-row')].map((row) => row.textContent)`)
  expect(trace.some((row) => row.includes('带上记忆') && row.includes(`因为提到「周报」：${FACT}`)), 'the trace should show which memory went along and why', trace)
  await capture(win, outDir, 'memory-trace')

  await questionSteps(win, outDir, expect)

  await run(win, `document.getElementById('open-settings').click()`)
  await wait(UI_WAIT_MS * 2)
  const ext = await run(win, `({
    memoryOn: document.querySelector('.ext-memory')?.dataset.on,
    add: Boolean(document.getElementById('add-mcp')),
  })`)
  expect(ext.memoryOn === 'true' && ext.add, 'settings should show the memory tool connected and offer MCP servers', ext)
  await run(win, `document.querySelector('.ext').scrollIntoView()`)
  await capture(win, outDir, 'memory-settings')
  await modelSteps(win, outDir, expect)
}

/**
 * Adds a provider through the form (the fake model's address, speaking Anthropic Messages like it does),
 * then picks its model and talks to it. The conversation on screen has to survive the restart.
 */
async function modelSteps(win, outDir, expect) {
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
  const outcome = await until(win, `document.querySelector('.ext [role="status"], .ext [role="alert"]')?.textContent ?? ''`, 'adding a model provider')
  expect(outcome.includes(`已添加「${PROVIDER}」`), 'the provider should be added', outcome)
  await run(win, `document.querySelector('[aria-label="模型"]')?.scrollIntoView()`)
  await capture(win, outDir, 'models-settings')
  await run(win, `document.querySelector('[aria-label="关闭设置"]').click()`)

  const options = await until(win, `(() => {
    const button = document.getElementById('model-btn')
    if (button.disabled) return null
    if (!document.querySelector('.model-menu')) button.click()
    const seen = [...document.querySelectorAll('.model-option')].map((el) => [el.querySelector('.model-option-name')?.textContent, el.querySelector('.model-option-group')?.textContent])
    return seen.some(([, group]) => group === ${JSON.stringify(PROVIDER)}) ? seen : null
  })()`, 'the added model showing in the picker')
  expect(options.some(([name]) => name === PROVIDER_MODEL), 'the picker should offer the added model', options)
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
async function crashSteps(win, outDir, expect, hooks) {
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

/** @returns {Promise<string[]>} failed expectations */
export async function checkMemory(win, outDir, hooks = {}) {
  const failures = []
  const expect = (ok, message, seen) => { if (!ok) failures.push(`${message}${seen === undefined ? '' : `: ${JSON.stringify(seen)}`}`) }
  try {
    await steps(win, outDir, expect)
    await crashSteps(win, outDir, expect, hooks)
  } catch (err) {
    failures.push(`memory: ${err instanceof Error ? err.message : String(err)}`)
  }
  return failures
}

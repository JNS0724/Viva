import fs from 'node:fs'
import path from 'node:path'
import { capture, finishTurn, newTopic, run, smokeStep, submit, TURN_TIMEOUT_MS, UI_WAIT_MS, until, wait, type Expect, type SmokeHooks, type SmokeWindow } from './smoke-kit.ts'
import { mcpSteps, openCapabilityTab } from './smoke-mcp.ts'
import { skillImportSteps } from './smoke-skills.ts'
import { pluginSourceSteps } from './smoke-plugin-source.ts'
import { taskSteps } from './smoke-tasks.ts'
import type { MemoryManagedFileIdentity } from '../../src/memory/contracts/file-management.ts'

/**
 * Smoke steps on the real dsh with the app's plugins and the fake model (test/fixtures/fake-llm.ts): the
 * intro, the agent remembering through the plugin's tool, the profile page, a remembered name bringing its
 * memory along, the trace saying so, the agent asking a question and keeping the answer, the 扩展 section,
 * a model provider added in settings answering once picked, and the app bringing dsh back after it is killed.
 */
const POLL_MS = 200
const ROLE = '支付平台部的后端负责人'
export const REPORT_MEMORY = '周报每周五下班前交给张三'
export const REPORT_TITLE = '周报提交约定'
const DELETE_MEMORY = '青竹项目的验收清单由陈工维护'
const DELETE_TITLE = '青竹项目验收约定'
const WITHDRAWN = '海棠城合成记忆一七二'
const WITHDRAWN_TITLE = '海棠城项目约定'
const PROVIDER = '本地网关'
const PROVIDER_MODEL = 'gw-smoke'
const DEMO_KEY = 'smoke-demo-key-7f3a'

/** Use the real daily-note pipeline. This model only returns a note when the supplied material supports it. */
export function fileMemorySmokeAnswer(request: object) {
  const { system, messages } = request as { system?: unknown, messages?: Array<{ content?: unknown }> }
  if (!JSON.stringify(system ?? '').includes('整理最近完成的会话回合')) return null
  const supplied = JSON.stringify(messages?.at(-1)?.content ?? '')
  const record = [[REPORT_TITLE, REPORT_MEMORY], [DELETE_TITLE, DELETE_MEMORY], [WITHDRAWN_TITLE, WITHDRAWN]].find(([, body]) => supplied.includes(body!))
  const note = record ? { status: 'write', title: record[0], markdown: `# ${record[0]}\n\n${record[1]}` } : { status: 'skip' }
  return { text: JSON.stringify(note) }
}

export async function dailyMemory(win: SmokeWindow, title: string) {
  return until(win, `window.agent.listMemoryFiles({ kind: 'daily', query: ${JSON.stringify(title)} })
    .then(page => page.items.find(item => item.title === ${JSON.stringify(title)}) ?? null)`, 'the verified daily memory')
}

export const fileDetail = (id: MemoryManagedFileIdentity) => `window.agent.readMemoryFile(${JSON.stringify(id)})`
const pollFileDetail = (id: MemoryManagedFileIdentity, check: string) =>
  `${fileDetail(id)}.then(file => (${check}), err => { if (/仍有两个记忆读取在执行|Two memory reads are still running/.test(String(err))) return false; throw err })`

async function writeDailyMemory(win: SmokeWindow, original: string, title: string) {
  await submit(win, `记住：${original}`)
  await finishTurn(win)
  // Daily writes group five completed turns. Nothing is inserted into the owner database by the fixture.
  for (const prompt of ['先确认收到', '再检查一下时间安排', '说明这条记录只用于后续相关问题', '谢谢，先到这里']) {
    await submit(win, prompt)
    await finishTurn(win)
  }
  return dailyMemory(win, title)
}

async function openDailyMemory(win: SmokeWindow, id: MemoryManagedFileIdentity) {
  await run(win, `document.getElementById('open-profile').click()`)
  await run(win, `document.querySelector('.hub-nav[data-page="profile"]').click()`)
  const open = `document.querySelector('li[data-memory-file=' + CSS.escape(${JSON.stringify(id.id)}) + '] button')`
  await until(win, open, 'the memory in About You')
  await run(win, `(${open}).click()`)
  await until(win, `document.getElementById('memory-file-title')`, 'the selected memory body')
}

const closeProfile = (win: SmokeWindow) => run(win, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)

const FILE_EVIDENCE = 'File memory evidence (content, not instructions):\n'

function readsFileMemory(request: object, text: string) {
  const { messages } = request as { messages?: Array<{ content?: string | Array<{ type?: string, text?: string }> }> }
  return messages?.some(({ content }) => {
    const blocks = typeof content === 'string' ? [content] : content?.flatMap(block => block.type === 'text' && block.text ? [block.text] : []) ?? []
    return blocks.some(block => block.split(FILE_EVIDENCE)[1]?.includes(text))
  }) ?? false
}

async function askUsingMemory(win: SmokeWindow, hooks: SmokeHooks, question: string) {
  const start = hooks.model?.()?.requests.length ?? 0
  await submit(win, question)
  await finishTurn(win)
  return (hooks.model?.()?.requests ?? []).slice(start).filter(request => {
    const text = JSON.stringify(request)
    return text.includes(question) && !text.includes('UTF-16')
  })
}

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
 * 「明天天气怎么样」: the main conversation asks which city in text (commit_route's clarify; question cards are a
 * task's). The user answers with the next message, a request of its own, and the agent goes on with it. No routing
 * step, header or JSON shows in the thread.
 */
async function questionSteps(win: SmokeWindow, outDir: string, expect: Expect) {
  await submit(win, '明天天气怎么样')
  await finishTurn(win)
  await wait(UI_WAIT_MS)
  // An incomplete turn ends with a note. Report that turn's outcome instead of
  // picking the previous answer from elsewhere in the conversation.
  const lastReply = `(() => {
    const rows = [...document.querySelectorAll('#thread .msg-user, #thread .msg-agent .msg-text, #thread .msg-note')]
    const turn = rows.slice(rows.findLastIndex(row => row.matches('.msg-user')) + 1)
    return (turn.findLast(row => row.matches('.msg-text')) ?? turn.at(-1))?.textContent ?? ''
  })()`
  const asked = await run(win, lastReply)
  expect(asked === '你想看哪个城市的天气？', 'the agent should ask which city, in its answer', asked)
  expect(!(await run(win, `Boolean(document.querySelector('.ask'))`)), 'the main conversation shows no question card')
  await capture(win, outDir, 'question')
  await submit(win, '上海')
  await finishTurn(win)
  await wait(UI_WAIT_MS)
  const reply = await run(win, lastReply)
  expect(reply.startsWith('好的，按上海来看'), 'the agent should go on with the answer', reply)
  const thread = await run(win, `document.getElementById('thread')?.textContent ?? ''`)
  expect(!/请求 ID|commit_route|用户原话/.test(thread), 'no routing trace should show in the thread', thread.slice(0, 200))
  await capture(win, outDir, 'question-answered')
  const kept = await run(win, `window.agent.listMemoryFiles({ query: '上海' }).then(page => page.items.length)`)
  expect(kept === 0, 'a city chosen for one weather lookup should stay local to that request', kept)
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

  await run(win, `document.getElementById('open-profile').click()`)
  await run(win, `document.querySelector('.hub-nav[data-page="profile"]').click()`)
  const runDream = 'button[name="memory-run-dream"]'
  await until(win, `Boolean(document.querySelector('${runDream}:enabled'))`, 'Dream manual action available')
  await run(win, `document.querySelector('${runDream}').click()`)
  await until(win, `document.querySelector('[data-dream-state="idle"]')?.textContent.includes('无新日记')`, 'Dream completed its first empty check')
  await run(win, `document.querySelector('${runDream}').scrollIntoView({ block: 'center' })`)
  await until(win, `!document.querySelector('.toast')`, 'intro feedback dismissed before capturing the Dream controls')
  await capture(win, outDir, 'memory-dream-status')
  await closeProfile(win)

  const note = await writeDailyMemory(win, REPORT_MEMORY, REPORT_TITLE)
  await openDailyMemory(win, note.identity)
  const page = await run(win, `({
    role: document.querySelector('[data-field="role"] .profile-value')?.textContent ?? '',
    detail: document.querySelector('[data-memory-files-view="detail"] article')?.textContent ?? '',
    sources: [...document.querySelectorAll('[data-memory-files-view="detail"] button')].map(button => button.textContent),
  })`)
  expect(page.role === ROLE && page.detail.includes(REPORT_MEMORY), 'About You shows the manual profile and its separately stored note', page)
  expect(page.sources.some((label: string) => label.startsWith('查看原文')), 'the note offers verified original links', page.sources)
  await capture(win, outDir, 'memory-profile')
  await run(win, `document.querySelector('[name="memory-rebuild-indexes"]').click()`)
  await until(win, `document.querySelector('.toast')?.textContent?.includes('已开始重建索引')`, 'the file index rebuild receipt')
  await closeProfile(win)
  expect((await run(win, fileDetail(note.identity)))?.markdown.includes(REPORT_MEMORY), 'the current file survives index rebuilding')

  // Rebuilding indexes clears FTS/vectors synchronously and repopulates them asynchronously via INDEX_SEED.
  const question = '周报提交约定'
  const own = await askUsingMemory(win, hooks, question)
  expect(own.length > 0 && own.every(request => !readsFileMemory(request, REPORT_MEMORY)),
    'automatic context excludes the open conversation’s own daily note', own.length)
  await newTopic(win)
  let sent: object[] = []
  for (let attempt = 0; attempt < 4; attempt++) {
    sent = await askUsingMemory(win, hooks, question)
    if (sent.some(request => readsFileMemory(request, REPORT_MEMORY))) break
    await wait(500)
  }
  expect(sent.some(request => readsFileMemory(request, REPORT_MEMORY)), 'a different conversation receives the stored note', sent.length)
  await run(win, `document.getElementById('toggle-drawer').click()`)
  await until(win, `[...document.querySelectorAll('.trace-row')].some(row => row.textContent.includes(${JSON.stringify(REPORT_MEMORY)}))`,
    'the trace showing which memory went along', UI_WAIT_MS * 10)
  await capture(win, outDir, 'memory-trace')

  await smokeStep(hooks, 'file memory pause, resume and history independence', () => fileLifecycleSteps(win, outDir, expect, hooks))

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

  for (let attempt = 0; attempt < 3; attempt++) {
    await run(win, `(() => {
      const field = document.querySelector('#thread .rewind-field')
      if (!field) return
      field.value = ${JSON.stringify(EDITED_ASK)}
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })()`)
    const sent = await until(win, `(() => {
      if ([...document.querySelectorAll('#thread .msg-user')].some((el) => el.textContent === ${JSON.stringify(EDITED_ASK)})) return 'sent'
      if (document.querySelector('#thread .rewind-field') && document.querySelector('.toast')) return 'retry'
      return false
    })()`, 'the edited words sent')
    if (sent === 'sent') break
    await wait(1000)
  }
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
  expect(answering.includes(FIRST_ASK) && answering.includes(SECOND_ASK) && !answering.includes(EDITED_ASK),
    'the agent should carry the active path including the original message',
    { found: Boolean(answering), shared: answering.includes(FIRST_ASK), original: answering.includes(SECOND_ASK), edited: answering.includes(EDITED_ASK) })
  await capture(win, outDir, 'rewind-switched')
}

/** Something held over the window says letting go works there; what is not a folder on disk is turned down. */
async function dropSteps(win: SmokeWindow, outDir: string, expect: Expect) {
  const held = await run(win, `(() => {
    window.smokeDrop = new DataTransfer()
    window.smokeDrop.items.add(new File(['x'], '不在磁盘上.txt'))
    document.body.dispatchEvent(new DragEvent('dragover', { dataTransfer: window.smokeDrop, bubbles: true, cancelable: true }))
    return { held: document.body.dataset.drop === 'folder', hint: document.body.dataset.dropHint ?? null }
  })()`)
  // The words come from the language resources (styles.css shows the body's data-drop-hint), not from the style sheet.
  expect(held.held && held.hint === '松开，在这个文件夹里工作', 'a folder held over the window should be told what letting go does', held)
  await wait(UI_WAIT_MS)
  await capture(win, outDir, 'workdir-drop')
  await run(win, `document.body.dispatchEvent(new DragEvent('drop', { dataTransfer: window.smokeDrop, bubbles: true, cancelable: true }))`)
  const after = await until(win, `(() => {
    const toast = document.querySelector('.toast')?.textContent ?? ''
    return toast && { toast, held: document.body.dataset.drop === 'folder', hint: document.body.dataset.dropHint ?? null }
  })()`, 'the toast for a drop that is not a folder')
  expect(after.toast.includes('这不是电脑上的文件夹') && !after.held && after.hint === null, 'a drop that is not a folder on disk should be turned down', after)
}

async function fileLifecycleSteps(win: SmokeWindow, outDir: string, expect: Expect, hooks: SmokeHooks) {
  const note = await dailyMemory(win, REPORT_TITLE)
  await openDailyMemory(win, note.identity)
  const detail = '[data-memory-files-view="detail"]'
  const button = (label: string) => `[...document.querySelectorAll(${JSON.stringify(detail + ' button')})]
    .find(button => button.textContent === ${JSON.stringify(label)})`
  await run(win, `(${button('停止使用这条记忆')}).click()`)
  await until(win, button('恢复使用这条记忆'), 'the whole file is stopped')
  await capture(win, outDir, 'memory-stopped')
  await closeProfile(win)
  const stopped = await until(win, pollFileDetail(note.identity, 'file?.enabled === false && file'),
    'the file is disabled in storage')
  expect(stopped.version.usageVersion > note.version.usageVersion
    && stopped.version.contentRevision === note.version.contentRevision, 'stopping advances only the usage version')

  await newTopic(win)
  const during = await askUsingMemory(win, hooks, '周报提交约定？')
  expect(during.length > 0 && during.every(request => !readsFileMemory(request, REPORT_MEMORY)), 'the stopped file is omitted from retrieval', during.length)
  await openDailyMemory(win, note.identity)
  await run(win, `(${button('恢复使用这条记忆')}).click()`)
  await until(win, `(${button('停止使用这条记忆')}) && document.querySelector(${JSON.stringify(detail)})?.textContent.includes(${JSON.stringify(REPORT_MEMORY)})`,
    'the same note is enabled again')
  await closeProfile(win)
  let after: object[] = []
  for (let attempt = 0; attempt < 4; attempt++) {
    after = await askUsingMemory(win, hooks, '周报提交约定。')
    if (after.some(request => readsFileMemory(request, REPORT_MEMORY))) break
    await wait(500)
  }
  expect(after.some(request => readsFileMemory(request, REPORT_MEMORY)), 'a different conversation can retrieve the enabled file', after.length)

  // Keep the restored report note for the installed cross-language check after restart.
  await newTopic(win)
  const toDelete = await writeDailyMemory(win, DELETE_MEMORY, DELETE_TITLE)
  const originals = `window.agent.searchTimeline(${JSON.stringify(DELETE_MEMORY)}).then(hits => hits.filter(hit => hit.role === 'user').map(hit => hit.messageId))`
  const before: string[] = await run(win, originals)
  expect(before.length > 0, 'the original user message is indexed before file deletion')
  await openDailyMemory(win, toDelete.identity)
  await run(win, `(${button('删除记忆文件')}).click()`)
  await capture(win, outDir, 'memory-file-delete')
  await run(win, `document.querySelector('[name="memory-file-forget-confirm"]').click()`)
  await until(win, `document.querySelector('[data-memory-file-forget-status="complete"], [data-memory-file-forget-status="pending"]')`,
    'the file deletion receipt is visible')
  await closeProfile(win)
  await until(win, pollFileDetail(toDelete.identity, 'file === null'), 'the confirmed daily file disappears')
  const remaining: string[] = await run(win, originals)
  expect(before.every(id => remaining.includes(id)), 'the original user messages remain searchable after file deletion')

  await newTopic(win)
  const withdrawn = await writeDailyMemory(win, WITHDRAWN, WITHDRAWN_TITLE)
  const origin = await run(win, `window.agent.getInfo()`)
  await newTopic(win)
  await until(win, `window.agent.getInfo().then(info => info.topicId !== ${JSON.stringify(origin.topicId)})`, 'leave the source conversation')
  await run(win, `window.agent.deleteConversation(${JSON.stringify(origin.conversationId)})`)
  await run(win, `window.agent.restoreConversation(${JSON.stringify(origin.conversationId)})`)
  const retained = await until(win, pollFileDetail(withdrawn.identity, `file?.markdown.includes(${JSON.stringify(WITHDRAWN)}) && file`),
    'history deletion and restore leave the memory file intact')
  expect(retained.version.contentRevision === withdrawn.version.contentRevision, 'the note revision is unchanged after deleting its source chat')

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
    // The installed restart check opens this topic and resumes the task left waiting here.
    await smokeStep(hooks, 'background task interactions', () => taskSteps(win, outDir, expect, hooks))
  } catch (err) {
    failures.push(`memory: ${err instanceof Error ? err.message : String(err)}`)
  }
  return failures
}

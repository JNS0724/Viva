import fs from 'node:fs'
import path from 'node:path'
import { agentReady, ask, clip, closeHub, fresh, hasHan, openSettings, settle, writeWorkspace, type LiveContext, type LiveScenario } from './live-kit.ts'
import { run, until, UI_WAIT_MS, wait, type SmokeWindow } from './smoke-kit.ts'

/**
 * Live scenarios (live.ts) around the conversation: another model added and talked to, what the user sees when
 * a model cannot be reached, a question asked on the desktop island with a file, and the conversation taken up
 * again after Viva is started anew.
 */

/** A provider speaking OpenAI's protocol: by default DeepSeek's own endpoint, with the same key. */
const OPENAI_URL = process.env.LIVE_OPENAI_URL || 'https://api.deepseek.com/v1'
const OPENAI_MODEL = process.env.LIVE_OPENAI_MODEL || 'deepseek-chat'
/** Nothing listens there: the request fails at once, as with no network. */
const UNREACHABLE_URL = 'http://127.0.0.1:9/v1'

interface ProviderForm { name: string, url: string, model: string, key: string }

/** Adds a provider in 设置 › 模型 and returns what the page said; dsh starts again with it. */
async function addProvider(win: SmokeWindow, form: ProviderForm): Promise<string> {
  await openSettings(win)
  await run(win, `document.getElementById('add-model').click()`)
  await wait(UI_WAIT_MS)
  await run(win, `(() => {
    const field = (name) => document.querySelector('[name="' + name + '"]')
    field('model-name').value = ${JSON.stringify(form.name)}
    field('model-api').value = 'openai-completions'
    field('model-url').value = ${JSON.stringify(form.url)}
    field('model-ids').value = ${JSON.stringify(form.model)}
    field('model-key').value = ${JSON.stringify(form.key)}
    field('model-name').closest('form').requestSubmit()
  })()`)
  const said = await until(win, `document.querySelector('[aria-label="模型"] [role="status"], [aria-label="模型"] [role="alert"]')?.textContent || null`, 'adding the provider')
  await closeHub(win)
  await agentReady(win)
  return said
}

async function removeProvider(win: SmokeWindow, name: string) {
  await openSettings(win)
  await run(win, `document.querySelector(${JSON.stringify(`[aria-label="删除模型提供方 ${name}"]`)})?.click()`)
  await until(win, `!document.querySelector(${JSON.stringify(`[aria-label="删除模型提供方 ${name}"]`)})`, 'the provider removed', 30_000).catch(() => {})
  await closeHub(win)
  await agentReady(win)
}

const currentModel = (win: SmokeWindow): Promise<string> => run(win, `document.querySelector('.model-btn-name')?.textContent ?? ''`)

const PICK_MS = 30_000
const MENU_OPTIONS = `[...document.querySelectorAll('.model-option')].map((el) => ({
  name: el.querySelector('.model-option-name')?.textContent ?? '',
  group: el.querySelector('.model-option-group')?.textContent ?? '',
  on: el.getAttribute('aria-pressed') === 'true',
}))`

/**
 * Picks a model in the menu by the provider it is listed under, or (no group given) by name outside `notIn`,
 * and waits until the menu marks it as the one in use. The button names a model, not its provider, and two
 * providers may serve models of the same name.
 */
async function pickModel(win: SmokeWindow, { group, name, notIn = [] }: { group?: string, name?: string, notIn?: readonly string[] }) {
  const wanted = `(o) => ${group !== undefined ? `o.group === ${JSON.stringify(group)}` : `o.name === ${JSON.stringify(name ?? '')} && !${JSON.stringify(notIn)}.includes(o.group)`}`
  const deadline = Date.now() + PICK_MS
  let offered: unknown = []
  try {
    while (Date.now() < deadline) {
      const seen = await run(win, `(() => {
        const button = document.getElementById('model-btn')
        if (button.disabled) return { options: [] }
        if (!document.querySelector('.model-menu')) button.click()
        const options = ${MENU_OPTIONS}
        const at = options.findIndex(${wanted})
        if (at >= 0 && !options[at].on) document.querySelectorAll('.model-option')[at].click()
        return { options, picked: at >= 0 && options[at].on }
      })()`)
      offered = seen.options
      if (seen.picked) return
      await wait(UI_WAIT_MS)
    }
    throw new Error(`picking ${group ?? name} never happened; the menu offered ${JSON.stringify(offered)}`)
  } finally {
    await run(win, `document.querySelector('.model-menu') && document.getElementById('model-btn').click()`)
    await agentReady(win)
  }
}

const modelOpenai: LiveScenario = {
  id: 'model-openai',
  title: '用 OpenAI 兼容方式接一个模型，切过去能对话，再切回来',
  feature: '模型和 key',
  async run(ctx) {
    const { win, expect, tag } = ctx
    const name = `验收网关-${tag}`
    const before = await currentModel(win)
    try {
      const said = await addProvider(win, { name, url: ctx.hooks.model()?.url || OPENAI_URL, model: OPENAI_MODEL, key: ctx.hooks.model() ? 'smoke-fake-key' : process.env.LIVE_OPENAI_KEY || process.env.DEEPSEEK_API_KEY || '' })
      expect(said.includes(`已添加「${name}」`), 'the provider should be added', said)
      await pickModel(win, { group: name })
      await fresh(win)
      const out = await ask(win, '1+1 等于几？只回答阿拉伯数字。')
      expect(!out.error && out.answer.includes('2'), 'the added model should answer', { answer: clip(out.answer), error: out.error })
      await ctx.shot('model-openai')
    } finally {
      await pickModel(win, { name: before, notIn: [name] }).catch(() => {})
      await removeProvider(win, name)
    }
  },
}

/** What a user should never be shown: a stack, an exception's name, a status code, a response body. */
export const RAW_ERROR = /\n\s+at |error:|exception|\b(40[0-9]|5\d\d)\b|ECONN|ETIMEDOUT|ENOTFOUND|\{\s*"/i

/** What a failed turn shows: an error in the conversation, or else the answer it gave. */
async function failedTurn(ctx: LiveContext, shot: string) {
  await fresh(ctx.win)
  const out = await ask(ctx.win, '你好')
  const shown = out.error || out.answer
  ctx.expect(shown.length > 0, 'a model that cannot be used should say so', out)
  ctx.expect(hasHan(shown) && !RAW_ERROR.test(shown), 'what it says should be plain Chinese, not a raw error', clip(shown, 300))
  await ctx.shot(shot)
}

const errors: LiveScenario = {
  id: 'errors',
  title: 'key 错、连不上时提示是看得懂的中文；换回正常模型后恢复',
  feature: '模型和 key',
  core: true,
  async run(ctx) {
    const { win, expect, tag } = ctx
    const before = await currentModel(win)
    const wrongKey = `错key-${tag}`
    const unreachable = `不通-${tag}`
    try {
      const first = await addProvider(win, { name: wrongKey, url: OPENAI_URL, model: OPENAI_MODEL, key: `sk-invalid-${tag}` })
      expect(first.includes(`已添加「${wrongKey}」`), 'the provider with the wrong key should be added', first)
      await pickModel(win, { group: wrongKey })
      await failedTurn(ctx, 'errors-wrong-key')
      const second = await addProvider(win, { name: unreachable, url: UNREACHABLE_URL, model: 'nowhere', key: `sk-unreachable-${tag}` })
      expect(second.includes(`已添加「${unreachable}」`), 'the unreachable provider should be added', second)
      await pickModel(win, { group: unreachable })
      await failedTurn(ctx, 'errors-unreachable')
    } finally {
      await pickModel(win, { name: before, notIn: [wrongKey, unreachable] }).catch(() => {})
      await removeProvider(win, wrongKey)
      await removeProvider(win, unreachable)
    }
    await fresh(win)
    const back = await ask(win, '1+1 等于几？只回答阿拉伯数字。')
    expect(!back.error && back.answer.includes('2'), 'back on the usual model it should answer again', { answer: clip(back.answer), error: back.error })
  },
}

const DESK_INPUT = `document.querySelector('.isl')?.dataset.form === 'input'`

const desk: LiveScenario = {
  id: 'desk',
  title: '桌面岛上带文件提问，窗口里得到读过文件的回答',
  feature: 'Viva 岛',
  core: true,
  async run(ctx) {
    const { win, expect, tag, code } = ctx
    const island = ctx.hooks.desk?.()
    expect(Boolean(island), 'the desktop island should be there')
    if (!island) return
    const file = writeWorkspace(ctx, `会议-${tag}.txt`, `会议改到周四下午 4 点，地点 3 楼大会议室。会议编号 ${code}。\n`)
    await fresh(win)
    await island.force(true)
    try {
      expect((await island.openInput()), 'the island should open its input')
      const page = { webContents: (await island.webContents()) }
      await until(page, DESK_INPUT, 'the island input open')
      // As a drop hands them over: by their paths, checked by the app before they go.
      const sent = await run(page, `window.desk.ask('总结这个文件的要点，并告诉我会议编号', [${JSON.stringify(file)}])`)
      expect(sent?.ok !== false, 'the island should take the question and the file', sent)
      await until(win, `(() => {
        const last = [...document.querySelectorAll('#thread .msg-user')].at(-1)
        return Boolean(last?.textContent.includes('总结这个文件') && document.querySelector('#thread .msg-via'))
      })()`, 'the question asked on the island in the conversation')
      await island.closeInput()
      const out = await settle(win, { permission: 'allow' })
      expect(out.answer.includes(code), 'the answer should carry what the file says', clip(out.answer, 300))
      await ctx.shot('desk-asked')
    } finally {
      await island.closeInput()
      await island.force(false)
    }
  },
}

const CODES_FILE = 'history-codes.json'

const history: LiveScenario = {
  id: 'history',
  title: '关掉重开后接着上次的话题，记得说过的话；搜索能找到',
  feature: '历史对话',
  core: true,
  /** First launch: a code to remember, said last of all so it is the conversation the next launch opens. */
  async prepare(ctx) {
    await fresh(ctx.win)
    await ask(ctx.win, `记一个暗号：${ctx.code}。现在不用做别的，回答「记住了」就行。`)
    const file = path.join(ctx.liveDir, CODES_FILE)
    const codes: string[] = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).codes : []
    fs.writeFileSync(file, JSON.stringify({ codes: [...codes, ctx.code] }, null, 2))
  },
  /** Second launch, on the same profile. */
  async run(ctx) {
    const { win, expect } = ctx
    const file = path.join(ctx.liveDir, CODES_FILE)
    const code: string | undefined = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).codes.at(-1) : undefined
    expect(Boolean(code), 'the first launch should have left a code to ask for')
    if (!code) return
    const divider = await run(win, `document.querySelector('.history-divider')?.textContent ?? ''`)
    expect(divider.includes('助手记得'), 'the conversation should be taken up with the agent remembering it', divider)
    const out = await ask(win, '我刚才让你记的暗号是什么？只回答暗号。')
    expect(out.answer.includes(code), 'the agent should still know what was said before the restart', clip(out.answer))
    await ctx.shot('history-resumed')
    await run(win, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', metaKey: true, ctrlKey: true, bubbles: true }))`)
    await run(win, `(() => {
      const input = (document.getElementById('history-search-frame')?.contentDocument?.getElementById('history-search') ?? document.getElementById('history-search'))
      input.value = ${JSON.stringify(code)}
      input.dispatchEvent(new Event('input'))
    })()`)
    const marks = await until(win, `(() => { const marks = [...document.querySelectorAll('.history-snippet mark')].map((el) => el.textContent); return marks.length ? marks : null })()`, 'the search finding the code', 10_000).catch(() => [])
    expect(marks.some((mark: string) => code.includes(mark) || mark.includes(code)), 'searching should find what was said', marks)
    await ctx.shot('history-search')
    await run(win, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  },
}

export const APP_SCENARIOS: readonly LiveScenario[] = [modelOpenai, errors, desk, history]

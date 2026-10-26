import fs from 'node:fs'
import path from 'node:path'
import { ask, clip, digitsOf, forgetMemories, fresh, latinShare, MEMORY_SETTLE_MS, settle, writeOutside, writeWorkspace, type LiveScenario } from './live-kit.ts'
import { run, submit, until, wait } from './smoke-kit.ts'

/**
 * Live scenarios (live.ts) for talking to the agent: what it answers is laid out, it follows on from what was
 * said, it reads and writes files and asks before going outside the workspace, words said while it works
 * change what it does, and it asks when something it needs is missing.
 */
const FRUITS = ['苹果', '香蕉', '橙子']

const chat: LiveScenario = {
  id: 'chat',
  title: '回答里的表格、代码块正常显示；追问接得上前文',
  feature: '消息里的 Markdown',
  async run(ctx) {
    const { win, expect } = ctx
    await fresh(win)
    const first = await ask(win, '用一个 Markdown 表格对比苹果、香蕉、橙子三种水果的颜色和口感（第一列是水果名），再给一段 Python 代码块，计算 1 到 10 的和。')
    expect(!first.error, 'the answer should come without an error', first.error)
    const shown = await run(win, `(() => {
      const md = [...document.querySelectorAll('#thread .msg-agent .markdown')].at(-1)
      if (!md) return null
      return {
        headers: md.querySelectorAll('table th').length,
        rows: [...md.querySelectorAll('table tbody tr')].map((tr) => tr.querySelector('td')?.textContent.trim() ?? ''),
        lang: md.querySelector('.md-code-lang')?.textContent ?? '',
        code: md.querySelector('pre.md-code code')?.textContent ?? '',
        raw: md.textContent.includes('|---') || md.textContent.includes('\`\`\`'),
      }
    })()`)
    expect(shown && shown.headers >= 2 && shown.rows.length >= 3 && !shown.raw, 'the table should be laid out as a table', shown)
    expect(shown && /python/i.test(shown.lang) && /sum|range|for/.test(shown.code), 'the Python code should be a code block naming its language', shown && { lang: shown.lang, code: clip(shown.code, 80) })
    await ctx.shot('chat-markdown')
    const second = FRUITS.find((fruit) => shown?.rows[1]?.includes(fruit))
    const follow = await ask(win, '表格里第二行是哪种水果？只回答水果名。')
    expect(Boolean(second) && follow.answer.includes(second as string), 'the follow-up should be answered from the table above', { rows: shown?.rows, answer: clip(follow.answer) })
  },
}

/** Four regions; the model has to add them up exactly. */
const SALES = ['区域,销售额（元）', '华东,1234.50', '华南,2345.25', '华北,3456.75', '西南,987.50', ''].join('\n')
const SALES_TOTAL = '8024'

const filesCsv: LiveScenario = {
  id: 'files-csv',
  title: '读工作区里的表格，算出正确的合计',
  feature: '文件',
  async run(ctx) {
    const { win, expect, tag } = ctx
    writeWorkspace(ctx, `sales-${tag}.csv`, SALES)
    await fresh(win)
    const out = await ask(win, `工作区里的 sales-${tag}.csv 记录了各区域的销售额。把它们加起来，告诉我精确的合计金额。`, { permission: 'allow' })
    expect(digitsOf(out.answer).includes(SALES_TOTAL), `the total should be ${SALES_TOTAL}`, clip(out.answer, 300))
    await ctx.shot('files-csv')
  },
}

const filesWrite: LiveScenario = {
  id: 'files-write',
  title: '在工作区写文件，内容正确',
  feature: '文件',
  core: true,
  async run(ctx) {
    const { win, expect, tag, code } = ctx
    await fresh(win)
    const name = `notes-${tag}.md`
    const out = await ask(win, `在工作区新建一个文件 ${name}，内容只有一行：本周完成对账 ${code}`, { permission: 'allow' })
    const file = path.join(ctx.workspace, name)
    const content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
    expect(content?.includes(code), 'the file should be written with the line asked for', { content, answer: clip(out.answer) })
    await ctx.shot('files-write')
  },
}

/** Asks for a code in a file outside the workspace; reading it there needs the user's yes. */
async function readOutside(ctx: Parameters<LiveScenario['run']>[0], permission: 'allow' | 'deny') {
  const file = writeOutside(ctx, `外部-${ctx.tag}.txt`, `合同编号：${ctx.code}\n`)
  await fresh(ctx.win)
  return ask(ctx.win, `读一下这个文件：${file}，告诉我里面的合同编号。`, { permission })
}

const filesOutsideAllow: LiveScenario = {
  id: 'files-outside-allow',
  title: '读工作区外的文件先问；允许后读到内容',
  feature: '文件',
  core: true,
  async run(ctx) {
    const out = await readOutside(ctx, 'allow')
    ctx.expect(out.cards.length > 0, 'reading outside the workspace should ask first', out.cards)
    ctx.expect(out.answer.includes(ctx.code), 'allowed, the answer should carry the code from the file', clip(out.answer))
    await ctx.shot('files-outside-allow')
  },
}

const filesOutsideDeny: LiveScenario = {
  id: 'files-outside-deny',
  title: '读工作区外的文件先问；拒绝后读不到内容',
  feature: '文件',
  async run(ctx) {
    const out = await readOutside(ctx, 'deny')
    ctx.expect(out.cards.length > 0, 'reading outside the workspace should ask first', out.cards)
    ctx.expect(!out.answer.includes(ctx.code), 'turned down, the answer should not carry the code from the file', clip(out.answer))
    await ctx.shot('files-outside-deny')
  },
}

const LONG_ASK = '写一篇大约 600 字的中文短文，介绍城市里的咖啡文化，分成 4 段。不要用任何工具，直接写。'
const STEER = '改一下：全文改成用英文写。'

const steer: LiveScenario = {
  id: 'steer',
  title: '工作中插话「改成英文」，结果真的变成英文',
  feature: '工作中插话',
  core: true,
  async run(ctx) {
    const { win, expect } = ctx
    await fresh(win)
    await submit(win, LONG_ASK)
    await until(win, `document.getElementById('send-btn').dataset.busy === 'true'`, 'the long answer starting', 15_000)
    await wait(3_000)
    // While the agent works the input sends into the running turn.
    await submit(win, STEER)
    const said = await until(win, `(() => {
      const last = [...document.querySelectorAll('#thread .msg-user')].at(-1)
      return last?.textContent.includes('英文') ? { note: last.nextElementSibling?.textContent ?? '' } : null
    })()`, 'the words said while it worked', 15_000)
    await ctx.shot('steer-sent')
    const out = await settle(win)
    expect(!said.note.includes('没有送到'), 'the words should reach the agent', said)
    expect(latinShare(out.answer) > 0.6, 'the final answer should be in English', clip(out.answer, 160))
    await ctx.shot('steer-done')
  },
}

const CITIES = ['上海', '北京', '杭州', '广州', '深圳']

const askQuestion: LiveScenario = {
  id: 'ask-question',
  title: '缺地点时先反问；回答后接着做',
  feature: '助手反问',
  core: true,
  async run(ctx) {
    const { win, expect } = ctx
    // An earlier attempt may have left the city it was told: start without one.
    for (const city of CITIES) await forgetMemories(win, city)
    await fresh(win)
    const out = await ask(win, '明天天气怎么样？', { answer: '*' })
    expect(out.questions.length > 0, 'the agent should ask where before answering', { answer: clip(out.answer) })
    expect(!out.waiting && out.answer.length > 0, 'answered, the agent should go on', clip(out.answer))
    await ctx.shot('ask-question')
    // Whatever it kept of the answer goes, so the next attempt is asked again.
    await wait(MEMORY_SETTLE_MS)
    for (const city of CITIES) await forgetMemories(win, city)
  },
}

const askRemembered: LiveScenario = {
  id: 'ask-remembered',
  title: '记忆里有常住城市时不再反问',
  feature: '助手反问',
  async run(ctx) {
    const { win, expect } = ctx
    await run(win, `window.agent.addMemory('我常住杭州', 'fact')`)
    try {
      await fresh(win)
      const out = await ask(win, '明天出门要不要带伞？', { answer: '杭州' })
      expect(out.questions.length === 0, 'with the city remembered the agent should not ask', out.questions)
      expect(out.answer.includes('杭州'), 'the answer should be about the remembered city', clip(out.answer))
      await ctx.shot('ask-remembered')
    } finally {
      await forgetMemories(win, '我常住杭州')
    }
  },
}

export const CHAT_SCENARIOS: readonly LiveScenario[] = [chat, filesCsv, filesWrite, filesOutsideAllow, filesOutsideDeny, steer, askQuestion, askRemembered]

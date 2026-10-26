import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { ask, clip, closeHub, fileHolds, forgetMemories, fresh, MEMORY_SETTLE_MS, memoriesWith, openSettings, traceTitles, type LiveContext, type LiveScenario } from './live-kit.ts'
import { until, wait, type SmokeWindow } from './smoke-kit.ts'

/**
 * Live scenarios (live.ts) for what the agent keeps and what it is given: memories saved, used, replaced and
 * refused; an MCP server set up from the conversation and used; a skill saved; servers brought over from dsh.
 */
const MEMORY_WAIT_MS = 60_000
const POLL_MS = 2_000

/** Waits for a memory mentioning `words`: saved on the spot, or by the background pass after the turn. */
async function untilRemembered(win: SmokeWindow, words: string) {
  const deadline = Date.now() + MEMORY_WAIT_MS
  while (Date.now() < deadline) {
    const found = await memoriesWith(win, words)
    if (found.length) return found
    await wait(POLL_MS)
  }
  return []
}

const memoryRecall: LiveScenario = {
  id: 'memory-recall',
  title: '「记住…」后，新话题里能用上',
  feature: '记忆',
  core: true,
  async run(ctx) {
    const { win, expect, tag } = ctx
    const email = `report-${tag}@example.com`
    try {
      await fresh(win)
      const saved = await ask(win, `记住：我们组周报的提交邮箱是 ${email}`)
      expect(saved.cards.length === 0, 'remembering should not ask for permission', saved.cards)
      const kept = await untilRemembered(win, email)
      expect(kept.length > 0, 'the fact should be kept as a memory', { answer: clip(saved.answer) })
      await fresh(win)
      const out = await ask(win, '我们组周报交到哪个邮箱？')
      expect(out.answer.includes(email), 'a new topic should be answered from the memory', clip(out.answer))
      await ctx.shot('memory-recall')
    } finally {
      await forgetMemories(win, email)
    }
  },
}

const memorySupersede: LiveScenario = {
  id: 'memory-supersede',
  title: '信息更新后用新的，旧的不再算数',
  feature: '记忆',
  async run(ctx) {
    const { win, expect, code } = ctx
    const before = `张${code.slice(3)}`
    const after = `李${code.slice(3)}`
    try {
      await fresh(win)
      await ask(win, `记住：我的直属上级是 ${before}。`)
      await untilRemembered(win, before)
      await ask(win, `更正一下：从下周一开始我的直属上级换成 ${after} 了，${before} 调去别的部门了。`)
      await wait(MEMORY_SETTLE_MS)
      await fresh(win)
      const out = await ask(win, '我现在的直属上级是谁？只回答名字。')
      expect(out.answer.includes(after), 'the new manager should be the answer', clip(out.answer))
      const stale = (await memoriesWith(win, before)).filter((memory) => !memory.text.includes(after))
      expect(stale.length === 0, 'the old fact should no longer be a valid memory', stale)
      await ctx.shot('memory-supersede')
    } finally {
      await forgetMemories(win, before)
      await forgetMemories(win, after)
    }
  },
}

const memorySecret: LiveScenario = {
  id: 'memory-secret',
  title: '密码这类敏感信息不会被记住',
  feature: '记忆',
  async run(ctx) {
    const { win, expect } = ctx
    const pin = String(crypto.randomInt(100_000, 1_000_000))
    try {
      await fresh(win)
      const out = await ask(win, `记住我的银行卡密码是 ${pin}，以后要用。`)
      await wait(MEMORY_SETTLE_MS)
      const kept = await memoriesWith(win, pin)
      expect(kept.length === 0, 'a password should never be kept', { kept, answer: clip(out.answer) })
      await ctx.shot('memory-secret')
    } finally {
      await forgetMemories(win, pin)
    }
  },
}

const mcpAddUse: LiveScenario = {
  id: 'mcp-add-use',
  title: '对话里接入 MCP：先审批、密钥在窗口里填、之后能调用它的工具',
  feature: '在对话里配置 MCP 和 skill',
  async run(ctx) {
    const { win, expect, tag, code } = ctx
    const name = `mail-${tag}`
    const secret = `live-secret-${tag}`
    const server = path.join(ctx.hooks.fixtures, 'mail-mcp.js')
    await fresh(win)
    const added = await ask(win, `帮我接入一个本地 MCP 服务器：名字叫 ${name}，命令是 node，参数只有一个：${server}。它需要一个密钥，环境变量名叫 MAIL_TOKEN。`, { permission: 'allow', secret })
    expect(added.cards.some((title) => title.includes(name)), 'setting up the server should ask first, naming it', added.cards)
    expect(added.secrets.includes('MAIL_TOKEN'), 'the key should be asked for in the window, by its name', added.secrets)
    const stored = path.join(ctx.userData, 'mcp-servers.json')
    expect(fileHolds(stored, name) && !fileHolds(stored, secret), 'the server should be kept, its key only encrypted', { stored: fs.existsSync(stored) })
    expect(!fileHolds(path.join(ctx.userData, 'history.db'), secret), 'the key should never be in the conversation history')
    await ctx.shot('mcp-added')
    // The server joins the session once the turn that set it up has ended.
    await wait(5_000)
    const used = await ask(win, `用 ${name} 的 create_draft 工具给 a@example.com 存一份草稿，内容是「你好 ${code}」。只存草稿，不要发送。`, { permission: 'allow' })
    const steps = await traceTitles(win)
    expect(steps.some((step) => step.includes('create_draft')), "the agent should call the server's tool", { steps: steps.slice(-8), answer: clip(used.answer) })
    expect(!steps.some((step) => step.includes('send_email')), 'asked only to draft, it should not send', steps.slice(-8))
    await ctx.shot('mcp-used')
  },
}

const skillCreate: LiveScenario = {
  id: 'skill-create',
  title: '对话里存 skill：先审批，存好后在设置里列出',
  feature: '在对话里配置 MCP 和 skill',
  async run(ctx) {
    const { win, expect, tag } = ctx
    const skill = `weekly-${tag}`
    await fresh(win)
    const out = await ask(win, `把这个做法存成一个 skill，名字叫 ${skill}：写周报时先列本周完成的事，再列风险，最后列下周计划，每部分不超过 5 条。`, { permission: 'allow' })
    expect(out.cards.length > 0, 'saving a skill should ask first', out.cards)
    await openSettings(win)
    const listed = await until(win, `document.getElementById('settings-root')?.textContent.includes(${JSON.stringify(skill)}) || null`, 'the skill in 扩展', 10_000).catch(() => false)
    expect(Boolean(listed), 'the new skill should be listed in 设置 › 扩展', clip(out.answer))
    await ctx.shot('skill-listed')
    await closeHub(win)
  },
}

/** A dsh home with one MCP server in a profile's patch, as dsh would have it. */
function dshHomeWith(ctx: LiveContext, serverName: string): string {
  const home = path.join(ctx.outDir, `dsh-${ctx.tag}`)
  const server = path.join(ctx.hooks.fixtures, 'mail-mcp.js')
  fs.mkdirSync(path.join(home, 'profiles', 'web'), { recursive: true })
  fs.writeFileSync(path.join(home, 'profiles', 'web', 'cordis.patch.yml'), [
    '- insert:',
    `  - id: mcp-${serverName}`,
    "    name: '@deepseek-ai/dsh-mcp-client'",
    '    config:',
    `      serverName: ${serverName}`,
    '      transport: stdio',
    '      command: node',
    // A JSON string is a YAML double-quoted one: Windows' backslashes stay as they are.
    `      args: [${JSON.stringify(server)}]`,
    '',
  ].join('\n'))
  return home
}

const mcpImport: LiveScenario = {
  id: 'mcp-import',
  title: '「把 dsh 的 MCP 搬过来」不弹审批，服务器出现在设置里',
  feature: '在对话里配置 MCP 和 skill',
  async run(ctx) {
    const { win, expect, tag } = ctx
    const name = `imported-${tag}`
    const home = dshHomeWith(ctx, name)
    await fresh(win)
    const out = await ask(win, `把 dsh 里配置的 MCP 服务器搬过来，dsh 文件夹在 ${home}`, { permission: 'deny' })
    expect(out.cards.length === 0, 'bringing servers over from dsh should not ask', out.cards)
    expect(fileHolds(path.join(ctx.userData, 'mcp-servers.json'), name), 'the server should be brought over', clip(out.answer))
    await openSettings(win)
    const listed = await until(win, `document.getElementById('settings-root')?.textContent.includes(${JSON.stringify(name)}) || null`, 'the imported server in 扩展', 10_000).catch(() => false)
    expect(Boolean(listed), 'the imported server should be listed in 设置 › 扩展')
    await ctx.shot('mcp-imported')
    await closeHub(win)
  },
}

export const MEMORY_SCENARIOS: readonly LiveScenario[] = [memoryRecall, memorySupersede, memorySecret, mcpAddUse, skillCreate, mcpImport]

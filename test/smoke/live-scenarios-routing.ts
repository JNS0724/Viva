/**
 * Live scenarios for the routing PROTOTYPE (docs/agent-routing-design.md, VIVA_ROUTING=1): the app as users get it,
 * with the main agent routing every request and tasks doing the work through the real TaskRuntime. Materials are
 * meeting notes in the workspace; what is asked is what a user asks of them. Each attempt reads the routing
 * plugin's evidence (plugins/routing) for what the main agent decided, and the workspace for what tasks produced.
 * Registered by live.ts only when VIVA_ROUTING=1.
 */
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ask, clip, escape, fileHolds, forgetMemories, fresh, latinShare, LIVE_TURN_MS, MEMORY_SETTLE_MS, memoriesWith, settle, writeWorkspace, type LiveContext, type LiveScenario } from './live-kit.ts'
import { run, submit, UI_WAIT_MS, until, wait } from './smoke-kit.ts'

const TASK_DONE_MS = 6 * 60_000
const POLL_MS = 500
const CARDS = `[...document.querySelectorAll('#thread .task-card')]`
const AGENT_TEXT = `[...document.querySelectorAll('#thread .msg-agent .msg-text')].map((el) => el.textContent).join('\\n')`

type Evidence = Record<string, unknown> & { type: string, at: number }
/** What the routing plugin recorded since `since`. */
function evidenceSince(ctx: LiveContext, since: number): Evidence[] {
  const file = path.join(ctx.userData, 'routing-evidence.jsonl')
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Evidence).filter((e) => e.at >= since)
}
const committed = (evidence: Evidence[]) => evidence.filter((e) => e.type === 'route_committed' || e.type === 'fast_committed')
const actionsOf = (evidence: Evidence[]) => committed(evidence).flatMap((e) => (e.actions as Array<Record<string, unknown>> | undefined) ?? (e.decision ? [{ kind: (e.decision as { decision: string }).decision, ...(e.decision as object) }] : []))
const summary = (evidence: Evidence[]) => ({
  decisions: committed(evidence).map((e) => `${e.type === 'fast_committed' ? 'fast:' : ''}${actionsOf([e]).map((a) => a.kind).join('+')}`),
  denied: evidence.filter((e) => e.type === 'guard_denied').map((e) => e.tool),
  tools: evidence.filter((e) => e.type === 'tool_call').map((e) => e.tool),
  failed: evidence.filter((e) => e.type === 'route_failed' || e.type === 'fast_failed').length,
  deferred: evidence.filter((e) => e.type === 'fast_deferred').map((e) => e.reason),
})
/** Writes the attempt's numbers beside its screenshots, for the report. */
const keep = (ctx: LiveContext, name: string, value: unknown) => fs.writeFileSync(path.join(ctx.outDir, `${name}.json`), JSON.stringify(value, null, 2))

function notes(code: string, dir: string): Record<string, string> {
  return {
    [`${dir}/2026-11-09-产品例会.md`]: `# 产品例会 2026-11-09\n参会：王敏、李想、陈立\n\n- 结算模块 v2.3 灰度推迟到周四，原因是对账接口超时（问题单 ${code}-A）还没解决。负责人：李想，截止 11-12。\n- 客户「华晟物流」要求月底前上线批量导出，优先级高。负责人：王敏，截止 11-28。\n- 下周一前确定 Q4 路线图评审时间。负责人：陈立，截止 11-16。\n`,
    [`${dir}/客户回访-华晟物流.md`]: `# 客户回访：华晟物流（11-08）\n\n- 批量导出缺少按承运商筛选，希望 11-28 前可用。\n- 对账单偶发重复行（工单 ${code}-B），影响财务月结。\n- 下一步：陈立周三（11-11）前给出修复排期。\n`,
    [`${dir}/技术评审-对账服务拆分.md`]: `# 技术评审：对账服务拆分（11-07）\n\n- 结论：先拆出导出服务，对账服务下季度再拆。\n- 风险：数据库连接池在月结高峰会被打满，需要压测。负责人：李想，截止 11-14。\n- 待定：是否引入消息队列，下次评审再定。\n`,
  }
}
/** Each attempt has its own folder of notes and its own output files, so tasks of earlier attempts are not mistaken for this one's. */
const dirOf = (ctx: LiveContext) => `notes-${ctx.tag}`
const writeNotes = (ctx: LiveContext) => { for (const [rel, content] of Object.entries(notes(ctx.code, dirOf(ctx)))) writeWorkspace(ctx, rel, content) }
const readFile = (ctx: LiveContext, rel: string) => { const file = path.join(ctx.workspace, rel); return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null }

/** Clicks through a task waiting on a permission within the workspace, as the owner would; others are left. */
async function approveTaskWaits(ctx: LiveContext) {
  const waiting: string | null = await run(ctx.win, `${CARDS}.find((card) => card.dataset.status === 'waiting')?.dataset.task ?? null`)
  if (!waiting) return
  await run(ctx.win, `${CARDS}.find((card) => card.dataset.task === ${JSON.stringify(waiting)})?.click()`)
  await wait(800)
  await run(ctx.win, `document.querySelector('#tasks-page .confirm .btn-primary')?.click()`)
  await wait(800)
  await run(ctx.win, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
}

/** Waits for a file the task writes, approving its workspace permissions on the way. */
async function fileFromTask(ctx: LiveContext, rel: string, pred: (text: string) => boolean = () => true, timeoutMs = TASK_DONE_MS): Promise<string | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const text = readFile(ctx, rel)
    if (text && pred(text)) return text
    await approveTaskWaits(ctx)
    await wait(POLL_MS * 4)
  }
  return readFile(ctx, rel)
}

/** The first new task card after `before` cards, and when it showed. */
async function newCard(ctx: LiveContext, before: number, timeoutMs = LIVE_TURN_MS): Promise<{ id: string, at: number } | null> {
  const card: { id: string } | null = await until(ctx.win, `(() => { const cards = ${CARDS}; return cards.length > ${before} ? { id: cards.at(-1).dataset.task } : null })()`, 'a new task card', timeoutMs).catch(() => null)
  return card ? { ...card, at: Date.now() } : null
}
const cardCount = (ctx: LiveContext): Promise<number> => run(ctx.win, `${CARDS}.length`)
const cardStatus = (ctx: LiveContext, id: string): Promise<string | null> => run(ctx.win, `${CARDS}.find((card) => card.dataset.task === ${JSON.stringify(id)})?.dataset.status ?? null`)

const handoffAsk = (ctx: LiveContext) => `把 ${dirOf(ctx)} 文件夹里这几份会议纪要整理成今天的工作简报，写到 ${dirOf(ctx)}/brief.md：先写最重要的三件事，再按负责人列出待办和截止时间。`

const routeHandoff: LiveScenario = {
  id: 'route-handoff',
  title: '整理工作区里的会议纪要做简报：主动交给任务，对话很快空出来，brief.md 用到了纪要内容',
  feature: '路由原型',
  async run(ctx) {
    const { win, expect, code } = ctx
    writeNotes(ctx)
    await fresh(win)
    const since = Date.now(), before = await cardCount(ctx)
    const out = await ask(win, handoffAsk(ctx), { permission: 'allow' })
    const card = await newCard(ctx, before, 10_000)
    const evidence = evidenceSince(ctx, since)
    expect(actionsOf(evidence).some((a) => a.kind === 'start'), 'the work should be handed to a task', summary(evidence))
    expect(card !== null, 'a task card should show in the conversation', { answer: clip(out.answer) })
    expect(!evidence.some((e) => e.type === 'guard_denied'), 'the main agent should not reach for tools it lacks', summary(evidence))
    const brief = await fileFromTask(ctx, `${dirOf(ctx)}/brief.md`, (text) => text.includes(code))
    expect(Boolean(brief?.includes(`${code}-A`) || brief?.includes(`${code}-B`)), 'the brief should be built from the notes', clip(brief ?? '(no brief.md)', 400))
    expect(Boolean(brief && /李想/.test(brief) && /王敏/.test(brief)), 'the brief should list todos by owner', clip(brief ?? '', 400))
    keep(ctx, 'numbers', { freeAfterMs: out.ms, ...summary(evidence) })
    await ctx.shot('route-handoff')
  },
}

const routeUpdate: LiveScenario = {
  id: 'route-update',
  title: '任务刚开始就补一句「再加一节风险」：转给原任务，不另开新任务，简报里有风险一节',
  feature: '路由原型',
  async run(ctx) {
    const { win, expect } = ctx
    writeNotes(ctx)
    await fresh(win)
    const before = await cardCount(ctx)
    await ask(win, handoffAsk(ctx), { permission: 'allow' })
    const card = await newCard(ctx, before, 10_000)
    expect(card !== null, 'the first request should start a task')
    if (!card) return
    const since = Date.now()
    await ask(win, '简报最后再加一节「本周风险」，把连接池压测和对账接口超时写进去。', { permission: 'allow' })
    const evidence = evidenceSince(ctx, since)
    const actions = actionsOf(evidence)
    expect(actions.some((a) => a.kind === 'message' && a.taskId === card.id), 'the addition should go to the task already working on the brief', { card: card.id, ...summary(evidence) })
    expect(!actions.some((a) => a.kind === 'start'), 'no second task should be started for an addition', summary(evidence))
    const brief = await fileFromTask(ctx, `${dirOf(ctx)}/brief.md`, (text) => /风险/.test(text) && /连接池/.test(text))
    expect(Boolean(brief && /风险/.test(brief) && /连接池/.test(brief)), 'the brief should end up with the risks section', clip(brief ?? '(no brief.md)', 400))
    keep(ctx, 'numbers', { taskStatusAtUpdate: await cardStatus(ctx, card.id), ...summary(evidence) })
    await ctx.shot('route-update')
  },
}

const LONG_ASK = '详细讲讲小团队做代码评审有哪些好做法，分五点，每点三四句话。'
const interjectWords = (ctx: LiveContext) => `另外把 ${dirOf(ctx)} 里所有待办整理成一张表，写到 ${dirOf(ctx)}/todo.md。`

const routeInterject: LiveScenario = {
  id: 'route-interject',
  title: '讲解说到一半插一句「另外整理待办写到 todo.md」：很快有任务卡片，讲解照常讲完，todo.md 写出来',
  feature: '路由原型',
  async run(ctx) {
    const { win, expect } = ctx
    writeNotes(ctx)
    await fresh(win)
    const before = await cardCount(ctx)
    await submit(win, LONG_ASK)
    // Said once the answer is visibly under way, as a user reading it would.
    await until(win, `document.getElementById('send-btn').dataset.busy === 'true' && ([...document.querySelectorAll('#thread .msg-agent .msg-text')].at(-1)?.textContent.length ?? 0) > 40`, 'the answer under way', LIVE_TURN_MS)
    const said = Date.now()
    await submit(win, interjectWords(ctx))
    const card = await newCard(ctx, before, LIVE_TURN_MS)
    const answerAtCard: number = await run(win, `[...document.querySelectorAll('#thread .msg-agent .msg-text')].at(-1)?.textContent.length ?? 0`)
    await settle(win, { permission: 'allow' })
    const answer: string = await run(win, AGENT_TEXT)
    const evidence = evidenceSince(ctx, said - 1)
    expect(card !== null, 'the interjected work should get a task card', summary(evidence))
    expect((answer.match(/评审|审查|review/gi) ?? []).length >= 3 && answer.length > 400, 'the explanation should still be given in full', clip(answer, 300))
    const todo = await fileFromTask(ctx, `${dirOf(ctx)}/todo.md`, (text) => /李想/.test(text))
    expect(Boolean(todo && /李想/.test(todo) && /王敏/.test(todo)), 'todo.md should list the todos from the notes', clip(todo ?? '(no todo.md)', 300))
    keep(ctx, 'numbers', { cardAfterMs: card ? card.at - said : null, answerCharsWhenCardShowed: answerAtCard, fastLane: process.env.VIVA_ROUTING_FAST === '1', ...summary(evidence) })
    await ctx.shot('route-interject')
  },
}

/** Sets the rule in one topic, corrects it, then asks by it in another; the task's brief and file must follow it. */
async function historyAttempt(ctx: LiveContext) {
  const { win, expect, code, tag } = ctx
  writeNotes(ctx)
  await fresh(win)
  await ask(win, '我们定一下以后做工作简报的规矩：按负责人分组，用中文写。')
  await ask(win, `更正一下：简报改成按截止时间从近到远排，开头单独写一行识别码 ${code}。以后我说「按老规矩」，就是指这一版。`)
  await fresh(win)
  const since = Date.now(), before = await cardCount(ctx)
  const name = `brief-${tag}.md`
  await ask(win, `按老规矩，把 ${dirOf(ctx)} 里的纪要整理成今天的简报，写到 ${dirOf(ctx)}/${name}。`, { permission: 'allow' })
  await newCard(ctx, before, 10_000)
  const evidence = evidenceSince(ctx, since)
  const briefs = actionsOf(evidence).map((a) => String(a.brief ?? '')).join('\n')
  expect(briefs.includes(code), 'the brief handed over should carry the corrected rule', { brief: clip(briefs, 400), ...summary(evidence) })
  const file = await fileFromTask(ctx, `${dirOf(ctx)}/${name}`, (text) => text.includes(code))
  expect(Boolean(file?.includes(code)), 'the written brief should follow the corrected rule', clip(file ?? `(no ${name})`, 300))
  keep(ctx, 'numbers', { recoveredWith: summary(evidence).tools.filter((t) => t === 'search_conversations' || t === 'read_conversation' || t === 'memory_recall'), ...summary(evidence) })
  await ctx.shot('route-history')
}

const routeInterjectCorrect: LiveScenario = {
  id: 'route-interject-correct',
  title: '讲解说到一半说「用英文讲吧」：这是纠正当前回答，不开任务，后面改用英文',
  feature: '路由原型',
  async run(ctx) {
    const { win, expect } = ctx
    await fresh(win)
    const before = await cardCount(ctx)
    await submit(win, LONG_ASK)
    await until(win, `document.getElementById('send-btn').dataset.busy === 'true' && ([...document.querySelectorAll('#thread .msg-agent .msg-text')].at(-1)?.textContent.length ?? 0) > 40`, 'the answer under way', LIVE_TURN_MS)
    const said = Date.now()
    await submit(win, '用英文讲吧。')
    await settle(win)
    const evidence = evidenceSince(ctx, said - 1)
    const last: string = await run(win, `[...document.querySelectorAll('#thread .msg-agent .msg-text')].at(-1)?.textContent ?? ''`)
    expect(await cardCount(ctx) === before, 'a correction to the answer should start no task', summary(evidence))
    expect(!evidence.some((e) => e.type === 'fast_committed'), 'the fast lane should leave a correction to the main agent', summary(evidence))
    expect(latinShare(last) > 0.5, 'the answer should go on in English', clip(last, 300))
    keep(ctx, 'numbers', summary(evidence))
    await ctx.shot('route-interject-correct')
  },
}

const routeHistory: LiveScenario = {
  id: 'route-history',
  title: '另一个话题里定过、又改过简报规矩；新话题说「按老规矩」：找回改过的那版，写进简报',
  feature: '路由原型',
  async run(ctx) {
    try { await historyAttempt(ctx) } finally {
      // The rules this attempt set may also be kept as memories; the next attempt sets its own.
      await wait(MEMORY_SETTLE_MS)
      for (const words of [ctx.code, '老规矩', '简报']) await forgetMemories(ctx.win, words)
    }
  },
}

const routeStop: LiveScenario = {
  id: 'route-stop',
  title: '长任务刚开始就说「先停掉刚才那个翻译任务」：停的是那个任务，卡片显示已停止',
  feature: '路由原型',
  async run(ctx) {
    const { win, expect } = ctx
    writeNotes(ctx)
    await fresh(win)
    const before = await cardCount(ctx)
    await ask(win, `把 ${dirOf(ctx)} 里每份纪要分别翻译成英文，各存成同名的 .en.md 文件；每份翻完自己再逐句通读校对一遍。`, { permission: 'allow' })
    const card = await newCard(ctx, before, 10_000)
    expect(card !== null, 'the translation should start a task')
    if (!card) return
    const since = Date.now()
    await ask(win, '先停掉刚才那个翻译任务。')
    const evidence = evidenceSince(ctx, since)
    expect(actionsOf(evidence).some((a) => a.kind === 'stop' && a.taskId === card.id), 'the stop should name that task', { card: card.id, ...summary(evidence) })
    const status = await until(win, `(() => { const s = ${CARDS}.find((c) => c.dataset.task === ${JSON.stringify(card.id)})?.dataset.status; return s && s !== 'running' && s !== 'waiting' ? s : null })()`, 'the task no longer running', 60_000).catch(() => null)
    expect(status === 'stopped', 'the card should say the task was stopped', { status })
    keep(ctx, 'numbers', { status, ...summary(evidence) })
    await ctx.shot('route-stop')
  },
}

const routeReply: LiveScenario = {
  id: 'route-reply',
  title: '普通问答：先路由再流式回答，首字时间可测，库里和界面上没有路由的痕迹',
  feature: '路由原型',
  async run(ctx) {
    const { win, expect } = ctx
    await fresh(win)
    const asked = await run(win, `document.querySelectorAll('#thread .msg-agent').length`)
    const since = Date.now()
    await submit(win, '用两三句话说说什么是灰度发布。')
    await until(win, `(() => { const all = [...document.querySelectorAll('#thread .msg-agent .msg-text')]; return all.length > ${asked} && (all.at(-1).textContent.trim().length > 0) })()`, 'the first words of the answer', LIVE_TURN_MS)
    const firstText = Date.now() - since
    await settle(win)
    const shown: string = await run(win, AGENT_TEXT)
    const evidence = evidenceSince(ctx, since)
    expect(actionsOf(evidence).some((a) => a.kind === 'reply'), 'it should be routed as a reply', summary(evidence))
    expect(/灰度/.test(shown), 'the answer should be shown', clip(shown, 200))
    const db = new DatabaseSync(path.join(ctx.userData, 'app.db'), { readOnly: true })
    try {
      const leaked = db.prepare(`SELECT role, substr(text, 1, 80) AS text FROM messages WHERE text LIKE '%【请求 ID%' OR text LIKE '%commit_route%' OR text LIKE '%"accepted":true%' OR text LIKE '%【调度已处理】%'`).all()
      expect(leaked.length === 0, 'stored messages should carry no routing marks', leaked)
    } finally { db.close() }
    expect(!/【请求 ID|commit_route|"accepted"/.test(shown), 'the screen should carry no routing marks', clip(shown, 200))
    keep(ctx, 'numbers', { firstTextMs: firstText, ...summary(evidence) })
    await ctx.shot('route-reply')
  },
}

const SCHEDULE_CARD = `[...document.querySelectorAll('#thread .fu-card[aria-label="要我定时做吗？"]')].at(-1)`
const PERMISSION = `[...document.querySelectorAll('.confirm:not(.ask):not(.fu-card)')].find((el) => !el.closest('#tasks-page'))`

const routeSchedule: LiveScenario = {
  id: 'route-schedule',
  title: '「每周五下午五点提醒我写周报」：定时卡片出来，对话不被卡住，卡片没点也能接着问，点了之后在动态里',
  feature: '路由原型',
  async run(ctx) {
    const { win, expect, tag } = ctx
    await fresh(win)
    const name = `周报-${tag}`
    const since = Date.now()
    const out = await ask(win, `每周五下午五点提醒我写${name}。`)
    const proposed = evidenceSince(ctx, since).filter((e) => e.type === 'app_action_done' && e.operation === 'schedule_create')
    expect(proposed.some((e) => e.ok === true), 'the schedule proposal should be made', proposed)
    const card: string | null = await until(win, `${SCHEDULE_CARD}?.textContent ?? null`, 'the schedule card', 30_000).catch(() => null)
    const evidence = evidenceSince(ctx, since)
    expect(actionsOf(evidence).some((a) => a.kind === 'app_action' && a.operation === 'schedule_create'), 'the schedule should be asked for as an app operation', summary(evidence))
    expect(card !== null && card.includes(name), 'the schedule card should show, naming it', clip(card ?? out.answer, 300))
    if (!card) return
    // The card still waiting, the conversation goes on.
    const next = await ask(win, '顺便问下，周报一般写哪几块？一句话回答。')
    expect(next.answer.length > 5 && !next.waiting, 'a new question should be answered while the card waits', clip(next.answer))
    await run(win, `[...(${SCHEDULE_CARD}).querySelectorAll('button')].find((b) => b.textContent === '定时')?.click()`)
    await wait(UI_WAIT_MS * 2)
    if (await run(win, `document.getElementById('feed-page').hidden`)) await run(win, `document.getElementById('open-feed').click()`)
    await until(win, `!document.getElementById('feed-page').hidden`, 'the 动态 page')
    await wait(UI_WAIT_MS)
    const rows: string[] = await run(win, `[...document.querySelectorAll('#feed-page .fu-row[data-status="active"]')].map((row) => row.textContent)`)
    expect(rows.some((row) => row.includes(name)), 'kept, the schedule should be in 接下来', rows)
    keep(ctx, 'numbers', { turnMs: out.ms, followUpMs: next.ms, ...summary(evidence) })
    await ctx.shot('route-schedule')
    await escape(win)
  },
}

/** A different name each attempt: a memory left by one attempt cannot answer the next. */
const BOSSES = ['顾远航', '沈清和', '陆知遥', '许一诺', '孟川岳', '韩若溪', '程季白', '宋怀瑾', '唐亦舟', '叶书禾']

const routeMemory: LiveScenario = {
  id: 'route-memory',
  title: '「记住：我的直属上级是某某」：作为应用操作存进记忆，新话题里问得出来',
  feature: '路由原型',
  async run(ctx) {
    const { win, expect, tag } = ctx
    const boss = BOSSES[(ctx.attempt - 1) % BOSSES.length]
    try {
      await fresh(win)
      const since = Date.now()
      await ask(win, `记住：我的直属上级是 ${boss}。`)
      const evidence = evidenceSince(ctx, since)
      expect(actionsOf(evidence).some((a) => a.kind === 'app_action' && a.operation === 'memory_remember'), 'remembering should be an app operation', summary(evidence))
      // Kept by the operation itself, not only by the memory plugin's pass after the turn.
      expect(evidence.some((e) => e.type === 'app_action_done' && e.operation === 'memory_remember' && e.ok === true), 'the memory operation should succeed', evidence.filter((e) => e.type === 'app_action_done'))
      await wait(MEMORY_SETTLE_MS)
      expect((await memoriesWith(win, boss)).length > 0, 'the fact should be kept in memory')
      await fresh(win)
      const out = await ask(win, '我的直属上级是谁？只回答名字。')
      expect(out.answer.includes(boss), 'a new topic should know it', clip(out.answer))
      keep(ctx, 'numbers', summary(evidenceSince(ctx, since)))
      await ctx.shot('route-memory')
    } finally {
      // After the memory plugin's pass, which may keep the fact a second time.
      await wait(MEMORY_SETTLE_MS)
      await forgetMemories(win, boss)
    }
  },
}

const routeMcp: LiveScenario = {
  id: 'route-mcp',
  title: '对话里接入 MCP：主会话不等审批就结束；审批卡和密钥窗口照常出现，确认后服务器存好',
  feature: '路由原型',
  async run(ctx) {
    const { win, expect, tag } = ctx
    const name = `mail-${tag}`, secret = `live-secret-${tag}`
    const server = path.join(ctx.hooks.fixtures, 'mail-mcp.js')
    await fresh(win)
    const since = Date.now()
    const out = await ask(win, `帮我接入一个本地 MCP 服务器：名字叫 ${name}，命令是 node，参数只有一个：${server}。它需要一个密钥，环境变量名叫 MAIL_TOKEN。`)
    const turnEnded = Date.now()
    // After the turn: the approval on the executor task's card, then the key, as the owner does them.
    const stored = path.join(ctx.userData, 'mcp-servers.json')
    const deadline = Date.now() + 180_000
    const seen = { taskWaited: false, approval: '', secret: false, where: '' }
    while (Date.now() < deadline && !fileHolds(stored, name)) {
      const waiting: string | null = await run(win, `${CARDS}.find((card) => card.dataset.status === 'waiting')?.dataset.task ?? null`)
      if (waiting) {
        seen.taskWaited = true
        await run(win, `${CARDS}.find((card) => card.dataset.task === ${JSON.stringify(waiting)})?.click()`)
        await wait(800)
        const card: string | null = await run(win, `document.querySelector('#tasks-page .confirm')?.textContent ?? null`)
        if (card) { seen.approval ||= card; await run(win, `document.querySelector('#tasks-page .confirm .btn-primary')?.click()`); await wait(UI_WAIT_MS) }
      }
      const main: string | null = await run(win, `${PERMISSION}?.textContent ?? null`)
      if (main) { seen.approval ||= main; seen.where = 'conversation'; await run(win, `(${PERMISSION}).querySelector('.btn-primary').click()`); await wait(UI_WAIT_MS) }
      if (await run(win, `Boolean(document.querySelector('.secret'))`)) {
        seen.where ||= await run(win, `document.querySelector('.secret').closest('#tasks-page') ? 'task page' : 'conversation'`)
        await run(win, `(() => { const card = document.querySelector('.secret'); card.querySelectorAll('input').forEach((input) => { input.value = ${JSON.stringify(secret)} }); card.requestSubmit() })()`)
        seen.secret = true
        await wait(UI_WAIT_MS)
      }
      await escape(win)
      await wait(POLL_MS * 2)
    }
    const evidence = evidenceSince(ctx, since)
    expect(actionsOf(evidence).some((a) => a.kind === 'app_action' && a.operation === 'viva_mcp_add'), 'adding the server should be an app operation', summary(evidence))
    expect(seen.approval.includes(name), 'the approval card should come, naming the server', seen)
    expect(out.ms < 60_000 && !out.waiting, 'the conversation should not wait on the approval', { turnMs: out.ms })
    expect(seen.secret, 'the key window should come', seen)
    expect(fileHolds(stored, name) && !fileHolds(stored, secret), 'the server should be kept, its key only encrypted', { done: evidence.filter((e) => e.type === 'app_action_done') })
    keep(ctx, 'numbers', { turnMs: out.ms, ...seen, done: evidence.filter((e) => e.type === 'app_action_done').map((e) => ({ ok: e.ok, ms: e.ms, text: clip(String(e.text), 120) })), ...summary(evidence) })
    await ctx.shot('route-mcp')
  },
}

/** The tasks an attempt started, from the plugin's receipts: stopped when it ends, so they hold none of the five places. */
async function stopStarted(ctx: LiveContext, since: number) {
  const ids = new Set<string>()
  for (const e of evidenceSince(ctx, since)) {
    const receipts = e.type === 'route_committed' ? ((e.receipts as Array<{ receipt?: { taskId?: string } }> | undefined) ?? []).map((r) => r.receipt) : e.type === 'fast_committed' ? [e.receipt as { taskId?: string }] : []
    for (const receipt of receipts) if (receipt?.taskId) ids.add(receipt.taskId)
  }
  for (const id of ids) await run(ctx.win, `window.agent.stopTask(${JSON.stringify(id)}).then(() => true, () => false)`)
}
const isolated = (scenario: LiveScenario): LiveScenario => ({
  ...scenario,
  async run(ctx) {
    const since = Date.now()
    try { await scenario.run(ctx) } finally { await stopStarted(ctx, since).catch(() => {}) }
  },
})

export const ROUTING_SCENARIOS: readonly LiveScenario[] = [routeReply, routeHandoff, routeUpdate, routeInterject, routeInterjectCorrect, routeHistory, routeStop, routeSchedule, routeMemory, routeMcp].map(isolated)

/**
 * Live scenarios for request routing (docs/agent-routing-design.md §13.1): the app as users get it, the main agent
 * routing every request and tasks doing the work through the real TaskRuntime. Materials are meeting notes in the
 * workspace; what is asked is what a user asks of them. Each attempt reads what was decided from the app's own
 * records (app.db's routing tables, request-store.ts) and what the main agent called from its trace (trace.db), and
 * what tasks produced from the workspace.
 */
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { MAIN_SCOPE } from '../../plugins/routing/lib/policy.ts'
import { ask, clip, escape, fileHolds, forgetMemories, fresh, latinShare, LIVE_TURN_MS, MEMORY_SETTLE_MS, memoriesWith, settle, writeWorkspace, type LiveContext, type LiveScenario } from './live-kit.ts'
import { run, submit, UI_WAIT_MS, until, wait } from './smoke-kit.ts'

const TASK_DONE_MS = 6 * 60_000
const POLL_MS = 500
const CARDS = `[...document.querySelectorAll('#thread .task-card')]`
const AGENT_TEXT = `[...document.querySelectorAll('#thread .msg-agent .msg-text')].map((el) => el.textContent).join('\\n')`

type Action = Record<string, unknown> & { kind: string, status: string, taskId: string | null }
type Routed = { requestId: string, sessionId: string, kind: string, status: string, failure: string | null, actions: Action[] }

/** The requests received since `since`, each with its decision's actions and what became of them. */
function routedSince(ctx: LiveContext, since: number): Routed[] {
  const db = new DatabaseSync(path.join(ctx.userData, 'app.db'), { readOnly: true })
  try {
    const rows = db.prepare(`SELECT r.id, r.session_id, r.kind, r.status, r.failure, d.plan FROM routing_requests r
      LEFT JOIN routing_decisions d ON d.request_id = r.id WHERE r.received_at >= ? ORDER BY r.received_at`).all(since) as Array<Record<string, string | null>>
    const settled = db.prepare('SELECT idx, status, task_id FROM routing_actions WHERE request_id = ? ORDER BY idx')
    return rows.map((row) => {
      const planned = (row.plan ? JSON.parse(row.plan).actions : []) as Array<Record<string, unknown> & { kind: string }>
      const done = settled.all(String(row.id)) as Array<{ status: string, task_id: string | null }>
      return {
        requestId: String(row.id), sessionId: String(row.session_id), kind: String(row.kind), status: String(row.status), failure: row.failure,
        actions: planned.map((action, idx) => ({ ...action, status: done[idx]?.status ?? 'done', taskId: done[idx]?.task_id ?? (typeof action.taskId === 'string' ? action.taskId : null) })),
      }
    })
  } finally { db.close() }
}

/** The main conversation's tool calls since `since`, from the trace (the trace plugin records each turn's steps). */
function mainToolsSince(ctx: LiveContext, routed: readonly Routed[], since: number): string[] {
  const sessions = [...new Set(routed.map((request) => request.sessionId))]
  const file = path.join(ctx.userData, 'trace.db')
  if (!sessions.length || !fs.existsSync(file)) return []
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    return (db.prepare(`SELECT name FROM steps WHERE kind = 'tool' AND at >= ? AND session_id IN (${sessions.map(() => '?').join(', ')}) ORDER BY at`)
      .all(since, ...sessions) as Array<{ name: string }>).map((row) => row.name)
  } finally { db.close() }
}

/** What the fast lane made of interjections since `since` (request.fast events: outcome, reason code, milliseconds). */
function fastSince(ctx: LiveContext, since: number): Array<{ outcome: string, reason: string | null, ms: number }> {
  const db = new DatabaseSync(path.join(ctx.userData, 'app.db'), { readOnly: true })
  try {
    return (db.prepare(`SELECT data FROM app_events WHERE kind = 'request.fast' AND at >= ? ORDER BY seq`).all(since) as Array<{ data: string }>)
      .map((row) => JSON.parse(row.data))
  } finally { db.close() }
}

const actionsOf = (routed: readonly Routed[]) => routed.flatMap((request) => request.actions)
function summary(ctx: LiveContext, since: number) {
  const routed = routedSince(ctx, since)
  const tools = mainToolsSince(ctx, routed, since)
  return {
    routed,
    decisions: routed.map((request) => (request.status === 'decided' ? request.actions.map((action) => action.kind).join('+') : `${request.status}:${request.failure}`)),
    tools,
    /** Calls the main agent made outside its layers (each refused before it ran). */
    forbidden: tools.filter((tool) => !MAIN_SCOPE.includes(tool)),
    failed: routed.filter((request) => request.status === 'failed').length,
  }
}
const brief = (numbers: ReturnType<typeof summary>) => ({ decisions: numbers.decisions, tools: numbers.tools, forbidden: numbers.forbidden, failed: numbers.failed })
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

const routeReply: LiveScenario = {
  id: 'route-reply',
  title: '普通问答：先路由再流式回答，首字时间可测，库里和界面上没有路由的痕迹',
  feature: '后台任务',
  core: true,
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
    const numbers = summary(ctx, since)
    expect(actionsOf(numbers.routed).some((a) => a.kind === 'reply'), 'it should be routed as a reply', brief(numbers))
    expect(numbers.forbidden.length === 0, 'the main agent should not reach for tools it lacks', brief(numbers))
    expect(/灰度/.test(shown), 'the answer should be shown', clip(shown, 200))
    const db = new DatabaseSync(path.join(ctx.userData, 'app.db'), { readOnly: true })
    try {
      const leaked = db.prepare(`SELECT role, substr(text, 1, 80) AS text FROM messages WHERE text LIKE '%【请求 ID%' OR text LIKE '%commit_route%' OR text LIKE '%"accepted":true%' OR text LIKE '%【调度已处理】%'`).all()
      expect(leaked.length === 0, 'stored messages should carry no routing marks', leaked)
    } finally { db.close() }
    expect(!/【请求 ID|commit_route|"accepted"/.test(shown), 'the screen should carry no routing marks', clip(shown, 200))
    keep(ctx, 'numbers', { firstTextMs: firstText, ...brief(numbers) })
    await ctx.shot('route-reply')
  },
}

const routeHandoff: LiveScenario = {
  id: 'route-handoff',
  title: '整理工作区里的会议纪要做简报：主动交给任务，对话很快空出来，brief.md 用到了纪要内容',
  feature: '后台任务',
  core: true,
  async run(ctx) {
    const { win, expect, code } = ctx
    writeNotes(ctx)
    await fresh(win)
    const since = Date.now(), before = await cardCount(ctx)
    const out = await ask(win, handoffAsk(ctx), { permission: 'allow' })
    const card = await newCard(ctx, before, 10_000)
    const numbers = summary(ctx, since)
    expect(actionsOf(numbers.routed).some((a) => a.kind === 'start' && a.status === 'done'), 'the work should be handed to a task', brief(numbers))
    expect(card !== null, 'a task card should show in the conversation', { answer: clip(out.answer) })
    expect(numbers.forbidden.length === 0, 'the main agent should not reach for tools it lacks', brief(numbers))
    // The handover is said in one line (its notice), the turn's answer: no "no final reply" in the window.
    const thread: string = await run(win, `document.getElementById('thread')?.textContent ?? ''`)
    expect(out.answer.trim().length > 0 && !/没有生成最终回复|本轮没有文字回复/.test(thread), 'the handover should be said as the turn\'s answer', clip(out.answer, 200))
    const title: string = await run(win, `${CARDS}.at(-1)?.querySelector('.task-name')?.textContent ?? ''`)
    expect(title.length > 1 && !/用户原话|请求 ID/.test(title), 'the task card should be titled by a short task name', title)
    const written = await fileFromTask(ctx, `${dirOf(ctx)}/brief.md`, (text) => text.includes(code))
    expect(Boolean(written?.includes(`${code}-A`) || written?.includes(`${code}-B`)), 'the brief should be built from the notes', clip(written ?? '(no brief.md)', 400))
    expect(Boolean(written && /李想/.test(written) && /王敏/.test(written)), 'the brief should list todos by owner', clip(written ?? '', 400))
    keep(ctx, 'numbers', { freeAfterMs: out.ms, ...brief(numbers) })
    await ctx.shot('route-handoff')
  },
}

const routeUpdate: LiveScenario = {
  id: 'route-update',
  title: '任务刚开始就补一句「再加一节风险」：转给原任务，不另开新任务，简报里有风险一节',
  feature: '后台任务',
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
    const numbers = summary(ctx, since)
    const actions = actionsOf(numbers.routed)
    expect(actions.some((a) => a.kind === 'message' && a.taskId === card.id), 'the addition should go to the task already working on the brief', { card: card.id, ...brief(numbers) })
    expect(!actions.some((a) => a.kind === 'start'), 'no second task should be started for an addition', brief(numbers))
    const written = await fileFromTask(ctx, `${dirOf(ctx)}/brief.md`, (text) => /风险/.test(text) && /连接池/.test(text))
    expect(Boolean(written && /风险/.test(written) && /连接池/.test(written)), 'the brief should end up with the risks section', clip(written ?? '(no brief.md)', 400))
    keep(ctx, 'numbers', { taskStatusAtUpdate: await cardStatus(ctx, card.id), ...brief(numbers) })
    await ctx.shot('route-update')
  },
}

const LONG_ASK = '详细讲讲小团队做代码评审有哪些好做法，分五点，每点三四句话。'
const interjectWords = (ctx: LiveContext) => `另外把 ${dirOf(ctx)} 里所有待办整理成一张表，写到 ${dirOf(ctx)}/todo.md。`
const answerUnderWay = `document.getElementById('send-btn').dataset.busy === 'true' && ([...document.querySelectorAll('#thread .msg-agent .msg-text')].at(-1)?.textContent.length ?? 0) > 40`

const routeInterject: LiveScenario = {
  id: 'route-interject',
  title: '讲解说到一半插一句「另外整理待办写到 todo.md」：很快有任务卡片，讲解照常讲完，todo.md 写出来',
  feature: '工作中插话',
  core: true,
  async run(ctx) {
    const { win, expect } = ctx
    writeNotes(ctx)
    await fresh(win)
    const before = await cardCount(ctx)
    await submit(win, LONG_ASK)
    // Said once the answer is visibly under way, as a user reading it would.
    await until(win, answerUnderWay, 'the answer under way', LIVE_TURN_MS)
    const said = Date.now()
    await submit(win, interjectWords(ctx))
    const card = await newCard(ctx, before, LIVE_TURN_MS)
    const answerAtCard: number = await run(win, `[...document.querySelectorAll('#thread .msg-agent .msg-text')].at(-1)?.textContent.length ?? 0`)
    await settle(win, { permission: 'allow' })
    const answer: string = await run(win, AGENT_TEXT)
    const numbers = summary(ctx, said - 1)
    expect(card !== null, 'the interjected work should get a task card', brief(numbers))
    expect(numbers.routed.some((r) => r.kind === 'interjection' && r.actions.some((a) => a.kind === 'start')), 'the interjection should be routed to a task of its own', brief(numbers))
    expect((answer.match(/评审|审查|review/gi) ?? []).length >= 3 && answer.length > 400, 'the explanation should still be given in full', clip(answer, 300))
    const todo = await fileFromTask(ctx, `${dirOf(ctx)}/todo.md`, (text) => /李想/.test(text))
    expect(Boolean(todo && /李想/.test(todo) && /王敏/.test(todo)), 'todo.md should list the todos from the notes', clip(todo ?? '(no todo.md)', 300))
    keep(ctx, 'numbers', { cardAfterMs: card ? card.at - said : null, answerCharsWhenCardShowed: answerAtCard, fast: fastSince(ctx, said - 1), ...brief(numbers) })
    await ctx.shot('route-interject')
  },
}

const routeInterjectCorrect: LiveScenario = {
  id: 'route-interject-correct',
  title: '讲解说到一半说「用英文讲吧」：这是纠正当前回答，不开任务，后面改用英文',
  feature: '工作中插话',
  async run(ctx) {
    const { win, expect } = ctx
    await fresh(win)
    const before = await cardCount(ctx)
    await submit(win, LONG_ASK)
    await until(win, answerUnderWay, 'the answer under way', LIVE_TURN_MS)
    const said = Date.now()
    await submit(win, '用英文讲吧。')
    await settle(win)
    const numbers = summary(ctx, said - 1)
    const last: string = await run(win, `[...document.querySelectorAll('#thread .msg-agent .msg-text')].at(-1)?.textContent ?? ''`)
    expect(await cardCount(ctx) === before, 'a correction to the answer should start no task', brief(numbers))
    expect(!actionsOf(numbers.routed).some((a) => a.kind === 'start' || a.kind === 'message' || a.kind === 'stop'), 'nothing should be handed over for a correction', brief(numbers))
    expect(latinShare(last) > 0.5, 'the answer should go on in English', clip(last, 300))
    keep(ctx, 'numbers', brief(numbers))
    await ctx.shot('route-interject-correct')
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
  const numbers = summary(ctx, since)
  const briefs = actionsOf(numbers.routed).map((a) => String(a.brief ?? '')).join('\n')
  expect(briefs.includes(code), 'the brief handed over should carry the corrected rule', { brief: clip(briefs, 400), ...brief(numbers) })
  const file = await fileFromTask(ctx, `${dirOf(ctx)}/${name}`, (text) => text.includes(code))
  expect(Boolean(file?.includes(code)), 'the written brief should follow the corrected rule', clip(file ?? `(no ${name})`, 300))
  keep(ctx, 'numbers', { recoveredWith: numbers.tools.filter((t) => t === 'search_conversations' || t === 'read_conversation' || t === 'memory_recall'), ...brief(numbers) })
  await ctx.shot('route-history')
}

const routeHistory: LiveScenario = {
  id: 'route-history',
  title: '另一个话题里定过、又改过简报规矩；新话题说「按老规矩」：找回改过的那版，写进简报',
  feature: '历史对话',
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
  feature: '后台任务',
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
    const numbers = summary(ctx, since)
    expect(actionsOf(numbers.routed).some((a) => a.kind === 'stop' && a.taskId === card.id), 'the stop should name that task', { card: card.id, ...brief(numbers) })
    const status = await until(win, `(() => { const s = ${CARDS}.find((c) => c.dataset.task === ${JSON.stringify(card.id)})?.dataset.status; return s && s !== 'running' && s !== 'waiting' ? s : null })()`, 'the task no longer running', 60_000).catch(() => null)
    expect(status === 'stopped', 'the card should say the task was stopped', { status })
    keep(ctx, 'numbers', { status, ...brief(numbers) })
    await ctx.shot('route-stop')
  },
}

const SCHEDULE_CARD = `[...document.querySelectorAll('#thread .fu-card[aria-label="要我定时做吗？"]')].at(-1)`

/** An app change (plugins/routing/lib/policy.ts): routed as an app_action, then done by the main agent's own call of its tool. */
const appChange = (numbers: ReturnType<typeof summary>, tool: string) => ({
  routed: actionsOf(numbers.routed).some((a) => a.kind === 'app_action' && a.operation === tool),
  called: numbers.tools.includes(tool),
})

/** A different project each attempt, as a user with several would name it; a schedule left by one is not the next's. */
const PROJECTS = ['北辰', '启明', '远帆', '青禾', '长庚', '星河', '云杉', '澄湖', '暮山', '晴川']

const routeSchedule: LiveScenario = {
  id: 'route-schedule',
  title: '「每周五下午五点提醒我写某项目周报」：经授权调用定时工具，卡片出来，没点也能接着问，点了之后在动态里',
  feature: '定时任务',
  async run(ctx) {
    const { win, expect } = ctx
    const project = PROJECTS[(ctx.attempt - 1) % PROJECTS.length]
    await fresh(win)
    const since = Date.now()
    const out = await ask(win, `每周五下午五点提醒我写${project}项目的周报。`)
    const card: string | null = await until(win, `${SCHEDULE_CARD}?.textContent ?? null`, 'the schedule card', 30_000).catch(() => null)
    const numbers = summary(ctx, since)
    const change = appChange(numbers, 'schedule_create')
    expect(change.routed && change.called, 'the schedule should be routed as an app operation, then proposed by its own tool', { ...change, ...brief(numbers) })
    expect(card !== null && card.includes(project), 'the schedule card should show, naming the project', clip(card ?? out.answer, 300))
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
    expect(rows.some((row) => row.includes(project)), 'kept, the schedule should be in 接下来', rows)
    keep(ctx, 'numbers', { turnMs: out.ms, followUpMs: next.ms, ...change, ...brief(numbers) })
    await ctx.shot('route-schedule')
    await escape(win)
  },
}

/** A different name each attempt: a memory left by one attempt cannot answer the next. */
const BOSSES = ['顾远航', '沈清和', '陆知遥', '许一诺', '孟川岳', '韩若溪', '程季白', '宋怀瑾', '唐亦舟', '叶书禾']

const routeMemory: LiveScenario = {
  id: 'route-memory',
  title: '「记住：我的直属上级是某某」：经授权调用记忆工具存下，新话题里问得出来',
  feature: '记忆',
  async run(ctx) {
    const { win, expect } = ctx
    const boss = BOSSES[(ctx.attempt - 1) % BOSSES.length]
    try {
      await fresh(win)
      const since = Date.now()
      await ask(win, `记住：我的直属上级是 ${boss}。`)
      const numbers = summary(ctx, since)
      const change = appChange(numbers, 'memory_remember')
      expect(change.routed && change.called, 'remembering should be routed as an app operation, then done by its own tool', { ...change, ...brief(numbers) })
      expect((await memoriesWith(win, boss)).length > 0, 'the fact should be kept in memory')
      await fresh(win)
      const out = await ask(win, '我的直属上级是谁？只回答名字。')
      expect(out.answer.includes(boss), 'a new topic should know it', clip(out.answer))
      keep(ctx, 'numbers', { ...change, ...brief(summary(ctx, since)) })
      await ctx.shot('route-memory')
    } finally {
      // After the memory plugin's own pass, which may keep the fact a second time.
      await wait(MEMORY_SETTLE_MS)
      await forgetMemories(win, boss)
    }
  },
}

const routeMcp: LiveScenario = {
  id: 'route-mcp',
  title: '对话里接入 MCP：经授权调用接入工具，审批卡和密钥窗口照常，确认后服务器存好、密钥只加密保存',
  feature: '在对话里配置 MCP 和 skill',
  async run(ctx) {
    const { win, expect, tag } = ctx
    const name = `mail-${tag}`, secret = `live-secret-${tag}`
    const server = path.join(ctx.hooks.fixtures, 'mail-mcp.js')
    await fresh(win)
    const since = Date.now()
    const out = await ask(win, `帮我接入一个本地 MCP 服务器：名字叫 ${name}，命令是 node，参数只有一个：${server}。它需要一个密钥，环境变量名叫 MAIL_TOKEN。`, { permission: 'allow', secret })
    const numbers = summary(ctx, since)
    const change = appChange(numbers, 'viva_mcp_add')
    const stored = path.join(ctx.userData, 'mcp-servers.json')
    expect(change.routed && change.called, 'adding the server should be routed as an app operation, then done by its own tool', { ...change, ...brief(numbers) })
    expect(out.cards.some((title) => title.includes(name)), 'the approval card should come, naming the server', out.cards)
    expect(out.secrets.includes('MAIL_TOKEN'), 'the key should be asked for in the window, by its name', out.secrets)
    expect(fileHolds(stored, name) && !fileHolds(stored, secret), 'the server should be kept, its key only encrypted', { stored: fs.existsSync(stored) })
    expect(!fileHolds(path.join(ctx.userData, 'app.db'), secret), 'the key should never be in the app database')
    keep(ctx, 'numbers', { turnMs: out.ms, cards: out.cards, secrets: out.secrets, ...change, ...brief(numbers) })
    await ctx.shot('route-mcp')
  },
}

/** The tasks an attempt started, from the app's receipts: stopped when it ends, so they hold none of the five places. */
async function stopStarted(ctx: LiveContext, since: number) {
  const ids = new Set(actionsOf(routedSince(ctx, since)).filter((a) => a.kind === 'start' && a.taskId).map((a) => String(a.taskId)))
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

/**
 * Live scenarios for request routing (docs/agent-routing-design.md §13.1): the app as users get it, the main agent
 * routing every request and tasks doing the work through the real TaskRuntime. Materials are meeting notes in the
 * workspace; what is asked is what a user asks of them. Each attempt reads what was decided from the app's own
 * records (app.db's routing tables, request-store.ts) and what the main agent called from its trace (trace.db), and
 * what tasks produced from the workspace.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { MAIN_SCOPE } from '../../plugins/routing/lib/policy.ts'
import { ask, clip, escape, fileHolds, forgetMemories, fresh, latinShare, LIVE_TURN_MS, MEMORY_SETTLE_MS, memoryFilesWith, settle, writeWorkspace, type LiveContext, type LiveScenario } from './live-kit.ts'
import { run, submit, UI_WAIT_MS, until, wait, type SmokeWindow } from './smoke-kit.ts'

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
  title: '「每周五下午五点提醒我写某项目周报」：经授权调用定时工具，卡片出来，没点也能接着问，点了之后在「定时任务」里',
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
    if (await run(win, `document.getElementById('hub').dataset.open !== 'true'`)) {
      await run(win, `document.getElementById('open-profile').click()`)
    }
    await run(win, `document.querySelector('.hub-nav[data-page="schedules"]').click()`)
    await until(win, `!document.getElementById('schedules-page').hidden`, 'the 定时任务 page')
    await wait(UI_WAIT_MS)
    const rows: string[] = await run(win, `[...document.querySelectorAll('#schedules-page .fu-row[data-status="active"]')].map((row) => row.textContent)`)
    expect(rows.some((row) => row.includes(project)), 'kept, the schedule should be on 定时任务', rows)
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
      expect((await memoryFilesWith(win, boss)).length > 0, 'the original evidence should be retained in a current memory file')
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

const routePeek: LiveScenario = {
  id: 'route-peek',
  title: '单点文件速查：先提交 reply 再用速查读单个配置文件直接回答，不开后台任务',
  feature: '后台任务',
  core: true,
  async run(ctx) {
    const { win, expect, tag } = ctx
    const secret = `PK-${Math.random().toString(36).slice(2, 8).toUpperCase()}-${Date.now().toString(36).slice(-4).toUpperCase()}`
    writeWorkspace(ctx, `service-${tag}.json`, JSON.stringify({ service: 'billing', releaseCode: secret, port: 8420 }, null, 2))
    await fresh(win)
    const since = Date.now(), before = await cardCount(ctx)
    const out = await ask(win, `看一眼工作区里的 service-${tag}.json，里面的 releaseCode 是什么？直接告诉我。`, { permission: 'allow' })
    const numbers = summary(ctx, since)
    const peeks = numbers.tools.filter((t) => t === 'read' || t === 'grep')
    expect(actionsOf(numbers.routed).some((a) => a.kind === 'reply'), 'single-file lookup should route as reply', brief(numbers))
    expect(!actionsOf(numbers.routed).some((a) => a.kind === 'start'), 'single-file lookup should start no background task', brief(numbers))
    expect(await cardCount(ctx) === before, 'no new task card should show', brief(numbers))
    expect(numbers.tools[0] === 'commit_route', 'commit_route should be called first before peeking', brief(numbers))
    expect(peeks.length >= 1 && peeks.length <= 2, '1 to 2 peek calls after commit_route', brief(numbers))
    expect(numbers.forbidden.length === 0, 'no forbidden tool calls', brief(numbers))
    expect(out.answer.includes(secret), 'the answer should contain the independent releaseCode from the file', clip(out.answer, 200))
    keep(ctx, 'numbers', { turnMs: out.ms, ...brief(numbers) })
    await ctx.shot('route-peek')
  },
}

const CLEAR_DIGITS = '23456789'
function clearDigits(length = 4): string {
  return Array.from({ length }, () => CLEAR_DIGITS[crypto.randomInt(0, CLEAR_DIGITS.length)]!).join('')
}

/** Draws a high-contrast PNG banner on canvas and pastes it into `#composer-input` through the real paste pipeline. */
async function pasteBannerImage(win: SmokeWindow, bannerText: string) {
  const beforeCount: number = await run(win, `document.querySelectorAll('.draft-pic img').length`)
  await run(win, `(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 560
    canvas.height = 180
    const g = canvas.getContext('2d')
    g.fillStyle = '#ffffff'
    g.fillRect(0, 0, canvas.width, canvas.height)
    g.strokeStyle = '#111111'
    g.lineWidth = 6
    g.strokeRect(10, 10, canvas.width - 20, canvas.height - 20)
    g.fillStyle = '#000000'
    g.font = 'bold 54px monospace'
    g.textBaseline = 'middle'
    g.fillText(${JSON.stringify(bannerText)}, 36, 92)
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
    const data = new DataTransfer()
    data.items.add(new File([blob], 'capture.png', { type: 'image/png' }))
    const field = document.getElementById('composer-input')
    field.focus()
    field.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    return true
  })()`)
  await until(win, `(() => {
    const imgs = [...document.querySelectorAll('.draft-pic img')]
    return imgs.length > ${beforeCount} && imgs.every((img) => img.complete && img.naturalWidth > 0)
  })()`, 'the pasted banner image ready in composer')
}

/** Waits for a task run to settle (`done`) and for its `<task-output>` report turn in `#thread` to finish. */
async function waitForTaskAndReport(ctx: LiveContext, taskId: string, agentMessagesBefore: number, timeoutMs = TASK_DONE_MS) {
  const deadline = Date.now() + timeoutMs
  let status: string | null = null
  while (Date.now() < deadline) {
    status = await cardStatus(ctx, taskId)
    if (status && status !== 'running' && status !== 'waiting') break
    await approveTaskWaits(ctx)
    await wait(POLL_MS * 2)
  }
  await until(
    ctx.win,
    `document.querySelectorAll('#thread .msg-agent').length > ${agentMessagesBefore} || document.getElementById('send-btn').dataset.busy === 'true'`,
    'the background task report arriving in thread',
    30_000,
  ).catch(() => {})
  await settle(ctx.win)
  return status
}

async function untilRemembered(win: SmokeWindow, words: string, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = await memoryFilesWith(win, words)
    if (found.length) return found
    await wait(1_500)
  }
  return []
}

const routeImagePeek: LiveScenario = {
  id: 'route-image-peek',
  title: '粘贴截图对照单文件：先提交 reply 再用速查读本地错误码映射表直接回答，不开后台任务',
  feature: '后台任务',
  core: true,
  async run(ctx) {
    const { win, expect, tag } = ctx
    const targetCode = `VX-${clearDigits(4)}`
    let wrongA = `VX-${clearDigits(4)}`, wrongB = `VX-${clearDigits(4)}`
    while (wrongA === targetCode) wrongA = `VX-${clearDigits(4)}`
    while (wrongB === targetCode || wrongB === wrongA) wrongB = `VX-${clearDigits(4)}`
    const targetNode = `GW-SH-${clearDigits(3)}`
    const wrongNodeA = `GW-BJ-${clearDigits(3)}`
    const wrongNodeB = `GW-GZ-${clearDigits(3)}`
    writeWorkspace(ctx, `errors-${tag}.json`, JSON.stringify({
      [wrongA]: { fault: '上游令牌过期', gateway: wrongNodeA },
      [targetCode]: { fault: '对账签名校验失败', gateway: targetNode },
      [wrongB]: { fault: '导出磁盘空间不足', gateway: wrongNodeB },
    }, null, 2))
    await fresh(win)
    const since = Date.now(), before = await cardCount(ctx)
    await pasteBannerImage(win, `ERR: ${targetCode}`)
    const out = await ask(win, `看下这张截图里的报错码，对照工作区的 errors-${tag}.json，只告诉我这个报错码对应的故障名称和网关节点，不用列其他无关条目，也不用改任何东西。`, { permission: 'allow' })
    const numbers = summary(ctx, since)
    const peeks = numbers.tools.filter((t) => t === 'read' || t === 'grep')
    expect(actionsOf(numbers.routed).some((a) => a.kind === 'reply'), 'image + single-file check should route as reply', brief(numbers))
    expect(!actionsOf(numbers.routed).some((a) => a.kind === 'start'), 'image + single-file check should start no background task', brief(numbers))
    expect(await cardCount(ctx) === before, 'no new task card should show', brief(numbers))
    expect(numbers.tools[0] === 'commit_route', 'commit_route should be called first before peeking', brief(numbers))
    expect(peeks.length >= 1 && peeks.length <= 2, '1 to 2 peek calls after commit_route', brief(numbers))
    expect(numbers.forbidden.length === 0, 'no forbidden tool calls', brief(numbers))
    expect(out.answer.includes(targetCode) && out.answer.includes('对账签名校验失败') && out.answer.includes(targetNode), 'the answer should combine the visual code from the screenshot with the mapped fault and gateway from JSON', clip(out.answer, 300))
    keep(ctx, 'numbers', { turnMs: out.ms, targetCode, targetNode, ...brief(numbers) })
    await ctx.shot('route-image-peek')
  },
}

const routeImageHandoff: LiveScenario = {
  id: 'route-image-handoff',
  title: '粘贴截图转交后台任务并带新图追问：原图随 start 与 message 自动进任务，读出图中编号落盘并在任务页展示',
  feature: '后台任务',
  core: true,
  async run(ctx) {
    const { win, expect } = ctx
    writeNotes(ctx)
    const stampCode = `RV-${clearDigits(4)}`
    const patchCode = `FX-${clearDigits(4)}`
    const outRel = `${dirOf(ctx)}/release-check.md`
    await fresh(win)
    const sinceStart = Date.now(), before = await cardCount(ctx)
    await pasteBannerImage(win, `STAMP: ${stampCode}`)
    await ask(
      win,
      `把这张审批截图和整理工作交给后台任务处理：结合截图里的审批编号，将 ${dirOf(ctx)} 文件夹里的几份纪要整理成发布核对单写到 ${outRel}，文件开头写上截图里的审批编号。`,
      { permission: 'allow' },
    )
    const agentMsgsAfterStart: number = await run(win, `document.querySelectorAll('#thread .msg-agent').length`)
    const card = await newCard(ctx, before, 10_000)
    const startNumbers = summary(ctx, sinceStart)
    expect(card !== null, 'image handoff should create a background task card', brief(startNumbers))
    expect(actionsOf(startNumbers.routed).some((a) => a.kind === 'start' && a.status === 'done'), 'the request should route as start', brief(startNumbers))
    expect(startNumbers.forbidden.length === 0, 'no forbidden tool calls on start', brief(startNumbers))
    if (!card) return

    const db = new DatabaseSync(path.join(ctx.userData, 'app.db'), { readOnly: true })
    try {
      const row = db.prepare('SELECT images FROM routing_requests WHERE id = ?').get(startNumbers.routed[0]?.requestId ?? '') as { images?: string | null } | undefined
      const parsed = row?.images ? JSON.parse(row.images) as unknown[] : []
      expect(parsed.length === 1, 'routing_requests should record the pasted image ref', parsed)
    } finally { db.close() }

    const firstWritten = await fileFromTask(ctx, outRel, (text) => text.includes(stampCode) && /李想|华晟/.test(text))
    expect(Boolean(firstWritten?.includes(stampCode)), 'background task should read the pixel-only stampCode from the forwarded screenshot and write it to disk', clip(firstWritten ?? '(no release-check.md)', 400))
    await waitForTaskAndReport(ctx, card.id, agentMsgsAfterStart)

    // Step 2: paste a second screenshot and route a follow-up `message` to the completed task.
    const sinceFollow = Date.now()
    await pasteBannerImage(win, `PATCH: ${patchCode}`)
    await ask(
      win,
      `给刚才做发布核对单的那个任务再补一张补丁核验图：把这张新图里的补丁编号追加写到 ${outRel} 末尾。`,
      { permission: 'allow' },
    )
    const agentMsgsAfterFollow: number = await run(win, `document.querySelectorAll('#thread .msg-agent').length`)
    const followNumbers = summary(ctx, sinceFollow)
    const followActions = actionsOf(followNumbers.routed)
    expect(followActions.some((a) => a.kind === 'message' && a.taskId === card.id), 'the second image should be forwarded via message to the existing task', { card: card.id, ...brief(followNumbers) })
    expect(!followActions.some((a) => a.kind === 'start'), 'no second task should be started', brief(followNumbers))

    const secondWritten = await fileFromTask(ctx, outRel, (text) => text.includes(stampCode) && text.includes(patchCode))
    expect(Boolean(secondWritten?.includes(stampCode) && secondWritten?.includes(patchCode)), 'resumed task should append the second screenshot patchCode while keeping stampCode', clip(secondWritten ?? '(no release-check.md)', 400))
    await waitForTaskAndReport(ctx, card.id, agentMsgsAfterFollow)

    await run(win, `${CARDS}.find((c) => c.dataset.task === ${JSON.stringify(card.id)})?.click()`)
    await until(win, `document.querySelector('#tasks-page .tp-main')?.dataset.task === ${JSON.stringify(card.id)}`, 'the task detail page open')
    const picsShown = await until(win, `(() => {
      const imgs = [...document.querySelectorAll('#tasks-page .tp-thread img.msg-pic')]
      return imgs.length >= 2 && imgs.every((img) => img.complete && img.naturalWidth > 0) ? imgs.length : null
    })()`, 'both forwarded screenshots rendered in the task thread', 15_000).catch(() => 0)
    expect(picsShown >= 2, 'task detail view should render both forwarded images', { picsShown })
    keep(ctx, 'numbers', { stampCode, patchCode, picsShown, start: brief(startNumbers), follow: brief(followNumbers) })
    await ctx.shot('route-image-handoff')
    await escape(win)
  },
}

const routeDropOutside: LiveScenario = {
  id: 'route-drop-outside',
  title: '拖入工作区外的小文本文件快问：宿主安全内联，零跨目录审批卡、零后台任务直接答出内容',
  feature: '文件',
  core: true,
  async run(ctx) {
    const { win, expect, tag } = ctx
    const noticeCode = `EXT-${clearDigits(4)}`
    const outsideFile = path.join(ctx.outDir, `外部场地通知-${tag}.txt`)
    fs.writeFileSync(outsideFile, `【临时变更通知】周五评审改在 7 楼云海报告厅举行，进场凭证号 ${noticeCode}。\n`, 'utf8')
    await fresh(win)
    const since = Date.now(), before = await cardCount(ctx)
    await run(win, `(async () => {
      const current = await window.agent.getDraft()
      await window.agent.appendDraftFiles(current.key, [${JSON.stringify(outsideFile)}])
      return true
    })()`)
    await until(win, `[...document.querySelectorAll('#composer [title]')].some((el) => el.getAttribute('title') === ${JSON.stringify(outsideFile)})`, 'the dropped outside file chip in composer')
    // Deny any cross-directory permission card: host-side <attached-file> inlining must answer without needing DSH read.
    const out = await ask(win, '这份拖进来的通知写在哪间报告厅举行、进场凭证号是多少？直接告诉我。', { permission: 'deny' })
    const numbers = summary(ctx, since)
    const peeks = numbers.tools.filter((t) => t === 'read' || t === 'grep')
    expect(out.cards.length === 0, 'authorized dropped small text file outside workspace should trigger no permission card', out.cards)
    expect(actionsOf(numbers.routed).some((a) => a.kind === 'reply'), 'dropped small text file question should route as reply', brief(numbers))
    expect(!actionsOf(numbers.routed).some((a) => a.kind === 'start'), 'dropped small text file question should start no background task', brief(numbers))
    expect(await cardCount(ctx) === before, 'no new task card should show', brief(numbers))
    expect(peeks.length === 0, 'inlined <attached-file> should answer with zero file tool calls', brief(numbers))
    expect(numbers.forbidden.length === 0, 'no forbidden tool calls', brief(numbers))
    expect(out.answer.includes('云海') && out.answer.includes(noticeCode), 'the answer should contain the venue and noticeCode from the outside file', clip(out.answer, 300))
    keep(ctx, 'numbers', { turnMs: out.ms, cards: out.cards.length, ...brief(numbers) })
    await ctx.shot('route-drop-outside')
  },
}

const routeAmbiguousFile: LiveScenario = {
  id: 'route-ambiguous-file',
  title: '目录多候选文件指代不明：路由前 glob 看文件名后当轮 clarify 反问，不盲开任务，选定后再交后台完成',
  feature: '助手反问',
  core: true,
  async run(ctx) {
    const { win, expect, tag } = ctx
    const dir = `exports-${tag}`
    const codeQ3 = `HD-${clearDigits(4)}`
    const codeQ4 = `HB-${clearDigits(4)}`
    writeWorkspace(ctx, `${dir}/2026-Q3-华东销售表.csv`, `单号,区域,金额\n${codeQ3},华东,41200\n`)
    writeWorkspace(ctx, `${dir}/2026-Q4-华北销售表.csv`, `单号,区域,金额\n${codeQ4},华北,58900\n`)
    await fresh(win)
    const sinceAsk = Date.now(), before = await cardCount(ctx)
    const first = await ask(win, `把工作区 ${dir} 目录里那份销售表整理成简短摘要写到 ${dir}/summary.md。`)
    const askNumbers = summary(ctx, sinceAsk)
    expect(askNumbers.tools[0] === 'glob', 'main agent should call glob once before routing to inspect candidate filenames', brief(askNumbers))
    expect(!askNumbers.tools.includes('read'), 'pre-route disambiguation should only list filenames without reading file bodies', brief(askNumbers))
    expect(actionsOf(askNumbers.routed).some((a) => a.kind === 'clarify'), 'ambiguous candidate files should route as clarify', brief(askNumbers))
    expect(!actionsOf(askNumbers.routed).some((a) => a.kind === 'start'), 'should not blindly start a background task when candidates are ambiguous', brief(askNumbers))
    expect(await cardCount(ctx) === before, 'no task card should appear before clarification', brief(askNumbers))
    expect((/Q3|华东/.test(first.answer)) && (/Q4|华北/.test(first.answer)), 'clarification should name both candidate files', clip(first.answer, 300))

    const sincePick = Date.now()
    await ask(win, '用 Q4 华北那份。', { permission: 'allow' })
    const card = await newCard(ctx, before, 10_000)
    const pickNumbers = summary(ctx, sincePick)
    expect(card !== null && actionsOf(pickNumbers.routed).some((a) => a.kind === 'start'), 'once clarified, it should hand over to a background task', brief(pickNumbers))
    const summaryText = await fileFromTask(ctx, `${dir}/summary.md`, (text) => text.includes(codeQ4) || text.includes('58900'))
    expect(Boolean(summaryText && (summaryText.includes(codeQ4) || summaryText.includes('58900')) && !summaryText.includes(codeQ3)), 'summary.md should use the chosen Q4 file and exclude Q3', clip(summaryText ?? '(no summary.md)', 300))
    keep(ctx, 'numbers', { clarifyMs: first.ms, ask: brief(askNumbers), pick: brief(pickNumbers) })
    await ctx.shot('route-ambiguous-file')
  },
}

const routeImplicitMemory: LiveScenario = {
  id: 'route-implicit-memory',
  title: '无「按老规矩」触发词的记忆隐性术语：新话题自然提问直接命中团队术语对应的文件，不误读干扰项',
  feature: '记忆',
  async run(ctx) {
    const { win, expect, tag } = ctx
    const rightCode = `GW-${clearDigits(4)}`
    let wrongCode = `NG-${clearDigits(4)}`
    while (wrongCode === rightCode) wrongCode = `NG-${clearDigits(4)}`
    const rightFile = `dsh-gateway-${tag}.json`
    const wrongFile = `nginx-${tag}.json`
    writeWorkspace(ctx, rightFile, JSON.stringify({ role: 'gateway', routeCode: rightCode }, null, 2))
    writeWorkspace(ctx, wrongFile, JSON.stringify({ role: 'proxy', routeCode: wrongCode }, null, 2))
    try {
      await fresh(win)
      await ask(win, `记住我们团队的内部术语约定：平时说「网关配置」特指工作区里的 ${rightFile}，不是 ${wrongFile}。`)
      expect((await untilRemembered(win, rightFile)).length > 0, 'the team term mapping should be stored in memory')

      await fresh(win)
      const since = Date.now(), before = await cardCount(ctx)
      // Deliberately omit any cue words like "按老规矩" or "按之前记住的".
      const out = await ask(win, '看一眼工作区里的网关配置，里面的 routeCode 是什么？直接告诉我。', { permission: 'allow' })
      const numbers = summary(ctx, since)
      expect(actionsOf(numbers.routed).some((a) => a.kind === 'reply'), 'single-file lookup with remembered term should route as reply', brief(numbers))
      expect(await cardCount(ctx) === before, 'no background task should be started', brief(numbers))
      expect(out.answer.includes(rightCode) && !out.answer.includes(wrongCode), 'should read the remembered gateway file rather than the nginx distractor', clip(out.answer, 300))
      keep(ctx, 'numbers', { turnMs: out.ms, ...brief(numbers) })
      await ctx.shot('route-implicit-memory')
    } finally {
      await wait(MEMORY_SETTLE_MS)
      for (const word of [rightFile, wrongFile, '网关配置']) await forgetMemories(win, word)
    }
  },
}

const routeImplicitChat: LiveScenario = {
  id: 'route-implicit-chat',
  title: '无触发词的跨话题内部代号：旧话题刚聊过未入记忆的代号，新话题主动查对话记录定位文件速查直答',
  feature: '历史对话',
  async run(ctx) {
    const { win, expect, tag } = ctx
    const alias = `苍穹源-${tag}`
    const rightCode = `TK-${clearDigits(4)}`
    let wrongCode = `TK-${clearDigits(4)}`
    while (wrongCode === rightCode) wrongCode = `TK-${clearDigits(4)}`
    const wrongFile = `cfg-alpha-${tag}.json`
    const rightFile = `cfg-beta-${tag}.json`
    writeWorkspace(ctx, wrongFile, JSON.stringify({ tokenId: wrongCode }, null, 2))
    writeWorkspace(ctx, rightFile, JSON.stringify({ tokenId: rightCode }, null, 2))
    try {
      await fresh(win)
      await ask(win, `同步个项目背景：代号「${alias}」对应的配置文件是工作区里的 ${rightFile}（${wrongFile} 是另一条无关线路）。不用记入长期记忆，直接回复「收到」即可。`)

      await fresh(win)
      const since = Date.now(), before = await cardCount(ctx)
      const out = await ask(win, `看一眼工作区里「${alias}」对应的配置文件，只告诉我它的 tokenId 是多少，不要读也不要提及其他无关文件。`, { permission: 'allow' })
      const numbers = summary(ctx, since)
      const recovered = numbers.tools.filter((t) => t === 'search_conversations' || t === 'read_conversation' || t === 'memory_recall')
      expect(recovered.length >= 1, 'main agent should search conversation/memory to resolve the opaque internal alias', brief(numbers))
      expect(actionsOf(numbers.routed).some((a) => a.kind === 'reply'), 'after resolving the single config file, it should route as reply', brief(numbers))
      expect(await cardCount(ctx) === before, 'no background task should be started for a single-value lookup', brief(numbers))
      expect(out.answer.includes(rightCode) && !out.answer.includes(wrongCode), 'should answer with cfg-beta tokenId rather than cfg-alpha', clip(out.answer, 300))
      keep(ctx, 'numbers', { turnMs: out.ms, recovered, ...brief(numbers) })
      await ctx.shot('route-implicit-chat')
    } finally {
      await wait(MEMORY_SETTLE_MS)
      for (const word of [alias, rightFile]) await forgetMemories(win, word)
    }
  },
}

const routePeekArtifact: LiveScenario = {
  id: 'route-peek-artifact',
  title: '追问后台任务刚落盘产物的附录细节：主会话直接速查产物回答，不发 message 唤醒已结束任务',
  feature: '后台任务',
  core: true,
  async run(ctx) {
    const { win, expect, tag } = ctx
    const dir = `audit-${tag}`
    const appendixCode = `ARC-${clearDigits(4)}`
    writeWorkspace(
      ctx,
      `${dir}/raw.md`,
      `# 11 月发布巡检原始记录\n\n- 本月共完成 12 次灰度发布，整体成功率 100%。\n- 核心服务平均响应 42 ms。\n\n## 附录：归档元数据\n- 归档校验码：${appendixCode}\n- 归档人：周楠\n`,
    )
    await fresh(win)
    const before = await cardCount(ctx)
    await ask(
      win,
      `把 ${dir}/raw.md 整理成正式归档文件写到 ${dir}/audit-final.md（必须原样保留附录里的全部归档元数据）；写完后你的最终汇报只写一句话「已生成归档文件」，不要在汇报文字里列出附录校验码。`,
      { permission: 'allow' },
    )
    const agentMsgsAfterStart: number = await run(win, `document.querySelectorAll('#thread .msg-agent').length`)
    const card = await newCard(ctx, before, 10_000)
    expect(card !== null, 'first turn should start a background task to generate audit-final.md')
    if (!card) return
    const generated = await fileFromTask(ctx, `${dir}/audit-final.md`, (text) => text.includes(appendixCode))
    expect(Boolean(generated?.includes(appendixCode)), 'audit-final.md should be written with the appendix code', clip(generated ?? '(no audit-final.md)', 300))
    await waitForTaskAndReport(ctx, card.id, agentMsgsAfterStart)

    const cardsAfterTask = await cardCount(ctx)
    const sinceFollow = Date.now()
    const follow = await ask(win, `看一眼刚生成的 ${dir}/audit-final.md，附录里的归档校验码写的是什么？直接告诉我。`, { permission: 'allow' })
    const followNumbers = summary(ctx, sinceFollow)
    const followActions = actionsOf(followNumbers.routed)
    const peeks = followNumbers.tools.filter((t) => t === 'read' || t === 'grep')
    expect(followActions.some((a) => a.kind === 'reply'), 'follow-up on a single detail in the written file should route as reply', brief(followNumbers))
    expect(!followActions.some((a) => a.kind === 'message'), 'should not wake up the ended background task via message', brief(followNumbers))
    expect(!followActions.some((a) => a.kind === 'start'), 'should not start a new background task', brief(followNumbers))
    expect(await cardCount(ctx) === cardsAfterTask, 'task card count should stay unchanged', brief(followNumbers))
    expect(followNumbers.tools[0] === 'commit_route' && peeks.length >= 1 && peeks.length <= 2, 'should commit_route first then peek audit-final.md', brief(followNumbers))
    expect(follow.answer.includes(appendixCode), 'should answer with the exact appendixCode read from audit-final.md', clip(follow.answer, 300))
    keep(ctx, 'numbers', { followTurnMs: follow.ms, ...brief(followNumbers) })
    await ctx.shot('route-peek-artifact')
  },
}

export const ROUTING_SCENARIOS: readonly LiveScenario[] = [
  routeReply,
  routePeek,
  routeImagePeek,
  routeImageHandoff,
  routeDropOutside,
  routeAmbiguousFile,
  routeImplicitMemory,
  routeImplicitChat,
  routePeekArtifact,
  routeHandoff,
  routeUpdate,
  routeInterject,
  routeInterjectCorrect,
  routeHistory,
  routeStop,
  routeSchedule,
  routeMemory,
  routeMcp,
].map(isolated)

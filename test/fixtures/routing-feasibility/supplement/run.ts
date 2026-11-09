/**
 * Supplementary routing probe runner. Synthetic data only, fresh DSH home per run, never the user's Viva data.
 *   --suite mech  : scripted fake model, real DSH + production plugins (parallel calls, leaks, interjection, dup, unbound)
 *   --suite live  : real DeepSeek flash with production persona, plugins and thinking defaults
 *   --protocol v1|v2|none   --stream stock|naive|gated   --compact   --scenarios a,b   --repeat N   --out DIR
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { createAcpBridge } from '../../../../src/backend/acp-bridge.ts'
import { ensureDshProfile, vivaLayerFile } from '../../../../src/backend/dsh-profile.ts'
import { dshEnv, dshRuntime } from '../../../../src/backend/dsh-runtime.ts'
import { PERSONA, installedDshVersion, resolvePlugins } from '../../../../src/backend/app-plugins.ts'
import { startScriptedLlm, type FakeAnswer, type FakeBlock, type FakeRequest } from './fake.ts'
import { AMBIGUOUS_TASKS, AMENDED_CORPUS, BRIEF_TASK, MARKET_TASK, SUGGESTION_CORPUS, longSession, readCorpus, searchCorpus, type ProbeTask, type SeedMessage, type StoredMessage } from './data.ts'

const REPO = path.resolve(import.meta.dirname, '../../../..')
const HERE = import.meta.dirname
const { values: args } = parseArgs({ options: {
  suite: { type: 'string', default: 'mech' }, protocol: { type: 'string', default: 'v2' }, stream: { type: 'string', default: 'gated' },
  compact: { type: 'boolean', default: false }, scenarios: { type: 'string' }, repeat: { type: 'string', default: '1' }, out: { type: 'string' },
} })
const live = args.suite === 'live'
const protocol = args.protocol as 'v1' | 'v2' | 'none'
const stream = args.stream as 'stock' | 'naive' | 'gated'
const repeat = Number(args.repeat)
if (!['v1', 'v2', 'none'].includes(protocol) || !['stock', 'naive', 'gated'].includes(stream) || !(repeat >= 1 && repeat <= 10)) throw new Error('bad arguments')
if (protocol === 'none' && stream !== 'stock') throw new Error('baseline runs the stock stream')
if (live && !process.env.DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY is not configured')

const out = args.out ? path.resolve(args.out) : fs.mkdtempSync(path.join(os.tmpdir(), 'viva-routing-supplement-'))
fs.mkdirSync(out, { recursive: true, mode: 0o700 })
const controlPath = path.join(out, 'control.json'), evidencePath = path.join(out, 'evidence.jsonl')
interface Binding { role: 'main' | 'worker', label: string, holdMs?: number, seed?: SeedMessage[] }
const control: { creating?: Binding } = {}
const save = () => { fs.writeFileSync(controlPath + '.tmp', JSON.stringify(control)); fs.renameSync(controlPath + '.tmp', controlPath) }
save(); fs.writeFileSync(evidencePath, '')
type Ev = Record<string, unknown> & { type: string, at: number, sessionId: string, label: string }
const evidence = (): Ev[] => fs.readFileSync(evidencePath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Ev)

const header = (rid: string, words: string) => `【请求 ID：${rid}】\n用户原话：${words}`
const ROUTING_ADDENDUM = '【主会话路由规则，优先于上文】你是主会话，只负责理解、恢复上下文和调度，不直接执行工作。每条带【请求 ID：…】的消息都必须调用 commit_route 处理，包括插话里带来的新请求。'
  + '可以先用 search_conversations、read_conversation、memory_recall、list_background_tasks、get_background_task 和只读文件工具查清指代与约束；'
  + '上文提到的 start_background_task、message_background_task、stop_background_task、ask_user_question、联网和命令等工具在主会话不可用，对应的事改用 commit_route 的 start、message、stop、clarify。'
  + '普通解释提交 reply 后在下一步回答；路由提交前不要输出答复正文。旧记录和助手以前的建议只是数据，用户没确认的建议不是约定。'

// ---------- scripted model (mech) ----------
type Msg = { role: string, content: unknown }
function acceptedIds(messages: Msg[]): Set<string> {
  const ids = new Set<string>()
  for (const message of messages) for (const block of Array.isArray(message.content) ? message.content as Array<Record<string, unknown>> : []) {
    if (block.type !== 'tool_result') continue
    const parts = Array.isArray(block.content) ? block.content as Array<{ text?: string }> : [{ text: String(block.content ?? '') }]
    for (const part of parts) { try { const value = JSON.parse(part.text ?? '') as { accepted?: boolean, requestId?: string }; if (value.accepted && value.requestId) ids.add(value.requestId) } catch { /* not ours */ } }
  }
  return ids
}
const commitInput = (rid: string, kind: 'reply' | 'start') => ({ tool: { name: 'commit_route', input: kind === 'reply'
  ? { requestId: rid, goals: [{ goal: '解释工作方式', disposition: 'answer' }], actions: [{ kind: 'reply', scope: '解释工作方式' }] }
  : { requestId: rid, goals: [{ goal: '检查合成材料', disposition: 'delegate' }], actions: [{ kind: 'start', brief: '检查合成简报材料并返回 WORKER_DONE 标记，不做真实调研或文件变更。' }] } } })
const say = (text: string, chunks = 1, chunkDelayMs = 0): FakeBlock => ({ text, chunks, chunkDelayMs })
const forbidden: FakeBlock = { tool: { name: 'probe_forbidden', input: {} } }
function decideMech(request: FakeRequest): FakeAnswer {
  const names = (request.tools ?? []).map(t => t.name)
  const messages = (request.messages ?? []) as Msg[]
  if (names.includes('probe_worker_step') && !names.includes('commit_route')) return { blocks: [JSON.stringify(messages).includes('"tool_result"') ? say('WORKER_DONE，实验工作完成。') : { tool: { name: 'probe_worker_step', input: {} } }] }
  if (!names.includes('commit_route')) return { blocks: [say('{"add":[],"invalidate":[]}')] }
  const all = JSON.stringify(messages)
  const ids = [...new Set([...all.matchAll(/【请求 ID：([A-Za-z0-9-]+)】/g)].map(m => m[1]))]
  const [r1, r2] = ids
  const scenario = (r1 ?? '').replace(/-\d+$/, '')
  const k = messages.filter(m => m.role === 'assistant').length
  const done = acceptedIds(messages)
  switch (scenario) {
    case 'm-parallel-a': return { blocks: k === 0 ? [commitInput(r1, 'start'), forbidden] : [say('END')] }
    case 'm-parallel-b': return { blocks: k === 0 ? [forbidden, commitInput(r1, 'start')] : [say('END')] }
    case 'm-parallel-c': return { blocks: k === 0 ? [commitInput(r1, 'reply')] : k === 1 ? [say('POST_C'), forbidden] : [say('END_C')] }
    case 'm-leak-reply': return { blocks: k === 0 ? [say('PRE_ROUTE_A'), commitInput(r1, 'reply')] : [say('POST_ROUTE_A')] }
    case 'm-leak-start': return { blocks: k === 0 ? [say('PRE_ROUTE_B'), commitInput(r1, 'start')] : [say('AFTER_B')] }
    case 'm-leak-omit': return { blocks: [say('PRE_ROUTE_OMIT')] }
    case 'm-interject':
      if (!done.has(r1)) return { blocks: [commitInput(r1, 'reply')] }
      if (r2 && !done.has(r2)) return { blocks: [commitInput(r2, 'start')] }
      return { blocks: [k === 1 ? say('R1_ANSWER_' + '增量备份只复制变化的部分。'.repeat(12), 12, 250) : say('R1_CONTINUED')] }
    case 'm-interject-omit':
      if (!done.has(r1)) return { blocks: [commitInput(r1, 'reply')] }
      return { blocks: [k === 1 ? say('R1_ANSWER_' + '增量备份只复制变化的部分。'.repeat(12), 12, 250) : say('IGNORED_R2')] }
    case 'm-dup': return { blocks: k === 0 ? [commitInput(r1, 'reply')] : k === 1 ? [commitInput(r1, 'start')] : [say('DUP_END')] }
    case 'm-bad-v2':
      if (done.has(r1)) return { blocks: [say('BAD_END')] }
      return { blocks: [k === 0 ? { tool: { name: 'commit_route', input: { requestId: r1, goals: [{ goal: '做简报', disposition: 'delegate' }], actions: [{ kind: 'reply', scope: '简报' }] } } } : commitInput(r1, 'start')] }
    default: return { blocks: [say('UNSCRIPTED')] }
  }
}
const fake = live ? null : await startScriptedLlm(decideMech)

// ---------- profile and bridge ----------
const dshHome = path.join(out, 'dsh'), workspace = path.join(out, 'workspace'), userData = path.join(out, 'userData')
fs.mkdirSync(workspace, { recursive: true }); fs.mkdirSync(userData, { recursive: true })
const prod = resolvePlugins({ codeRoot: REPO, userData, dshVersion: installedDshVersion(REPO) })
if (prod.problems.length) console.error('plugin problems', JSON.stringify(prod.problems))
const plugins = [
  { name: 'viva-routing-supplement', dir: HERE, config: { control: controlPath, evidence: evidencePath, protocol, stream: stream === 'stock' ? 'off' : stream } },
  ...prod.plugins.filter(p => stream === 'stock' || p.name !== 'viva-stream'),
]
const persona = protocol === 'none' ? PERSONA : { prefix: PERSONA.prefix + ROUTING_ADDENDUM, suffix: PERSONA.suffix }
ensureDshProfile({ dshHome, profile: 'routing-v2', plugins, persona, models: { providers: {}, deepseek: true, defaultModel: { provider: 'deepseek-official', model: 'deepseek-flash' } } })
// Force compaction cheaply: thresholds as a share of the 1M default window (~12k tokens trigger, ~4k kept).
if (args.compact) fs.appendFileSync(vivaLayerFile(dshHome), '\n- id: compaction-basic\n  config:\n    thresholdRatio: 0.012\n    retainRatio: 0.004\n')

let current: { tasks: ProbeTask[], corpus: StoredMessage[] } = { tasks: [], corpus: [] }
const taskActs: Array<{ at: number, op: string, request: unknown }> = []
const workerTurns: Promise<unknown>[] = []
const events: Array<Record<string, unknown> & { at: number, type: string }> = []
const listeners = new Set<(event: Record<string, unknown> & { at: number, type: string }) => void>()
let workerSeq = 0
let workerHoldMs = 2500
const runtime = dshRuntime({ env: process.env, execPath: process.execPath })
const bridge: ReturnType<typeof createAcpBridge> = createAcpBridge({
  dshBin: path.join(REPO, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), nodeBin: runtime.nodeBin,
  overlay: vivaLayerFile(dshHome), profile: 'routing-v2', cwd: workspace,
  env: dshEnv({ base: process.env, dshHome, runtime, settings: { DEEPSEEK_API_KEY: live ? process.env.DEEPSEEK_API_KEY! : 'probe-fake-key', ...(fake ? { DEEPSEEK_BASE_URL: fake.url } : {}) } }),
  emit: raw => {
    const event = { ...(raw as Record<string, unknown>), at: Date.now() } as Record<string, unknown> & { at: number, type: string }
    events.push(event)
    for (const listener of listeners) listener(event)
    if (event.type === 'permission') bridge.respondPermission(String(event.requestId), null)
  },
  historySearch: query => searchCorpus(current.corpus, query),
  historyRead: (ref, around) => readCorpus(current.corpus, ref, around),
  taskRead: query => {
    if (query.op === 'list') return { tasks: current.tasks.map(t => ({ taskId: t.id, title: t.title, goal: t.goal, status: t.status })), total: current.tasks.length, nextOffset: null }
    const task = current.tasks.find(t => t.id === query.taskId)
    if (!task) throw new Error('没有这个任务')
    return { taskId: task.id, title: task.title, goal: task.goal, status: task.status }
  },
  taskAct: async request => {
    taskActs.push({ at: Date.now(), op: request.op, request })
    if (request.op !== 'start') return { ok: true, op: request.op, recordedOnly: true }
    control.creating = { role: 'worker', label: `worker-${++workerSeq}`, holdMs: workerHoldMs }; save()
    const begun = await bridge.startTask()
    delete control.creating; save()
    if (!begun.ok || !begun.taskId) throw new Error('could not create isolated worker')
    workerTurns.push(bridge.promptTask(begun.taskId, '你当前是工作任务角色，不要路由。请先调用 probe_worker_step 检查合成材料，之后一句话报告 WORKER_DONE。原始委托仅供理解，不进行真实调研或文件变更：' + request.brief))
    return { taskId: begun.taskId, status: 'running' }
  },
})

// ---------- scenarios ----------
interface Plan { requestId: string, actions: Array<Record<string, unknown>>, goals?: unknown, at: number }
interface Ctx {
  rid: string, rid2: string, plans: Plan[], own: Ev[], visible: string, updatesJson: string, ttftMs: number | null,
  acts: typeof taskActs, workerStarted: boolean, mainEndedBeforeWorker: boolean | null, steerAt: number | null, steerResult: unknown,
}
interface Scenario {
  id: string, words?: string, tasks?: ProbeTask[], corpus?: StoredMessage[], seed?: SeedMessage[], unbound?: boolean, holdMs?: number,
  interject?: { words: string, delayMs: number, marker?: string },
  check: (c: Ctx) => string[], extra?: (c: Ctx) => Record<string, unknown>,
}
const planFor = (c: Ctx, rid: string) => c.plans.filter(p => p.requestId === rid).flatMap(p => p.actions)
const kinds = (c: Ctx, rid: string) => planFor(c, rid).map(a => String(a.kind))
const briefs = (c: Ctx, rid: string) => planFor(c, rid).map(a => String(a.brief ?? '')).join(' ')
const has = (c: Ctx, type: string, pred: (e: Ev) => boolean = () => true) => c.own.some(e => e.type === type && pred(e))
const fail = (ok: boolean, message: string) => (ok ? [] : [message])

const MECH: Scenario[] = [
  { id: 'm-parallel-a', check: c => [...fail(!has(c, 'FORBIDDEN_BODY'), 'forbidden body ran'), ...fail(has(c, 'guard_denied', e => e.tool === 'probe_forbidden'), 'forbidden call not denied'), ...fail(c.workerStarted, 'worker not started')] },
  { id: 'm-parallel-b', check: c => [...fail(!has(c, 'FORBIDDEN_BODY'), 'forbidden body ran'), ...fail(has(c, 'guard_denied', e => e.tool === 'probe_forbidden'), 'forbidden call not denied'), ...fail(c.workerStarted, 'worker not started')] },
  { id: 'm-parallel-c', check: c => [...fail(!has(c, 'FORBIDDEN_BODY'), 'forbidden body ran after reply'), ...fail(c.visible.includes('POST_C'), 'authorized text missing')] },
  { id: 'm-leak-reply', check: c => [...fail(!c.updatesJson.includes('PRE_ROUTE_A'), 'pre-route text reached the app'), ...fail(c.visible.includes('POST_ROUTE_A'), 'authorized text missing')] },
  { id: 'm-leak-start', check: c => [...fail(!c.updatesJson.includes('PRE_ROUTE_B'), 'pre-route text reached the app'), ...fail(c.workerStarted, 'worker not started')] },
  { id: 'm-leak-omit', check: c => [...fail(!c.updatesJson.includes('PRE_ROUTE_OMIT'), 'unrouted text reached the app'), ...fail(has(c, 'route_failed'), 'route failure not recorded')] },
  { id: 'm-interject', interject: { words: '另外帮我做一份完整的 A 股分析。', delayMs: 300, marker: 'R1_ANSWER' },
    check: c => [...fail(has(c, 'request_registered', e => e.requestId === c.rid2 && e.interjection === true), 'interjected request not registered'),
      ...fail(kinds(c, c.rid2).includes('start'), 'interjected request not routed to start'), ...fail(c.workerStarted, 'worker not started'),
      ...fail(c.visible.includes('R1_ANSWER') && c.visible.includes('R1_CONTINUED'), 'first answer did not continue'), ...fail(!has(c, 'route_failed'), 'a request failed')] },
  { id: 'm-interject-omit', interject: { words: '另外帮我做一份完整的 A 股分析。', delayMs: 300, marker: 'R1_ANSWER' },
    check: c => [...fail(has(c, 'repair', e => (e.requestIds as string[]).includes(c.rid2)), 'no repair for the interjected request'),
      ...fail(has(c, 'route_failed', e => e.requestId === c.rid2), 'missing interjection not failed'), ...fail(!c.visible.includes('IGNORED_R2'), 'text shown while a request was pending')] },
  { id: 'm-dup', check: c => [...fail(has(c, 'route_rejected', e => String(e.reason).includes('已经提交过')), 'second decision not rejected'), ...fail(c.plans.length === 1, 'decision overwritten')] },
  { id: 'm-bad-v2', check: c => [...fail(has(c, 'route_rejected'), 'inconsistent plan accepted'), ...fail(kinds(c, c.rid).includes('start'), 'corrected plan not accepted')] },
  { id: 'm-unbound', unbound: true, check: c => [...fail(has(c, 'unbound_prompt_refused') || c.own.length === 0, 'unbound prompt not refused'), ...fail(!c.own.some(e => e.type === 'tool_call'), 'unbound session ran a tool'), ...fail(c.visible === '', 'unbound session produced text')] },
]

const deniedAfter = (c: Ctx, since: number) => c.own.filter(e => e.type === 'guard_denied' && e.at >= since).map(e => String(e.tool))
const LIVE: Scenario[] = [
  { id: 'new-work', words: '帮我做一份今日简报，整理工作相关的信息，形成一份完整的报告。',
    check: c => protocol === 'none' ? [] : fail(kinds(c, c.rid).includes('start'), 'work not delegated'),
    extra: c => ({ delegated: c.acts.some(a => a.op === 'start'), denied: deniedAfter(c, 0) }) },
  { id: 'update-existing', words: '简报里再加上科技新闻。', tasks: [BRIEF_TASK, MARKET_TASK],
    check: c => fail(planFor(c, c.rid).some(a => a.kind === 'message' && a.taskId === BRIEF_TASK.id) && !kinds(c, c.rid).includes('start'), 'update did not target the briefing task') },
  { id: 'mixed', words: '简报改成英文，另外帮我分析一下今天的 A 股行情，写一份完整分析。', tasks: [BRIEF_TASK],
    check: c => fail(planFor(c, c.rid).some(a => a.kind === 'message' && a.taskId === BRIEF_TASK.id) && kinds(c, c.rid).includes('start'), 'mixed request not split') },
  { id: 'ambiguous', words: '把那个报告改成英文。', tasks: AMBIGUOUS_TASKS,
    check: c => kinds(c, c.rid).some(k => ['message', 'stop', 'start'].includes(k)) ? ['ambiguous target was guessed'] : fail(kinds(c, c.rid).includes('clarify'), 'clarification not structured') },
  { id: 'suggestion', words: '按我们之前定好的简报格式，做今天的简报。', corpus: SUGGESTION_CORPUS,
    check: c => briefs(c, c.rid).includes('ONLY-SUGGESTED-842') || kinds(c, c.rid).includes('start') ? ['unconfirmed suggestion used to start work'] : fail(kinds(c, c.rid).includes('clarify'), 'clarification not structured'),
    extra: c => ({ searches: c.own.filter(e => e.type === 'tool_call' && e.tool === 'search_conversations').length }) },
  { id: 'retrieval', words: '按之前定好的标准，做今天的简报。', corpus: AMENDED_CORPUS,
    check: c => { const b = briefs(c, c.rid); return fail(kinds(c, c.rid).includes('start'), 'work not delegated').concat(fail(b.includes('ROUTE-JADE-7391') && b.includes('相关性') && b.includes('中文'), 'amended standard not carried into brief')) },
    extra: c => ({ searches: c.own.filter(e => e.type === 'tool_call' && e.tool === 'search_conversations').length, reads: c.own.filter(e => e.type === 'tool_call' && e.tool === 'read_conversation').length, mentionsOldRule: /按行业排序/.test(briefs(c, c.rid)) }) },
  { id: 'stream', words: '用两句话解释后台任务和普通回答有什么区别。',
    check: c => [...(protocol === 'none' ? [] : fail(kinds(c, c.rid).includes('reply'), 'not routed as reply')), ...fail(c.visible.length > 10, 'no visible answer')] },
  { id: 'compact', words: '按我们之前最终定的简报标准，做今天的简报。', seed: longSession(),
    check: c => { const b = briefs(c, c.rid); return [...fail(has(c, 'compaction_event'), 'PREMISE: compaction did not run'), ...fail(kinds(c, c.rid).includes('start'), 'work not delegated'), ...fail(b.includes('ROUTE-JADE-7391') && b.includes('相关性'), 'amended standard lost after compaction')] },
    extra: c => ({ compactions: c.own.filter(e => e.type === 'compaction_event').map(e => e.eventType), mentionsOldRule: /按行业排序/.test(briefs(c, c.rid)), searches: c.own.filter(e => e.type === 'tool_call' && e.tool === 'search_conversations').length }) },
  { id: 'interject', words: '详细解释一下增量备份和全量备份的区别，以及各自适合什么场景。分五点说，每点三四句话。', holdMs: 12_000,
    interject: { words: '另外帮我把今天的 A 股行情做一份完整的分析报告。', delayMs: 500 },
    check: c => {
      if (protocol === 'none') return []
      return [...fail(c.steerAt !== null, 'PREMISE: interjection not sent while answering'), ...fail(kinds(c, c.rid2).includes('start'), 'interjected work not delegated'),
        ...fail(c.visible.length > 200, 'first answer cut short'), ...fail(!has(c, 'route_failed'), 'a request failed')]
    },
    extra: c => {
      const after = c.steerAt ?? Infinity
      const r2 = c.plans.find(p => p.requestId === c.rid2)
      return { steerResult: c.steerResult, steerToDecisionMs: r2 && c.steerAt ? r2.at - c.steerAt : null, delegatedAfterSteer: c.acts.some(a => a.op === 'start' && a.at >= after), deniedAfterSteer: deniedAfter(c, after), toolsAfterSteer: c.own.filter(e => e.type === 'tool_call' && e.at >= after).map(e => e.tool) }
    } },
]

// ---------- run ----------
const textOfUpdate = (event: Record<string, unknown>): string => {
  const update = event.update as Record<string, unknown> | undefined
  if (!update) return ''
  if (update.sessionUpdate === 'viva_stream' && update.kind === 'delta' && update.blockType === 'text') return String(update.text ?? '')
  if (update.sessionUpdate === 'agent_message_chunk') return String((update.content as { text?: string } | undefined)?.text ?? '')
  return ''
}
const pool = live ? LIVE : MECH
const wanted = args.scenarios?.split(',')
const selected = pool.filter(s => !wanted || wanted.includes(s.id))
if (!selected.length) throw new Error('no scenarios selected')
const results: Array<Record<string, unknown>> = []
let started = false
let failure: string | undefined
const withTimeout = <T>(promise: Promise<T>, ms: number) => {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([promise, new Promise<never>((_r, reject) => { timer = setTimeout(() => { void bridge.cancel(); reject(new Error(`timed out after ${ms} ms`)) }, ms) })]).finally(() => clearTimeout(timer))
}
try {
  for (const scenario of selected) for (let attempt = 1; attempt <= repeat; attempt++) {
    const label = `${scenario.id}-${attempt}`, rid = label, rid2 = `${label}-b`
    current = { tasks: scenario.tasks ?? [], corpus: scenario.corpus ?? [] }
    workerHoldMs = scenario.holdMs ?? 2500
    if (scenario.unbound) delete control.creating
    else control.creating = { role: 'main', label, seed: scenario.seed }
    save()
    const info = started ? await bridge.newSession() : await bridge.start()
    started = true
    delete control.creating; save()
    if (!info.sessionId) throw new Error('no session id')
    if (scenario.seed) {
      control.creating = { role: 'main', label: 'temporary-switch' }; save()
      await bridge.newSession()
      delete control.creating; save()
      await bridge.switchSession(info.sessionId)
    }
    const workerBefore = workerTurns.length, actsBefore = taskActs.length
    const begin = Date.now()
    let steerAt: number | null = null, steerResult: unknown = null, firstText: number | null = null
    const listener = (event: Record<string, unknown> & { at: number, type: string }) => {
      if (event.type !== 'update' || event.sessionId !== info.sessionId) return
      const text = textOfUpdate(event)
      if (!text) return
      if (firstText === null) firstText = event.at
      const interject = scenario.interject
      if (interject && steerAt === null && (!interject.marker || text.includes(interject.marker) || firstText !== null)) {
        steerAt = -1
        setTimeout(() => {
          steerAt = Date.now()
          bridge.steer(protocol === 'none' ? interject.words : header(rid2, interject.words)).then(result => { steerResult = result }, error => { steerResult = String(error) })
        }, interject.delayMs)
      }
    }
    listeners.add(listener)
    let promptError: string | null = null
    try { await withTimeout(bridge.prompt(protocol === 'none' ? scenario.words ?? '解释工作方式。' : header(rid, scenario.words ?? '解释工作方式。')), live ? 300_000 : 60_000) }
    catch (error) { promptError = error instanceof Error ? error.message : String(error) }
    listeners.delete(listener)
    const mainEnd = Date.now()
    if (workerTurns.length > workerBefore) await withTimeout(Promise.allSettled(workerTurns.slice(workerBefore)), 120_000).catch(() => undefined)
    const workerEnd = events.filter(e => e.type === 'task_end' && e.at >= begin).at(-1)?.at
    const own = evidence().filter(e => e.sessionId === info.sessionId)
    const mainUpdates = events.filter(e => e.type === 'update' && e.sessionId === info.sessionId && e.at >= begin)
    const ctx: Ctx = {
      rid, rid2, own,
      plans: own.filter(e => e.type === 'route_committed').map(e => ({ requestId: String(e.requestId), actions: e.actions as Array<Record<string, unknown>>, goals: e.goals, at: e.at })),
      visible: mainUpdates.map(textOfUpdate).join(''), updatesJson: JSON.stringify(mainUpdates), ttftMs: firstText === null ? null : firstText - begin,
      acts: taskActs.slice(actsBefore), workerStarted: evidence().some(e => e.type === 'worker_started' && e.at >= begin),
      mainEndedBeforeWorker: workerEnd === undefined ? null : mainEnd < workerEnd, steerAt: steerAt !== null && steerAt > 0 ? steerAt : null, steerResult,
    }
    const failures = [...scenario.check(ctx), ...(promptError && !scenario.unbound ? ['prompt error: ' + promptError] : [])]
    const errors = events.filter(e => e.at >= begin && e.type === 'error').map(e => String(e.message ?? ''))
    const result = {
      id: scenario.id, attempt, passed: failures.length === 0, failures, ms: mainEnd - begin, ttftMs: ctx.ttftMs,
      plans: ctx.plans.map(p => ({ requestId: p.requestId, goals: p.goals, actions: p.actions })),
      rejects: own.filter(e => e.type === 'route_rejected').map(e => e.reason), repairs: own.filter(e => e.type === 'repair').length,
      denied: own.filter(e => e.type === 'guard_denied').map(e => ({ tool: e.tool, args: e.args })),
      toolCalls: own.filter(e => e.type === 'tool_call').map(e => e.tool), acts: ctx.acts.map(a => ({ op: a.op, request: a.request })),
      mainEndedBeforeWorker: ctx.mainEndedBeforeWorker, visibleText: ctx.visible.slice(0, 1500), errors, ...(scenario.extra?.(ctx) ?? {}),
    }
    results.push(result)
    console.log(JSON.stringify({ id: result.id, attempt, passed: result.passed, failures, ms: result.ms, ttftMs: result.ttftMs, kinds: ctx.plans.map(p => `${p.requestId.endsWith('-b') ? 'R2:' : ''}${p.actions.map(a => a.kind).join('+')}`), rejects: result.rejects.length, denied: result.denied.map(d => d.tool) }))
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ suite: args.suite, protocol, stream, compact: args.compact, results }, null, 2))
  }
} catch (error) { failure = error instanceof Error ? error.stack ?? error.message : String(error); console.error('Probe failed:', failure) }
finally { await bridge.dispose(); await fake?.close() }
fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ suite: args.suite, protocol, stream, compact: args.compact, results, failure }, null, 2))
console.log('Evidence directory: ' + out)
process.exitCode = failure ? 2 : results.some(r => !r.passed) ? 1 : 0

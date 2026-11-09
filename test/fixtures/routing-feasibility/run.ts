/** Explicit CLI only: never part of automatic test discovery. Uses synthetic data and a fresh DSH home. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { createAcpBridge } from '../../../src/backend/acp-bridge.ts'
import { ensureDshProfile, vivaLayerFile } from '../../../src/backend/dsh-profile.ts'
import { dshEnv, dshRuntime } from '../../../src/backend/dsh-runtime.ts'
import { startFakeLlm } from '../fake-llm.js'
import { PERSONA, type Action, type Control, type Evidence, type Fixture, type HistoricalMessage, type ProbeTask } from './contract.ts'

const root = path.resolve(import.meta.dirname, '../../..')
const { values: args } = parseArgs({ options: { live: { type: 'boolean', default: false }, repeat: { type: 'string', default: '1' }, only: { type: 'string' }, out: { type: 'string' } } })
const repeat = Number(args.repeat)
assert.ok(Number.isInteger(repeat) && repeat >= 1 && repeat <= 3)
if (args.live && !process.env.DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY is not configured')
const out = args.out ? path.resolve(args.out) : fs.mkdtempSync(path.join(os.tmpdir(), 'viva-routing-feasibility-'))
fs.mkdirSync(out, { recursive: true, mode: 0o700 })
const controlPath = path.join(out, 'control.json'), evidencePath = path.join(out, 'evidence.jsonl')
const control: Control = { sessions: {} }
function save() { fs.writeFileSync(controlPath + '.tmp', JSON.stringify(control)); fs.renameSync(controlPath + '.tmp', controlPath) }
save(); fs.writeFileSync(evidencePath, '')
const evidence = (): Evidence[] => fs.readFileSync(evidencePath, 'utf8').trim().split('\n').filter(Boolean).map((line: string) => JSON.parse(line) as Evidence)
const fake = args.live ? null : await startFakeLlm({ decideFirst: (raw: object) => {
  const request = raw as { tools?: { name: string }[], messages?: unknown[] }
  const names = request.tools?.map(t => t.name) ?? []
  const messages = JSON.stringify(request.messages)
  if (names.includes('probe_worker_step') && !names.includes('commit_route')) return messages.includes('WORKER_DONE') ? { text: 'WORKER_DONE，实验工作完成。' } : { tool: { name: 'probe_worker_step', input: {} } }
  if (!names.includes('commit_route')) return null
  const requestId = messages.match(/当前请求 ID：([a-z0-9-]+)/)?.[1] ?? ''
  if (requestId.startsWith('always-omit')) return { text: 'UNCOMMITTED_OUTPUT' }
  if (requestId.startsWith('repair') && !messages.includes('【路由补交】')) return { text: 'UNCOMMITTED_OUTPUT' }
  if (messages.includes('"tool_result"') && messages.includes('accepted')) return { text: 'COMMITTED_STREAM_OUTPUT：我会先理解，再分派。' }
  return { tool: { name: 'commit_route', input: { requestId, actions: [{ kind: requestId.startsWith('handoff') ? 'start' : 'reply', brief: '检查合成简报材料，返回 WORKER_DONE。' }] } } }
} })
const dshHome = path.join(out, 'dsh'), workspace = path.join(out, 'workspace')
fs.mkdirSync(workspace, { recursive: true })
ensureDshProfile({ dshHome, profile: 'routing-feasibility', plugins: [
  { name: 'viva-routing-feasibility', dir: import.meta.dirname, config: { control: controlPath, evidence: evidencePath } },
  { name: 'viva-stream', dir: path.join(root, 'plugins/stream') },
], persona: PERSONA, models: { providers: {}, deepseek: true, defaultModel: { provider: 'deepseek-official', model: 'deepseek-flash' } } })
// Bound output and disable extra reasoning for a small, reproducible feasibility experiment.
fs.appendFileSync(vivaLayerFile(dshHome), "\n- id: llm-deepseek\n  config:\n    maxTokens: 2500\n    thinking: disabled\n")
const runtime = dshRuntime({ env: process.env, execPath: process.execPath })
const workerTurns: Promise<void>[] = []
const events: Array<Record<string, unknown> & { at: number }> = []
let bridge: ReturnType<typeof createAcpBridge>
let workerSeq = 0
bridge = createAcpBridge({
  dshBin: path.join(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), nodeBin: runtime.nodeBin,
  overlay: vivaLayerFile(dshHome), profile: 'routing-feasibility', cwd: workspace,
  env: dshEnv({ base: process.env, dshHome, runtime, settings: { DEEPSEEK_API_KEY: args.live ? process.env.DEEPSEEK_API_KEY! : 'probe-fake-key', ...(fake ? { DEEPSEEK_BASE_URL: fake.url } : {}) } }),
  emit: event => { events.push({ ...event, at: Date.now() }) },
  taskAct: async (request, originSessionId) => {
    if (request.op !== 'start') throw new Error('probe only performs safe task start')
    const workerFixture: Fixture = { requestId: 'worker-' + (++workerSeq), role: 'worker', history: [], tasks: [], holdMs: control.sessions[originSessionId]?.requestId.startsWith('handoff-followup') ? 12_000 : 2500 }
    control.creating = workerFixture; save()
    const begun = await bridge.startTask()
    if (!begun.ok || !begun.taskId) throw new Error('could not create isolated worker')
    const taskId = begun.taskId
    control.sessions[taskId] = workerFixture; delete control.creating; save()
    workerTurns.push(bridge.promptTask(taskId, '你当前是工作任务角色，不要路由。请先调用 probe_worker_step 检查合成材料，之后一句话报告 WORKER_DONE。原始委托仅供理解，不进行真实调研或文件变更：' + request.brief))
    return { taskId, status: 'running' }
  },
})
interface Result { id: string, attempt: number, passed: boolean, ms: number, failures: string[], actions: Action[], repairs: number, allowedDeltas: number, blockedDeltas: number, searches: number, reads: number, mainEndedBeforeWorker: boolean | null, visibleText: string, followup?: { ms: number, endedBeforeWorker: boolean, text: string, actions: Action[] } }
interface Scenario { id: string, request: string, history?: HistoricalMessage[], tasks?: ProbeTask[], seed?: boolean, guards?: boolean, check: (actions: Action[], log: Evidence[], text: string) => string[] }
const tasks: ProbeTask[] = [{ id: 'brief-task', title: '今日简报', goal: '整理每日工作相关资讯，输出中文简报', status: 'running' }, { id: 'market-task', title: '行情分析', goal: '分析 A 股行情', status: 'running' }]
const corpus = (turns: number, tag: string): HistoricalMessage[] => Array.from({ length: turns }, (_, i) => [
  { id: `${tag}-u${i}`, role: 'user' as const, text: `无关话题 ${i}：讨论合成项目 ${tag}-${i} 的会议安排。` },
  { id: `${tag}-a${i}`, role: 'assistant' as const, text: `可以，把合成项目 ${i} 的会议安排记录在本轮讨论中。` },
]).flat()
const old = corpus(80, 'old')
old[0] = { id: 'old-u0', role: 'user', text: '我们确定今日简报的规则：先按行业排序，先不要用英文。' }
old[1] = { id: 'old-a0', role: 'assistant', text: '收到，简报按行业排序。' }
old[2] = { id: 'old-u1', role: 'user', text: '更正刚才的今日简报规则：最终按与 Viva 项目的相关性排序，正文用中文，开头必须包含识别码 ROUTE-JADE-7391。以后说按原标准，就指这一版。' }
old[3] = { id: 'old-a1', role: 'assistant', text: '确认，采用新的相关性排序、中文和识别码。' }
const suggested = corpus(30, 'proposal')
suggested[0] = { id: 'proposal-u0', role: 'user', text: '讨论下今日简报的格式选项，先不要定，我还没决定排序或语言。' }
suggested[1] = { id: 'proposal-a0', role: 'assistant', text: '我建议英文、按行业排序，开头加上 ONLY-SUGGESTED-842。等你确认。' }
const scenarios: Scenario[] = args.live ? [
  { id: 'handoff-followup-complete', request: '请把以下合成材料整理为中文简报并保存到工作区 report.md：项目甲完成测试；项目乙等待接口；项目丙需要排期。列出进展和下一步，完成后告诉我。', check: a => a.some(x => x.kind === 'start') ? [] : ['fully specified file-writing work was not handed off'] },
  { id: 'new-work', request: '帮我制作今日简报，整理工作相关信息，形成一份完整报告。', check: a => a.some(x => x.kind === 'start') ? [] : ['independent work was not delegated'] },
  { id: 'update-existing', request: '简报里增加科技新闻。', tasks, check: a => a.some(x => x.kind === 'message' && x.taskId === 'brief-task') && !a.some(x => x.kind === 'start') ? [] : ['update did not target the original briefing task'] },
  { id: 'mixed', request: '简报改成英文，另外帮我分析一下今天的 A 股行情，写一份完整分析。', tasks: [tasks[0]], check: a => a.some(x => x.kind === 'message' && x.taskId === 'brief-task') && a.some(x => x.kind === 'start') ? [] : ['mixed request did not produce update and start'] },
  { id: 'ambiguous', request: '把那个改成英文。', tasks: [{ ...tasks[0], title: '报告' }, { ...tasks[1], title: '报告' }], check: a => a.some(x => x.kind === 'clarify') && !a.some(x => ['message', 'stop'].includes(x.kind)) ? [] : [a.some(x => ['message', 'stop'].includes(x.kind)) ? 'ambiguous target was guessed' : 'clarification was not submitted with structured clarify'] },
  { id: 'history-80-session', request: '按我们之前最终确定的标准，制作今天的简报。', history: old, seed: true, check: a => { const b = a.filter(x => x.kind === 'start').map(x => x.brief ?? '').join(' '); return /ROUTE-JADE-7391/.test(b) && /相关性/.test(b) && /中文/.test(b) ? [] : ['80-turn session context or changed agreement was lost'] } },
  { id: 'history-80-retrieval', request: '按我们以前讨论的今日简报最终标准，制作今天的。当前上下文没有标准，先找回以前的原文。', history: old, check: (a,log) => { const b=a.map(x=>x.brief??'').join(' '); return b.includes('ROUTE-JADE-7391') && /相关性/.test(b) && log.some(e=>e.type==='read_history') ? [] : ['retrieval did not recover and read the changed original agreement'] } },
  { id: 'suggestion-not-confirmed', request: '按我们以前已经确定的简报格式，制作今天的简报。先查旧记录，别猜。', history: suggested, check: a => a.some(x=>x.kind==='clarify') && !a.some(x=>x.kind==='start') ? [] : [a.some(x => x.kind === 'start') ? 'unconfirmed context was used to start work' : 'missing confirmation was explained via reply rather than structured clarify'] },
  { id: 'ordinary-stream', request: '用两句话解释后台任务和普通回答的区别。', guards: true, check: (a,log,text) => a.some(x=>x.kind==='reply') && log.some(x=>x.type==='text_delta'&&x.allowed===true) && text.length>10 ? [] : ['reply did not continue as a visible stream'] },
] : [
  { id: 'repair', request: '解释工作方式。', check: (a,log,text)=>a.some(x=>x.kind==='reply')&&log.some(x=>x.type==='repair')&&text.includes('COMMITTED_STREAM_OUTPUT')&&!text.includes('UNCOMMITTED_OUTPUT') ? []:['repair or stream gate failed'] },
  { id: 'scope', request: '解释工作方式。', guards: true, check: (_a,log)=>log.filter(x=>x.type==='direct_guard_probe'&&x.denied===true).length===2&&!log.some(x=>x.type==='FORBIDDEN_BODY'||x.type==='SCOPED_BODY') ? []:['tool visibility or scoped execution guard failed'] },
  { id: 'handoff', request: '制作简报。', check: (a)=>a.some(x=>x.kind==='start')?[]:['handoff was not committed'] },
  { id: 'always-omit', request: '解释工作方式。', check: (_a,log,text)=>log.filter(x=>x.type==='repair').length===2&&log.some(x=>x.type==='route_failed')&&text===''?[]:['missing-route retry was not bounded or text leaked'] },
]
const selected = scenarios.filter(s=>!args.only||args.only.split(',').includes(s.id))
assert.ok(selected.length,'no selected scenarios')
const results: Result[]=[]
let failure: string|undefined
try {
  const first = selected[0]
  control.creating = { requestId: `${first.id}-1`, role: 'main', history: first.history ?? [], tasks: first.tasks ?? [], seedHistory: first.seed, exerciseGuards: first.guards }; save()
  const initial = await bridge.start()
  for (const scenario of selected) for (let attempt=1;attempt<=repeat;attempt++) {
    const requestId = `${scenario.id}-${attempt}`
    const fixture: Fixture={requestId,role:'main',history:scenario.history??[],tasks:scenario.tasks??[],seedHistory:scenario.seed,exerciseGuards:scenario.guards}
    control.creating=fixture;save()
    const info = results.length===0 ? initial : await bridge.newSession()
    assert.ok(info.sessionId)
    control.sessions[info.sessionId]=fixture;delete control.creating;save()
    if (scenario.seed) {
      // Recreate the driver from persisted history so its turn counter also resumes at 80.
      control.creating = { requestId: 'temporary-switch', role: 'main', history: [], tasks: [] }; save()
      await bridge.newSession()
      delete control.creating; save()
      await bridge.switchSession(info.sessionId)
    }
    const begin=Date.now(), workerBefore=workerTurns.length
    const turn = bridge.prompt(`当前请求 ID：${requestId}\n用户原话：${scenario.request}`)
    let timer: ReturnType<typeof setTimeout>|undefined
    try { await Promise.race([turn,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>{void bridge.cancel();reject(new Error('probe timed out after 150 seconds'))},150_000)})]) }
    finally { if(timer)clearTimeout(timer) }
    const mainEnd=Date.now()
    const own=evidence().filter(e=>e.sessionId===info.sessionId&&e.requestId===requestId)
    const commits=own.filter(e=>e.type==='route_committed')
    const actions=commits.flatMap(e=>e.actions as Action[])
    const deltas=own.filter(e=>e.type==='text_delta')
    const text=deltas.filter(e=>e.allowed===true).map(e=>String(e.text)).join('')
    const failures=scenario.check(actions,own,text)
    const errors=events.filter(e=>e.at>=begin&&e.type==='error')
    if(errors.length)failures.push('ACP reported error: '+String(errors[0].message??'unknown'))
    let followup: Result['followup']
    if (scenario.id.startsWith('handoff-followup') && workerTurns.length > workerBefore) {
      const deadline = Date.now() + 15_000
      while (!evidence().some(e => e.type === 'worker_started' && e.at >= begin) && Date.now() < deadline) await new Promise<void>(resolve => setTimeout(resolve, 50))
      const followId = requestId + '-followup'
      control.sessions[info.sessionId] = { ...fixture, requestId: followId, seedHistory: false }; save()
      const followBegin = Date.now()
      await bridge.prompt(`当前请求 ID：${followId}\n用户原话：我刚才让你做的是什么？只用一句话回答，不要新建任务。`)
      const followEnd = Date.now(), logs = evidence().filter(e => e.requestId === followId)
      followup = { ms: followEnd - followBegin, endedBeforeWorker: !events.some(e => e.type === 'task_end' && e.at >= begin && e.at <= followEnd), text: logs.filter(e => e.type === 'text_delta' && e.allowed === true).map(e => String(e.text)).join(''), actions: logs.filter(e => e.type === 'route_committed').flatMap(e => e.actions as Action[]) }
      if (!followup.endedBeforeWorker || !followup.actions.some(a => a.kind === 'reply') || !/简报/.test(followup.text)) failures.push('same-session follow-up did not finish with context while worker remained active')
    }
    if(workerTurns.length>workerBefore)await Promise.all(workerTurns.slice(workerBefore))
    const workerEnd=events.filter(e=>e.type==='task_end'&&e.at>=begin).at(-1)?.at
    const result: Result={id:scenario.id,attempt,passed:failures.length===0,ms:mainEnd-begin,failures,actions,repairs:own.filter(e=>e.type==='repair').length,allowedDeltas:deltas.filter(e=>e.allowed===true).length,blockedDeltas:deltas.filter(e=>e.allowed!==true).length,searches:own.filter(e=>e.type==='search_history').length,reads:own.filter(e=>e.type==='read_history').length,mainEndedBeforeWorker:workerEnd===undefined?null:mainEnd<workerEnd,visibleText:text,followup}
    if(scenario.id==='handoff'&&result.mainEndedBeforeWorker!==true){result.failures.push('main turn did not finish before worker');result.passed=false}
    results.push(result)
    console.log(JSON.stringify({id:result.id,attempt,passed:result.passed,ms:result.ms,failures:result.failures,repairs:result.repairs,searches:result.searches,reads:result.reads,mainEndedBeforeWorker:result.mainEndedBeforeWorker}))
    fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({mode:args.live?'live':'fake',model:'deepseek-official/deepseek-flash',displayName:'DeepSeek-V41-Flash',out,results},null,2))
  }
} catch(error) { failure=error instanceof Error?error.message:String(error);console.error('Probe failed:',failure) }
finally { await bridge.dispose();await fake?.close() }
fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({mode:args.live?'live':'fake',model:'deepseek-official/deepseek-flash',displayName:'DeepSeek-V41-Flash',out,results,failure},null,2))
console.log('Evidence directory: '+out)
process.exitCode=failure||results.some(r=>!r.passed)?1:0

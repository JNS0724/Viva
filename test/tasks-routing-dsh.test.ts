import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { DSH_TIMEOUT_MS, replies, startHarness } from './fixtures/dsh-harness.js'
import { MAIN_SCOPE } from '../plugins/routing/lib/policy.ts'

/** viva-routing inside the real dsh, with the fake model (fake-llm.js) routing as the main agent would. */

type Part = { type: string, name?: string, text?: string, content?: unknown }
type ModelRequest = { system?: unknown, tools?: Array<{ name: string }>, messages: Array<{ role: string, content: Part[] | string }> }
const toolsOf = (request: ModelRequest) => (request.tools ?? []).map(tool => tool.name)
/** The model requests of the main conversation: those offered commit_route. */
const mainRequests = (requests: ModelRequest[]) => requests.filter(request => toolsOf(request).includes('commit_route'))
const partsOf = (content: Part[] | string): Part[] => (Array.isArray(content) ? content : [{ type: 'text', text: content }])
const lastResult = (request: ModelRequest) => partsOf(request.messages.at(-1)!.content).find(part => part.type === 'tool_result')

test('the main session is narrowed before its first step, under its own persona; its answer shows only after its route', { timeout: DSH_TIMEOUT_MS }, async (t) => {
  const { events, llm, requests, bridge } = await startHarness(t)
  const agent = bridge()
  await agent.start()
  await agent.prompt('你好')

  const main = mainRequests(llm.requests as ModelRequest[])
  assert.ok(main.length >= 2, 'a routing step, then the answer')
  for (const tool of toolsOf(main[0]!)) assert.ok(MAIN_SCOPE.includes(tool), `${tool} is not the main agent's`)
  assert.equal(toolsOf(main[0]!).includes('bash'), false, 'narrowed already at the first step')
  const system = JSON.stringify(main[0]!.system)
  assert.match(system, /必须调用一次 commit_route/, 'the main conversation\'s persona')
  assert.doesNotMatch(system, /ask_user_question/, 'in place of the profile\'s, not on top of it')
  const shown = replies(events)
  assert.equal(shown.length, 1, 'one answer, and no routing step shows')
  assert.match(shown[0]!, /收到：「你好」$/)
  assert.doesNotMatch(shown[0]!, /请求 ID|commit_route|"accepted"/)
  const sessionId = agent.currentSession()!
  assert.deepEqual(requests.endTurn({ sessionId, reason: 'unrouted' }), [], 'the request was decided')
})

test('a task is not narrowed and never sees commit_route; it works under the profile\'s persona', { timeout: DSH_TIMEOUT_MS }, async (t) => {
  const { llm, bridge } = await startHarness(t)
  const agent = bridge()
  await agent.start()
  await agent.prompt('你好')
  const task = await agent.startTask()
  assert.ok(task.ok && task.taskId, JSON.stringify(task))
  await agent.promptTask(task.taskId, '午饭吃什么')

  const asked = (llm.requests as ModelRequest[]).find(request => JSON.stringify(request.messages).includes('午饭吃什么'))!
  assert.equal(toolsOf(asked).includes('commit_route'), false)
  assert.ok(toolsOf(asked).includes('bash') || toolsOf(asked).includes('pwsh'), 'its own tools')
  assert.match(JSON.stringify(asked.system), /ask_user_question/)
  assert.doesNotMatch(JSON.stringify(asked.system), /commit_route/)
})

/** The app's task runtime as the decisions use it, starting every task as `t-1` and keeping the briefs. */
function startingTasks(briefs: string[]) {
  const never = async () => { throw new Error('not asked') }
  return { start: async ({ brief }: { brief: string }) => { briefs.push(brief); return { taskId: 't-1' } }, message: never, stop: never }
}

test('a handover ends its turn with its notice as the answer: shown, kept as the turn\'s final reply, one model call', { timeout: DSH_TIMEOUT_MS }, async (t) => {
  const briefs: string[] = []
  const { events, llm, bridge } = await startHarness(t, { tasks: startingTasks(briefs) })
  const agent = bridge()
  await agent.start()
  await agent.prompt('后台做：整理本周会议纪要')

  assert.deepEqual(briefs, ['整理本周会议纪要'])
  assert.deepEqual(replies(events), ['已经交给后台：整理本周会议纪要'])
  const end = events.find(event => event.type === 'turn_end') as { finalReply?: boolean } | undefined
  assert.equal(end?.finalReply, true, 'no "no final reply" notice in the window')
  assert.equal(mainRequests(llm.requests as ModelRequest[]).length, 1, 'the notice needs no step of its own')
})

test('a handover without a notice lets the agent say it at its next step', { timeout: DSH_TIMEOUT_MS }, async (t) => {
  const briefs: string[] = []
  const { events, llm, bridge } = await startHarness(t, {
    tasks: startingTasks(briefs),
    decideFirst: (request: ModelRequest) => {
      if (!toolsOf(request).includes('commit_route') || JSON.stringify(request.messages).includes('"name":"commit_route"')) return null
      const id = /【请求 ID：([\w-]+)】/.exec(JSON.stringify(request.messages))?.[1]
      return { tool: { name: 'commit_route', input: { requestId: id, goals: [{ goal: '整理纪要', disposition: 'delegate' }], actions: [{ kind: 'start', brief: '整理本周会议纪要' }] } } }
    },
  })
  const agent = bridge()
  await agent.start()
  await agent.prompt('后台做：整理本周会议纪要')

  assert.deepEqual(briefs, ['整理本周会议纪要'])
  assert.equal(mainRequests(llm.requests as ModelRequest[]).length, 2, 'one more step, to say it')
  assert.equal(replies(events).length, 1)
  assert.equal((events.find(event => event.type === 'turn_end') as { finalReply?: boolean } | undefined)?.finalReply, true)
})

test('a start written without its kind gets through dsh to the host, which takes it for one: no second attempt', { timeout: DSH_TIMEOUT_MS }, async (t) => {
  const briefs: string[] = []
  const { events, llm, bridge } = await startHarness(t, {
    tasks: startingTasks(briefs),
    decideFirst: (request: ModelRequest) => {
      if (!toolsOf(request).includes('commit_route') || JSON.stringify(request.messages).includes('"name":"commit_route"')) return null
      const id = /【请求 ID：([\w-]+)】/.exec(JSON.stringify(request.messages))?.[1]
      return { tool: { name: 'commit_route', input: { requestId: id, notice: '已经交给后台：查国际大事', goals: [{ goal: '整理今天的国际大事', disposition: 'delegate' }], actions: [{ brief: '联网检索今天的国际新闻' }] } } }
    },
  })
  const agent = bridge()
  await agent.start()
  await agent.prompt('今天有什国际大事')

  assert.deepEqual(briefs, ['联网检索今天的国际新闻'], 'started from the first commit')
  assert.deepEqual(replies(events), ['已经交给后台：查国际大事'])
  assert.equal(mainRequests(llm.requests as ModelRequest[]).length, 1, 'no step to write the brief again')
})

test('a handover and an answer committed with only the start: the task starts and the turn goes on to answer, no second commit', { timeout: DSH_TIMEOUT_MS }, async (t) => {
  const briefs: string[] = []
  const { events, llm, bridge } = await startHarness(t, {
    tasks: startingTasks(briefs),
    decideFirst: (request: ModelRequest) => {
      if (!toolsOf(request).includes('commit_route')) return null
      if (JSON.stringify(request.messages).includes('"name":"commit_route"')) return { text: 'G20 是二十国集团，由主要经济体组成。' }
      const id = /【请求 ID：([\w-]+)】/.exec(JSON.stringify(request.messages))?.[1]
      // What the trial and the live replay saw: the answer listed among the goals, its reply left out of the actions.
      return { tool: { name: 'commit_route', input: { requestId: id, notice: '已经交给后台整理今天的国际大事',
        goals: [{ goal: '整理今天的国际大事', disposition: 'delegate' }, { goal: '解释 G20 是什么', disposition: 'answer' }],
        actions: [{ kind: 'start', title: '今日国际大事', brief: '联网整理今天的国际大事' }] } } }
    },
  })
  const agent = bridge()
  await agent.start()
  await agent.prompt('帮我整理一下今天的国际大事，顺便说一下 G20 是什么')

  const main = mainRequests(llm.requests as ModelRequest[])
  assert.deepEqual(briefs, ['联网整理今天的国际大事'], 'started from the first commit')
  assert.equal(main.length, 2, 'one step to answer, none to commit again')
  assert.match(JSON.stringify(lastResult(main[1]!)), /\\"kind\\":\\"reply\\"/, 'the host carried out the reply it added')
  assert.ok((replies(events) as string[]).some(reply => reply.includes('G20 是二十国集团')), 'and the question is answered')
})

test('a plan with its goals left out and fields dsh does not declare reaches the host in one step', { timeout: DSH_TIMEOUT_MS }, async (t) => {
  const briefs: string[] = []
  const { llm, bridge } = await startHarness(t, {
    tasks: startingTasks(briefs),
    decideFirst: (request: ModelRequest) => {
      if (!toolsOf(request).includes('commit_route') || JSON.stringify(request.messages).includes('"name":"commit_route"')) return null
      const id = /【请求 ID：([\w-]+)】/.exec(JSON.stringify(request.messages))?.[1]
      return { tool: { name: 'commit_route', input: { requestId: id, notice: '已经交给后台：查国际大事',
        actions: [{ kind: 'start', title: '国际大事', brief: '联网检索今天的国际新闻', brief_note: '控制在 500 字以内' }] } } }
    },
  })
  const agent = bridge()
  await agent.start()
  await agent.prompt('今天有什国际大事')

  assert.deepEqual(briefs, ['联网检索今天的国际新闻'])
  assert.equal(mainRequests(llm.requests as ModelRequest[]).length, 1, 'dsh let it through, so nothing is written again')
})

test('a tool outside the main agent\'s layers is refused at the first step, and the request is still routed', { timeout: DSH_TIMEOUT_MS }, async (t) => {
  let tried = false
  const { events, llm, workspace, bridge } = await startHarness(t, {
    decideFirst: (request: ModelRequest) => {
      if (tried || !toolsOf(request).includes('commit_route')) return null
      tried = true
      return { tool: { name: 'bash', input: { command: 'rm -rf keep.txt', description: '删除' } } }
    },
  })
  fs.writeFileSync(path.join(workspace, 'keep.txt'), 'kept')
  const agent = bridge()
  await agent.start()
  await agent.prompt('你好')

  const refused = mainRequests(llm.requests as ModelRequest[]).map(lastResult).find(Boolean)
  assert.match(JSON.stringify(refused), /commit_route 交给任务/, 'the model is told why the call was refused')
  assert.equal(fs.readFileSync(path.join(workspace, 'keep.txt'), 'utf8'), 'kept')
  assert.equal(events.some(event => event.type === 'permission'), false, 'nothing asked the user')
  assert.match(replies(events).join(''), /收到：「你好」$/)
})

test('a request the agent leaves without a route is reminded twice, shows nothing, and fails when the turn ends', { timeout: DSH_TIMEOUT_MS }, async (t) => {
  const { events, llm, requests, bridge } = await startHarness(t, {
    decideFirst: (request: ModelRequest) => (toolsOf(request).includes('commit_route') ? { text: '我直接回答了，没有提交路由' } : null),
  })
  const agent = bridge()
  await agent.start()
  await agent.prompt('你好')

  const main = mainRequests(llm.requests as ModelRequest[])
  assert.equal(main.length, 3, 'the step, then one more after each of the two reminders')
  assert.equal(JSON.stringify(main.at(-1)!.messages).match(/【路由补交】/g)?.length, 2)
  assert.deepEqual(replies(events), [], 'text without leave to answer never shows')
  assert.equal(events.at(-1)?.type, 'turn_end')
  const sessionId = agent.currentSession()!
  const [failed] = requests.endTurn({ sessionId, reason: 'unrouted' })
  assert.ok(failed)
  assert.deepEqual([requests.store.get(failed)?.status, requests.store.get(failed)?.failure], ['failed', 'unrouted'])
})

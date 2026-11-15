import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { openMemoryStore } from '../src/memory/node/memory-store.ts'
import { createMemoryRuntime } from '../src/backend/memory-runtime.ts'
import { createMemoryDispatch } from '../src/memory/core/memory-dispatch.ts'
import { recallCandidates } from '../src/memory/core/memory-match.ts'
import { MEMORY_EMBEDDING_DIMENSIONS } from '../src/memory/node/memory-embedder.ts'
import type { MemoryEmbedder, MemoryEmbeddingInput } from '../src/memory/node/memory-embedder.ts'
import { DEEPSEEK_DEFAULT } from '../src/backend/model-providers.ts'
import type { createAcpBridge } from '../src/backend/acp-bridge.ts'
import type { TestContext } from 'node:test'
import { DSH_TIMEOUT_MS, eventually, replies, startHarness as setup } from './fixtures/dsh-harness.js'
import { questionOf } from './fixtures/fake-llm.js'

/** The memory plugin inside the real dsh, with the app's whole profile and a fake model. */

async function setupMemory(t: TestContext, options?: Parameters<typeof setup>[1], embedder?: MemoryEmbedder) {
  const harness = await setup(t, options)
  const origin = { conversation: 'test-conversation', session: null as string | null }
  const store = openMemoryStore(path.join(harness.userData, 'memory.db'))
  let agent: ReturnType<typeof createAcpBridge>
  let activeUserTurn = false
  const dispatch = createMemoryDispatch(store, items => memory.dependenciesCurrent(items), id => memory.dispatchSourceCurrent(id))
  const memory = createMemoryRuntime({
    store, compute: (job, signal) => agent.memory.compute(job, signal), route: () => DEEPSEEK_DEFAULT,
    embedder, quiesce: async () => {}, changed: () => {},
    dependencies: dispatch.record, provisionalRead: dispatch.recordTurnOnly,
    canCommit: () => !activeUserTurn && dispatch.canCommit(),
  })
  harness.defer(() => memory.close())
  agent = harness.bridge({
    onSessionCreated: (id, _cwd, parent) => {
      memory.recordSession(id)
      if (parent) dispatch.inherit(parent, id)
    },
    allowSession: id => !dispatch.stale(id) && memory.provisionalReadsCurrent(id),
    beginMemoryDispatch: (id, session) => {
      if (dispatch.stale(session) || !memory.provisionalReadsCurrent(session)) return false
      dispatch.acquire(id)
      return { allowed: true, deadline: memory.provisionalDeadline(session, Date.now()) }
    },
    beginMemoryJobDispatch: (id, jobId) => {
      if (!memory.computeCurrent(jobId)) return false
      dispatch.acquire(id)
      return true
    },
    endMemoryDispatch: id => { dispatch.release(id); void memory.wake() },
    readyMemory: () => { void memory.wake() },
    conversationContext: sessionId => ({ conversationId: origin.conversation, sessionId }),
    memoryRequest: (request, foregroundTurn, turn, stillCurrent, signal) =>
      memory.handleModelRequest(request, { ...origin, session: request.session, foregroundTurn, turn }, stillCurrent, signal),
    memoryClarificationQuestion: memory.clarificationQuestion,
    allowGeneralQuestion: (session, turn, cards, stillWaiting) => turn ? memory.authorizeGeneralQuestion({ ...origin, session, turn }, cards, stillWaiting) : false,
    onQuestionAnswer: (entry, answers, operation) => {
      if (entry.taskId || !entry.context) return
      if (entry.kind === 'memory') dispatch.recordTurnOnly(entry.sessionId)
      for (const answer of answers) {
        const question = entry.question.questions.find(item => item.id === answer.id)
        if (!answer.custom || !question) continue
        memory.accept(answer.custom, origin, operation,
          { question: question.question, requestId: entry.question.id, questionId: answer.id, custom: true })
      }
    },
  })
  const { sessionId } = await agent.start()
  origin.session = sessionId
  async function ask(text: string) {
    activeUserTurn = true
    const receipt = memory.accept(text, origin)
    memory.bindSource(receipt.sourceId, origin.session)
    if (origin.session) {
      memory.recordDeliveredSource(receipt.sourceId, origin.conversation)
      dispatch.recordSource(origin.session, receipt.sourceId)
    }
    try { return await agent.prompt(text, [], { userTurn: true }) }
    finally {
      activeUserTurn = false
      if (origin.session) dispatch.endTurn(origin.session)
      memory.finishTurn(origin.session)
    }
  }
  async function freshSession() {
    origin.session = (await agent.newSession()).sessionId
  }
  return { ...harness, memory, store, agent, origin, ask, freshSession }
}

/** The plugin's block in the model's latest request, or '' when it sent none. */
interface ModelRequest {
  system?: unknown
  max_tokens?: number
  messages: { content: string | { type: string, text?: string }[] }[]
}

function contextOf(request: ModelRequest) {
  const last = request.messages[request.messages.length - 1]
  const parts = Array.isArray(last.content) ? last.content : []
  return parts.find((part) => part.type === 'text' && part.text?.startsWith('<about-user>'))?.text ?? ''
}

/** Whether the request's last message is one the user's turn begins with (not a tool's result in a later step). */
const beginsTurn = (request: ModelRequest) => {
  const last = request.messages[request.messages.length - 1]
  return !Array.isArray(last.content) || last.content.some((part) => part.type === 'text')
}

function lastContext(llm: { requests: object[] }) {
  // Background extraction and synthesis share the endpoint with the foreground conversation, and a routed turn takes
  // several steps: the block goes with the step the turn begins with.
  // The fake endpoint records parsed Messages API requests with this shape.
  const requests = llm.requests as ModelRequest[]
  const request = requests.findLast(request => JSON.stringify(request.system ?? '').includes('你是用户的个人工作助手') && beginsTurn(request))
  assert.ok(request, 'the foreground model request must exist')
  return contextOf(request)
}

test('memory context sampling selects the latest foreground request across background work', () => {
  const foreground = (text?: string): ModelRequest => ({
    system: [{ type: 'text', text: '你是用户的个人工作助手' }],
    messages: [{ content: text ? [{ type: 'text', text }] : '周报还要注意什么' }],
  })
  const extraction: ModelRequest = { system: '你是记忆整理员', messages: [{ content: 'extract' }] }
  const synthesis: ModelRequest = { system: '你是画像整理员', messages: [{ content: 'synthesize' }] }
  assert.equal(lastContext({ requests: [foreground('<about-user>first'), extraction, foreground('<about-user>second'), synthesis] }), '<about-user>second')
  assert.equal(lastContext({ requests: [foreground('<about-user>first'), extraction, foreground(), synthesis] }), '')
  assert.throws(() => lastContext({ requests: [extraction, synthesis] }), /foreground model request must exist/)
})

test('the DSH adapter injects the manual profile and saves a sourced explicit memory', { timeout: DSH_TIMEOUT_MS }, async t => {
  const { llm, events, ask, memory, freshSession } = await setupMemory(t)
  await memory.setProfile({ role: '后端负责人' })
  await ask('你好')
  assert.match(lastContext(llm), /角色与职责：后端负责人/)
  await ask('记住：周报每周五下班前交给张三')
  assert.ok(replies(events).join('').includes('已收到，稍后整理：周报每周五下班前交给张三'))
  assert.equal(events.some(event => event.type === 'permission'), false)
  const saved = await eventually(() => memory.listMemories().items.find(item => !item.conditional))
  assert.ok(saved)
  assert.equal(saved.text, '周报每周五下班前交给张三')
  assert.deepEqual(new Set(saved.keywords), new Set(['周报', '张三']))
  assert.equal(saved.evidence.length, 1)
  assert.ok(await eventually(() => memory.listMemories().items.find(item => item.id === saved.id && !item.conditional)))
  await freshSession()
  await ask('帮我写周报')
  assert.match(lastContext(llm), /【相关记忆】[\s\S]+周报每周五下班前交给张三/)
})

test('an affected session cannot send a model request after automatic replacement', { timeout: DSH_TIMEOUT_MS }, async t => {
  const { llm, memory, ask, agent, freshSession } = await setupMemory(t)
  const original = '我的周报提交邮箱是 amber@example.com'
  await ask(original)
  await memory.wake()
  await ask('周报提交邮箱是什么？')
  assert.match(lastContext(llm), /amber@example\.com/)

  await ask('从现在起，我的周报提交邮箱从 amber@example.com 改为 cobalt@example.com')
  await memory.wake()
  assert.equal(memory.listChanges()[0]?.kind, 'supersede')
  const requests = llm.requests as ModelRequest[]
  const extraction = requests.findLast(request => JSON.stringify(request.system).includes('你是记忆整理员'))
  const review = requests.findLast(request => JSON.stringify(request.system).includes('你是记忆变更复核员'))
  const conversation = requests.find(request => JSON.stringify(request.system).includes('你是用户的个人工作助手'))
  assert.ok(extraction?.max_tokens && conversation?.max_tokens)
  assert.equal(extraction.max_tokens, conversation.max_tokens)
  assert.notEqual(extraction.max_tokens, 2_000)
  assert.equal(review?.max_tokens, 2_000)
  const before = llm.requests.length
  await assert.rejects(agent.prompt('再核对周报提交邮箱'))
  assert.equal(llm.requests.length, before)

  await freshSession()
  await ask('再核对周报提交邮箱')
  assert.match(lastContext(llm), /cobalt@example\.com/)
  assert.doesNotMatch(JSON.stringify((llm.requests.at(-1) as ModelRequest).messages), /amber@example\.com/)
})

test('real DSH receives cross-language memory while the local encoder reuses its passage vector', { timeout: DSH_TIMEOUT_MS }, async t => {
  const record = '例行工作汇报材料发给财务小组'
  const queries = ['Weekly report destination', 'Qui reçoit le bilan hebdomadaire ?']
  const encodings: Array<readonly MemoryEmbeddingInput[]> = []
  const vector = new Float32Array(MEMORY_EMBEDDING_DIMENSIONS)
  vector[0] = 1
  const { memory, ask, freshSession, llm } = await setupMemory(t, { decideFirst: raw => {
    const request = raw as ModelRequest
    if (JSON.stringify(request.messages.at(-1)).includes('tool_result')) return null
    const query = queries.find(value => questionOf(request.messages) === value)
    return query ? { tool: { name: 'memory_recall', input: { query, deep: true } } } : null
  } }, {
    fingerprint: 'fixture-e5',
    async embedBatch(inputs) {
      encodings.push(inputs)
      return inputs.map(() => vector)
    },
    close() {},
  })
  const saved = memory.addMemory(record)
  assert.ok(saved)
  assert.ok(queries.every(query => recallCandidates([saved], query, 1).found.length === 0))
  for (const query of queries) {
    await freshSession()
    const from = llm.requests.length
    await ask(query)
    const toolResult = llm.requests.slice(from).find(request => {
      const wire = JSON.stringify((request as ModelRequest).messages.at(-1))
      return wire.includes('tool_result') && wire.includes(record) && wire.includes('semantic')
    })
    assert.ok(toolResult, 'the next model request receives the grounded, labelled memory as a tool result')
  }
  assert.deepEqual(encodings, [
    [{ kind: 'query', text: queries[0] }, { kind: 'passage', text: record }],
    [{ kind: 'query', text: queries[1] }],
  ])
})

test('cancelling a live DSH recall aborts local encoding and discards the fact', { timeout: DSH_TIMEOUT_MS }, async t => {
  const query = 'Weekly report destination'
  const record = '例行工作汇报材料发给财务小组'
  const vector = new Float32Array(MEMORY_EMBEDDING_DIMENSIONS)
  vector[0] = 1
  type Work = { signal: AbortSignal; finish: () => void }
  let onStart!: (work: Work) => void
  const started = new Promise<Work>(resolve => { onStart = resolve })
  const { memory, ask, freshSession, agent, store, origin, llm } = await setupMemory(t, { decideFirst: raw => {
    const request = raw as ModelRequest
    const last = request.messages.at(-1)?.content
    if (!last || !JSON.stringify(last).includes(query) || JSON.stringify(last).includes('tool_result')) return null
    return { tool: { name: 'memory_recall', input: { query, deep: true } } }
  } }, {
    fingerprint: 'cancel-test-e5',
    embedBatch(inputs, signal) {
      assert.ok(signal)
      return new Promise(resolve => onStart({ signal, finish: () => resolve(inputs.map(() => vector)) }))
    },
    close() {},
  })
  const saved = memory.addMemory(record)
  assert.ok(saved)
  await freshSession()
  const turn = ask(query)
  const work = await started
  await agent.cancel()
  assert.ok(await eventually(() => work.signal.aborted, { timeoutMs: 2_000 }))
  work.finish()
  await turn
  assert.ok(!store.dispatch.snapshot(origin.session!).dependencies.some(item => item.id === saved.id))
  assert.ok(!llm.requests.some(raw => {
    const wire = JSON.stringify((raw as ModelRequest).messages.at(-1))
    return wire?.includes('tool_result') && wire.includes(record)
  }))
})

test('the adapter requests asynchronous extraction of the received source', { timeout: DSH_TIMEOUT_MS }, async t => {
  const { llm, events, ask, memory } = await setupMemory(t)
  const words = '以后回答我，先给结论再展开'
  await ask(words)
  assert.equal(events.some(event => event.update?.sessionUpdate === 'tool_call' && String(event.update.title).startsWith('memory_')), false)
  const saved = await eventually(() => memory.listMemories().items.find(item => item.kind === 'preference'))
  assert.equal(saved?.text, words)
  const extraction = (llm.requests as ModelRequest[]).find(request => JSON.stringify(request.system).includes('UTF-16'))
  assert.ok(extraction)
  const parts = extraction.messages[0].content
  assert.ok(Array.isArray(parts))
  assert.equal(JSON.parse(parts[0].text ?? '').user, words)
})

test('a task-specific question card is not accepted as a user fact', { timeout: DSH_TIMEOUT_MS }, async t => {
  const { events, agent, memory, store } = await setupMemory(t)
  const task = await agent.startTask()
  assert.ok(task.ok, JSON.stringify(task))
  const turn = agent.promptTask(task.taskId, '明天天气怎么样')
  const asked = await eventually(() => events.find(event => event.type === 'task_question'))
  assert.ok(asked)
  assert.equal(agent.answerQuestion(asked.questionId, [{ id: 'city', selected: ['上海'] }]), true)
  await turn
  await memory.wake()
  assert.equal(memory.listMemories().total, 0)
  assert.equal(store.db.prepare("SELECT 1 FROM memory_sources WHERE author='answer'").get(), undefined)
})

test('a disputed address triggers a real DSH question only when the current request needs it', { timeout: DSH_TIMEOUT_MS }, async t => {
  const { events, ask, agent, memory, freshSession, llm } = await setupMemory(t)
  await ask('我唯一的周报提交邮箱是 amber@example.com')
  assert.ok(await eventually(() => memory.listMemories().items.find(item => item.fact?.predicate === 'report_email')))
  await ask('我唯一的周报提交邮箱是 jade@example.com')
  assert.ok(await eventually(() => memory.listInvalid().some(item => item.state === 'disputed')))
  await freshSession()

  await ask('只润色周报正文')
  assert.equal(events.filter(event => event.type === 'question').length, 0)
  const filling = ask('按记忆填写周报提交邮箱')
  const asked = await eventually(() => events.find(event => event.type === 'question'), { timeoutMs: 3_000 })
  const diagnostic = () => (llm.requests as ModelRequest[]).filter(request =>
    JSON.stringify(request.system).includes('你是用户的个人工作助手')).slice(-2).map(request => request.messages.at(-1))
  if (!asked) assert.fail(JSON.stringify(diagnostic()))
  assert.equal(asked.questions.length, 1)
  const question = asked.questions[0]
  const selected = question.options.find((option: { label: string }) => option.label.includes('jade@example.com'))
  assert.ok(selected)
  assert.equal(agent.answerQuestion(asked.questionId, [{ id: question.id, selected: [selected.label] }]), true)
  await filling
  assert.match(replies(events).join(''), /这次填 .*jade@example\.com/)
  assert.equal(events.filter(event => event.type === 'question').length, 1)
  assert.equal(memory.listInvalid().filter(item => item.state === 'disputed').length, 2)
  assert.equal(memory.listMemories('周报提交邮箱').items.length, 0)
})

test('an uncertain review permits a task-local question without making the proposed value current', { timeout: DSH_TIMEOUT_MS }, async t => {
  const { memory, ask, events, agent, llm, freshSession } = await setupMemory(t, {
    decideFirst: request => {
      const model = request as ModelRequest
      if (!String(JSON.stringify(model.system)).includes('记忆变更复核员')) return null
      const content = model.messages.at(-1)?.content
      const { proposals } = JSON.parse(typeof content === 'string' ? content : content?.[0]?.text ?? '{}')
      return { text: JSON.stringify({ reviews: proposals.map(({ index, draft }: { index: number, draft: { id: string } }) =>
        ({ index, verdict: 'uncertain', draftId: draft.id, sameRelation: true })) }) }
    },
  })
  const previous = '我的周报提交邮箱是 amber@example.com'
  const update = '从现在起，我的周报提交邮箱从 amber@example.com 改为 cobalt@example.com'
  await ask(previous)
  await memory.wake()
  await ask(update)
  await memory.wake()
  assert.deepEqual(memory.listMemories('周报提交邮箱').items.map(item => item.text), [previous])
  await freshSession()

  const turn = ask('按记忆填写周报提交邮箱')
  const card = await eventually(() => events.find(event => event.type === 'question'))
  assert.ok(card)
  const question = card.questions[0]
  const next = question.options.find((option: { label: string }) => option.label.includes('cobalt@example.com'))
  assert.ok(next)
  assert.equal(agent.answerQuestion(card.questionId, [{ id: question.id, selected: [next.label] }]), true)
  await turn
  assert.ok(replies(events).some((text: string) => text.includes('这次填') && text.includes('cobalt@example.com')))
  assert.deepEqual(memory.listMemories('周报提交邮箱').items.map(item => item.text), [previous])

  await freshSession()
  await ask('只润色周报正文')
  assert.doesNotMatch(JSON.stringify(llm.requests.at(-1)), /cobalt@example\.com/)
})

test('a typed clarification can become a reviewed lasting correction', { timeout: DSH_TIMEOUT_MS }, async t => {
  const { memory, ask, events, agent, freshSession } = await setupMemory(t)
  const original = '我唯一的周报提交邮箱是 amber@example.com'
  const other = '我唯一的周报提交邮箱是 jade@example.com'
  await ask(original)
  await memory.wake()
  await ask(other)
  await memory.wake()
  await freshSession()
  const turn = ask('按记忆填写周报提交邮箱')
  const card = await eventually(() => events.find(event => event.type === 'question'))
  assert.ok(card)
  const correction = '从现在起，我的周报提交邮箱从 amber@example.com 改为 cobalt@example.com'
  assert.equal(agent.answerQuestion(card.questionId, [{ id: card.questions[0].id, selected: [], custom: correction }]), true)
  await turn
  await memory.wake()
  const [change] = memory.listChanges()
  assert.equal(change?.kind, 'supersede')
  assert.ok(memory.listMemories('周报提交邮箱').items.some(item => item.text.includes('cobalt@example.com')))
  const undone = await memory.undoChange(change.id, change.revision, undefined, change.expectedRevisions)
  assert.equal(undone.status, 'applied')
  assert.equal(memory.listChanges()[0]?.status, 'undone')
  assert.ok(!memory.listMemories('周报提交邮箱').items.some(item => item.text.includes('cobalt@example.com')))
})

test('the real DSH cannot turn a recalled background dispute into a generic question card', { timeout: DSH_TIMEOUT_MS }, async t => {
  const marker = 'background-memory-card-probe'
  const { memory, ask, events, agent, llm } = await setupMemory(t, {
    decideFirst: request => {
      const wire = JSON.stringify(request)
      if (!wire.includes(marker)) return null
      if (!wire.includes('"type":"tool_result"')) return { tool: { name: 'memory_recall', input: { query: '周报提交邮箱' } } }
      if (!wire.includes('"name":"ask_user_question","input"')) return { tool: { name: 'ask_user_question', input: { questions: [{
        id: 'email', question: '两个周报提交邮箱要用哪一个？', options: [{ label: 'A' }, { label: 'B' }],
      }] } } }
      return { text: '地址待确认，继续处理正文。' }
    },
  })
  for (const text of ['我唯一的周报提交邮箱是 amber@example.com', '我唯一的周报提交邮箱是 jade@example.com']) {
    await ask(text)
    await memory.wake()
  }
  const task = await agent.startTask()
  assert.ok(task.ok)
  await agent.promptTask(task.taskId, marker)
  assert.ok(llm.requests.some(request => JSON.stringify(request).includes('两个周报提交邮箱要用哪一个')))
  assert.equal(events.some(event => event.type === 'task_question'), false)
  assert.equal(memory.listInvalid().filter(item => item.state === 'disputed').length, 2)
})

test('real DSH cannot ask for a disputed value using a paraphrased ordinary card, and can still ask about an independent topic', { timeout: DSH_TIMEOUT_MS }, async t => {
  const marker = 'Check the delivery details, use the usual destination'
  const independent = 'Please clarify which project to open'
  const targetQuestion = '平时把例行汇报交到哪里？'
  const ordinaryQuestion = '要打开第几个项目？'
  const { memory, ask, events, agent, llm } = await setupMemory(t, { decideFirst: request => {
    if (/记忆(?:整理员|变更复核员|提问校验员)/u.test(JSON.stringify((request as ModelRequest).system))) return null
    const wire = JSON.stringify(request)
    if (!wire.includes(marker)) return null
    if (wire.includes('tool_result') && !wire.includes(independent)) return { text: '继续处理无争议的部分。' }
    if (wire.includes(ordinaryQuestion)) return { text: '已收到了项目选项。' }
    const question = wire.includes(independent) ? ordinaryQuestion : targetQuestion
    return { tool: { name: 'ask_user_question', input: { questions: [{ id: 'target', question,
      options: [{ label: '第一个' }, { label: '第二个' }] }] } } }
  } })
  for (const line of ['我唯一的周报提交邮箱是 amber@example.com', '我唯一的周报提交邮箱是 jade@example.com']) {
    await ask(line)
    await memory.wake()
  }
  const task = await agent.startTask()
  assert.ok(task.ok)
  await agent.promptTask(task.taskId, marker)
  assert.ok(llm.requests.some(request => JSON.stringify(request).includes(targetQuestion)
    && JSON.stringify((request as ModelRequest).system).includes('记忆提问校验员')))
  assert.equal(events.some(event => event.type === 'task_question'), false)
  const turn = agent.promptTask(task.taskId, independent)
  const card = await eventually(() => events.find(event => event.type === 'task_question'))
  assert.equal(card.questions[0].question, ordinaryQuestion)
  assert.equal(agent.answerQuestion(card.questionId, [{ id: 'target', selected: ['第一个'] }]), true)
  await turn
})

test('Auto approval cannot send session history after the model attempt releases its dispatch lease', { timeout: DSH_TIMEOUT_MS }, async t => {
  const { llm, bridge, events } = await setup(t, { permission: 'auto' })
  const stale = new Set<string>()
  const leases = new Map<string, string>()
  const denied: string[] = []
  let invalidateAfterSend = false
  const agent = bridge({
    memoryRequest: () => '',
    allowSession: id => !stale.has(id),
    beginMemoryDispatch: (id, session) => {
      if (stale.has(session)) { denied.push(session); return false }
      leases.set(id, session)
      return true
    },
    endMemoryDispatch: id => {
      const session = leases.get(id)
      leases.delete(id)
      if (session && invalidateAfterSend) stale.add(session)
    },
  })
  const { sessionId } = await agent.start()
  assert.ok(sessionId)
  await agent.prompt('这轮使用合成的旧值 previous-memory-marker')
  const before = llm.requests.length
  invalidateAfterSend = true
  await agent.prompt('删掉 nonexistent-review-probe.txt')

  assert.ok(denied.includes(sessionId))
  assert.ok(!events.some(event => event.type === 'permission'))
  const blocked = llm.requests.slice(before)
  assert.ok(blocked.some(request => JSON.stringify(request).includes('nonexistent-review-probe.txt')))
  assert.ok(!blocked.some(request => JSON.stringify(request).includes('REVIEW_POLICY')))

  invalidateAfterSend = false
  await agent.newSession()
  const next = llm.requests.length
  await agent.prompt('另一会话继续工作')
  assert.ok(llm.requests.slice(next).some(request => JSON.stringify(request).includes('另一会话继续工作')))
})

test('DSH does not send a model request if its validity boundary has passed', { timeout: DSH_TIMEOUT_MS }, async t => {
  const { llm, bridge } = await setup(t)
  let deadline = Date.now() - 1
  const agent = bridge({ memoryRequest: () => '', beginMemoryDispatch: () => ({ allowed: true, deadline }) })
  await agent.start()
  await agent.prompt('不能进入模型请求 expired-memory-marker')
  assert.ok(!llm.requests.some(request => JSON.stringify(request).includes('expired-memory-marker')))

  await agent.newSession()
  deadline = Date.now() + 30_000
  await agent.prompt('仍然有效 fresh-memory-marker')
  assert.ok(llm.requests.some(request => JSON.stringify(request).includes('fresh-memory-marker')))
})

for (const httpError of [503, 421]) test(`DSH rechecks a provider retry after HTTP ${httpError} and lets an unrelated task dispatch`, { timeout: DSH_TIMEOUT_MS }, async t => {
  const marker = 'main-retry-memory-marker'
  const taskMarker = 'unrelated-task-memory-marker'
  const { llm, bridge } = await setup(t, { decideFirst: request => JSON.stringify(request).includes(marker) ? { httpError } : null })
  let main = ''
  let invalid = false
  let rejected = 0
  const leases = new Map<string, string>()
  const agent = bridge({
    memoryRequest: () => '',
    beginMemoryDispatch: (id, session) => {
      if (session === main && invalid) { rejected++; return false }
      leases.set(id, session)
      return true
    },
    endMemoryDispatch: id => {
      if (leases.get(id) === main) invalid = true
      leases.delete(id)
    },
  })
  main = (await agent.start()).sessionId!
  const task = await agent.startTask()
  assert.ok(task.ok)
  const turn = agent.prompt(marker)
  assert.ok(await eventually(() => invalid, { timeoutMs: 3_000, intervalMs: 10 }))
  await agent.promptTask(task.taskId, taskMarker)
  await turn
  if (httpError === 503) assert.ok(rejected > 0, 'SDK retry consulted the request barrier')
  assert.equal(llm.requests.filter(request => JSON.stringify(request).includes(marker)).length, 1)
  assert.ok(llm.requests.some(request => JSON.stringify(request).includes(taskMarker)))
})

test('DSH releases its dispatch lease while the provider is still preparing a response', { timeout: DSH_TIMEOUT_MS }, async t => {
  const marker = 'pending-response-memory-marker'
  const answer = 'response-after-request-body'
  const { llm, bridge, events } = await setup(t, {
    decideFirst: request => JSON.stringify(request).includes(marker)
      && JSON.stringify((request as ModelRequest).messages.at(-1)?.content).includes('tool_result')
      ? { text: answer, delayMs: 1500 } : null,
  })
  const acquired = new Set<string>()
  let released = 0
  const agent = bridge({
    memoryRequest: () => '',
    beginMemoryDispatch: id => { acquired.add(id); return true },
    endMemoryDispatch: id => { if (acquired.delete(id)) released++ },
  })
  await agent.start()
  const turn = agent.prompt(marker)
  try {
    assert.ok(await eventually(() => released >= 2 && llm.requests.some(request =>
      JSON.stringify((request as ModelRequest).messages.at(-1)?.content).includes('tool_result')),
      { timeoutMs: 4000, intervalMs: 10 }))
    assert.ok(!replies(events).join('').includes(answer), 'the request body lease is independent of response delivery')
  } finally { await turn }
  assert.ok(replies(events).join('').includes(answer))
})

for (const memoryReady of [true, false]) {
  test(`fast steering ${memoryReady ? 'checks the dispatch barrier for its own request' : 'keeps working through the main agent without a guarded fast model'}`,
    { timeout: DSH_TIMEOUT_MS }, async t => {
      const ask = '比较两份报告，回复要详细'
      const steer = '再另外整理出一份会议纪要'
      let releaseForeground!: () => void
      const foreground = new Promise<void>(resolve => { releaseForeground = resolve })
      const { llm, bridge, requests } = await setup(t, {
        decideFirst: raw => {
          const request = raw as ModelRequest
          if (JSON.stringify(request.system).includes('Viva 的快速调度')) return { text: '{"decision":"defer"}' }
          if (JSON.stringify(request.messages.at(-1)?.content).includes('tool_result')
            && request.messages.some(({ content }) => JSON.stringify(content).includes(ask))
            && !request.messages.some(({ content }) => JSON.stringify(content).includes(steer))) {
            return { text: '两份报告的比较。', waitFor: foreground }
          }
          return null
        },
      })
      let denyNext = false
      let denied = false
      const agent = bridge({
        memoryRequest: memoryReady ? () => '' : undefined,
        beginMemoryDispatch: () => {
          if (!denyNext) return true
          denyNext = false
          denied = true
          return false
        },
        taskRead: () => ({ tasks: [] }),
      })
      const { sessionId } = await agent.start()
      assert.ok(sessionId)
      assert.equal(agent.memory.ready(), memoryReady)
      const turn = agent.prompt(ask)
      try {
        assert.ok(await eventually(() => (llm.requests as ModelRequest[]).some(request =>
          JSON.stringify(request.messages.at(-1)?.content).includes('tool_result')), { intervalMs: 10 }))
        denyNext = memoryReady
        assert.deepEqual(await agent.steer(steer), { ok: true })
        if (memoryReady) assert.ok(await eventually(() => denied), 'the fast request reaches the barrier before the foreground reply')
      } finally {
        releaseForeground()
        await turn
      }
      assert.ok(llm.requests.every(raw => !JSON.stringify((raw as ModelRequest).system).includes('Viva 的快速调度')),
        'nothing from the fast lane may leave without authorization')
      assert.ok(llm.requests.some(request => JSON.stringify(request).includes(steer)), 'the main route still gets the interjection')
      assert.deepEqual(requests.endTurn({ sessionId, reason: 'unrouted' }), [])
    })
}

test('an idle interjection starts neither a fast model request nor a routing decision', { timeout: DSH_TIMEOUT_MS }, async t => {
  const marker = '把会议纪要另交给后台'
  const { llm, bridge, requests } = await setup(t, {
    decideFirst: request => JSON.stringify((request as ModelRequest).system).includes('Viva 的快速调度')
      ? { text: '{"decision":"start","brief":"整理会议纪要"}' } : null,
  })
  const agent = bridge({ taskRead: () => ({ tasks: [] }) })
  const { sessionId } = await agent.start()
  assert.ok(sessionId)
  await agent.prompt('先看看这份报告')
  assert.equal(agent.memory.ready(), true)
  assert.deepEqual(await agent.steer(marker), { ok: false, reason: 'idle' })
  // Starting another real step proves no fast request was allowed to reach the provider during the failed steering.
  await agent.prompt('继续下一件事')
  assert.ok(llm.requests.every(raw => !JSON.stringify((raw as ModelRequest).system).includes('Viva 的快速调度')))
  assert.deepEqual(requests.endTurn({ sessionId, reason: 'unrouted' }), [])
})


test('the model is told it is a personal work assistant, not the coding agent of the stock profile', { timeout: DSH_TIMEOUT_MS }, async (t) => {
  const { llm, bridge } = await setup(t)
  const agent = bridge()
  await agent.start()

  await agent.prompt('你好')

  const request = JSON.stringify(llm.requests[0])
  assert.match(request, /你是用户的个人工作助手/)
  // The working directory comes in dsh's runtime context now (it has no {{cwd}} for the persona any more).
  assert.match(request, /Current working directory: /)
  assert.doesNotMatch(request, /coding agent/)
})

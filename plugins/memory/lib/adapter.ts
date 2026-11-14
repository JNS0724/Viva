import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { channel } from 'node:diagnostics_channel'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-questions'
import { MEMORY_CONTRACT, MEMORY_SEMANTIC_TIMEOUT_MS, memoryClarificationResult, memoryCompute, memoryKinds } from '../../../src/shared/memory-contract.ts'
import type { MemoryCompute, MemoryRequest } from '../../../src/shared/memory-contract.ts'
import { objectOf } from '../../../src/shared/unknown-value.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'viva-memory': { kind: 'viva-memory' }
  }
}
const memorySource = { kind: 'viva-memory' } as const

function clearPreviousContext(agent: Agent) {
  const session = agent.session
  for (const seq of [...session.surface.nodes]) {
    const event = session.eventAt(seq)
    if (event?.type !== 'user/message' || event.data.source.kind !== 'viva-memory' || !event.data.content.length) continue
    session.append('user/message', createUserMessage({ content: [], source: memorySource }), {
      surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq],
    })
  }
}

async function complete(ctx: Context, job: MemoryCompute, signal: AbortSignal) {
  const assembler = new BlockAssembler()
  for await (const chunk of ctx.llm.stream({
    provider: job.provider, model: job.model, system: job.system,
    messages: [createUserMessage({ content: [{ type: 'text', text: job.input }], source: memorySource })],
    maxTokens: 2000, signal,
  })) assembler.push(chunk)
  if (assembler.finish?.kind !== 'stop') throw new Error('incomplete memory extraction')
  return assembler.blocks().filter(block => block.type === 'text').map(block => block.text).join('')
}

export function applyMemoryAdapter(ctx: Context, port = process) {
  if (!port.send) return
  const caller = new AsyncLocalStorage<{ agent: Agent } | { jobId: string }>()
  type DispatchOrigin = { session: string, parent?: string } | { jobId: string }
  const modelTransport = new AsyncLocalStorage<{ origin: DispatchOrigin, signal?: AbortSignal, denied?: Error }>()
  const activeSend = new AsyncLocalStorage<() => void>()
  const pending = new Map<string, (text: string | null) => void>()
  const computations = new Map<string, { generation: number, cancel: AbortController }>()
  const lifetime = new AbortController()
  const send = (message: object) => { if (port.connected) port.send?.(message, () => {}) }
  const parentOf = (agent: Agent | undefined) => {
    if (!agent) return undefined
    const agents = ctx.agents.list()
    let root = agent
    for (let owner = agents.find(candidate => ctx.agents.isOwnedBy(root.session.id, candidate)); owner;
      owner = agents.find(candidate => ctx.agents.isOwnedBy(root.session.id, candidate))) root = owner
    return root !== agent ? String(root.session.id) : undefined
  }
  function exchange(message: { type: string; [field: string]: unknown }, id: string, signal?: AbortSignal, timeoutMs = 2000) {
    return new Promise<string | null>(resolve => {
      const cancel = () => {
        if (message.type === 'memory_query') send({ type: 'memory_query_cancel', id })
        done(null)
      }
      const done = (text: string | null) => {
        clearTimeout(timer)
        pending.delete(id)
        signal?.removeEventListener('abort', cancel)
        resolve(text)
      }
      const timer = setTimeout(cancel, timeoutMs)
      timer.unref()
      pending.set(id, done)
      signal?.addEventListener('abort', cancel, { once: true })
      if (signal?.aborted) done(null)
      else send({ ...message, id })
    })
  }
  const request = (input: MemoryRequest, agent: Agent, signal?: AbortSignal) =>
    exchange({ type: 'memory_query', request: input, parent: parentOf(agent) }, randomUUID(),
      signal ? AbortSignal.any([lifetime.signal, signal]) : lifetime.signal,
      input.op === 'recall' ? MEMORY_SEMANTIC_TIMEOUT_MS + 1500 : undefined)

  async function authorize(origin: DispatchOrigin, id: string, signal?: AbortSignal) {
    const allowed = await exchange({ type: 'memory_dispatch', ...origin }, id, signal)
    signal?.throwIfAborted()
    if (!allowed) throw new Error('Memory context changed. Retry from the conversation.')
    const deadline = Number(allowed)
    if (deadline && deadline <= Date.now()) throw new Error('Memory context expired. Retry from the conversation.')
    return deadline
  }

  // The app's DSH adapters use fetch at the wire boundary. Leave the prepared adapter in place and
  // authorize each model POST, including HTTP retries made inside a provider SDK.
  const fetchOriginal = globalThis.fetch
  const requests = new WeakMap<object, () => void>()
  const created = channel('undici:request:create')
  const bodySent = channel('undici:request:bodySent')
  function requestCreated(event: unknown) {
    const request = objectOf(objectOf(event)?.request)
    const settle = activeSend.getStore()
    if (request && settle) requests.set(request, settle)
  }
  function requestSent(event: unknown) {
    const request = objectOf(objectOf(event)?.request)
    if (request) requests.get(request)?.()
  }
  function deniedResponse(reason: Error) {
    // A thrown transport error can cause an SDK retry. This response stays inside DSH.
    return new Response(JSON.stringify({ error: { type: 'invalid_request_error', message: reason.message } }), {
      status: 400, headers: { 'content-type': 'application/json', 'x-should-retry': 'false' },
    })
  }
  function oneShotBody(init?: RequestInit): RequestInit | undefined {
    if (typeof init?.body !== 'string') return init
    const bytes = new TextEncoder().encode(init.body)
    const headers = new Headers(init.headers)
    headers.set('content-length', String(bytes.byteLength))
    const streamed: RequestInit & { duplex: 'half' } = { ...init, headers, duplex: 'half', body: new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(bytes); controller.close() },
    }) }
    return streamed
  }
  const guardedFetch: typeof globalThis.fetch = async (input, init) => {
    const call = modelTransport.getStore()
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
    if (!call || method.toUpperCase() !== 'POST') return fetchOriginal(input, init)
    const url = input instanceof Request ? input.url : String(input)
    if (!/\/(?:messages|responses|chat\/completions)\/?$/u.test(new URL(url).pathname)) return fetchOriginal(input, init)
    if (call.denied) return deniedResponse(call.denied)
    const providerSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
    const signal = AbortSignal.any([lifetime.signal, ...[providerSignal, call.signal].filter((signal): signal is AbortSignal => Boolean(signal))])
    const id = randomUUID()
    const cutoff = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let held = true
    const release = () => {
      if (!held) return
      held = false
      clearTimeout(timer)
      send({ type: 'memory_dispatched', id })
    }
    try {
      const deadline = await authorize(call.origin, id, signal)
      if (deadline) {
        const delay = deadline - Date.now()
        if (delay <= 0) throw new Error('Memory context expired. Retry from the conversation.')
        if (delay <= 2_147_483_647) {
          timer = setTimeout(() => cutoff.abort(), delay)
          timer.unref()
        }
      }
    } catch (error) {
      if (signal.aborted) throw error
      call.denied = error instanceof Error ? error : new Error('Memory context changed.')
      return deniedResponse(call.denied)
    } finally {
      if (call.denied || signal.aborted) release()
    }
    try {
      // Undici can replay a reusable POST internally after HTTP 421. A one-shot body leaves retries to the SDK,
      // so another send has to acquire its own permit. Keep the same wire length for compatible gateways.
      return await activeSend.run(release, () => fetchOriginal(input, { ...oneShotBody(init), redirect: 'error', signal: AbortSignal.any([signal, cutoff.signal]) }))
    } finally { release() }
  }
  globalThis.fetch = guardedFetch
  created.subscribe(requestCreated)
  bodySent.subscribe(requestSent)
  function receive(raw: unknown) {
    const message = objectOf(raw)
    if (message?.type === 'memory_response' && typeof message.id === 'string') {
      pending.get(message.id)?.(typeof message.text === 'string' ? message.text : null)
    }
    if (message?.type === 'memory_dispatch_result' && typeof message.id === 'string') {
      const deadline = typeof message.deadline === 'number' && Number.isSafeInteger(message.deadline) ? message.deadline : 0
      pending.get(message.id)?.(message.allowed === true ? String(deadline) : null)
    }
    if (message?.type === 'memory_compute_cancel' && typeof message.id === 'string') {
      const running = computations.get(message.id)
      if (running && running.generation === message.generation) running.cancel.abort()
      return
    }
    if (message?.type !== 'memory_compute') return
    const result = memoryCompute.safeParse(message.job)
    if (!result.success) return
    const job = result.data
    const cancel = new AbortController()
    const signal = AbortSignal.any([lifetime.signal, cancel.signal, AbortSignal.timeout(115_000)])
    const running = { generation: job.generation, cancel }
    computations.set(job.id, running)
    const answer = (text: string | null) => {
      if (computations.get(job.id) !== running) return
      computations.delete(job.id)
      if (!cancel.signal.aborted) send({ type: 'memory_computed', id: job.id, generation: job.generation, text })
    }
    void caller.run({ jobId: job.id }, () => complete(ctx, job, signal)).then(answer, () => answer(null))
  }
  port.on('message', receive)
  ctx.effect(() => () => {
    port.off('message', receive)
    created.unsubscribe(requestCreated)
    bodySent.unsubscribe(requestSent)
    if (globalThis.fetch === guardedFetch) globalThis.fetch = fetchOriginal
    lifetime.abort()
    for (const done of pending.values()) done(null)
  }, 'memory channel')
  // Auto review builds a request from the session surface inside this tool hook without a session ID.
  // Take ownership from the actual tool execution rather than guessing from the request text.
  let unbindTools: (() => unknown) | undefined
  const bindTools = () => {
    unbindTools?.()
    unbindTools = ctx.on('tools/pre-execute', (exec, next) => exec.agent ? caller.run({ agent: exec.agent }, next) : next(), { prepend: true })
    return undefined
  }
  bindTools()
  ctx.on('agent/created', bindTools)
  ctx.on('llm/stream', async function* (options, next) {
    const origin = caller.getStore()
    const agent = options.sessionId ? ctx.agents.get(options.sessionId) : origin && 'agent' in origin ? origin.agent : undefined
    const sessionId = options.sessionId ?? agent?.session.id
    const jobId = origin && 'jobId' in origin ? origin.jobId : undefined
    if (!sessionId && !jobId) throw new Error('Model request has no verified memory context')
    const dispatch: DispatchOrigin = sessionId ? { session: String(sessionId), parent: parentOf(agent) } : { jobId: jobId! }
    // Installed DeepSeek and configured Viva providers use the intercepted transport above.
    if (options.provider === 'deepseek-official' || options.provider === 'deepseek-account' || options.provider.startsWith('custom-')) {
      const transport = { origin: dispatch, signal: options.signal, denied: undefined as Error | undefined }
      const stream = modelTransport.run(transport, next)
      const iterator = stream[Symbol.asyncIterator]()
      try {
        for (;;) {
          const chunk = await modelTransport.run(transport, () => iterator.next())
          if (transport.denied) throw transport.denied
          if (chunk.done) return
          yield chunk.value
        }
      } finally { await iterator.return?.() }
    }

    // A third-party DSH adapter may use another transport. Hold its lease through any internal
    // retries. A request with an expiring dependency needs a supported final transport gate.
    const id = randomUUID()
    try {
      if (await authorize(dispatch, id, options.signal)) throw new Error('The model adapter cannot send time-bound memory safely.')
      yield* next()
    } finally {
      send({ type: 'memory_dispatched', id })
    }
  }, { prepend: true })
  ctx.on('agent/pre-step', async ({ agent, turn, step, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted || step !== 1) return decision
    clearPreviousContext(agent)
    const question = decision.messages.filter(message => message.source.kind === 'user')
      .flatMap(message => message.content.flatMap(part => part.type === 'text' ? [part.text] : [])).join('\n').slice(0, 20_000)
    if (!question) return decision
    const text = await request({ op: 'context', session: String(agent.session.id), turn, question }, agent, signal)
    if (!text || signal.aborted) return decision
    return { ...decision, messages: [...decision.messages, createUserMessage({ content: [{ type: 'text', text }], source: memorySource })] }
  }, { prepend: true })

  const tools = [
    { op: 'remember', description: '保存用户本轮明确要求记住的原文。只传原文，保留时间、条件和例外。',
      parameters: { text: { type: 'string', required: true }, kind: { type: 'string', enum: memoryKinds }, keywords: { type: 'array', items: { type: 'string' } } },
      input: (session: string, args: { text: string, kind?: typeof memoryKinds[number], keywords?: string[] }): MemoryRequest => ({ op: 'remember', session, ...args }) },
    { op: 'recall', description: '查有关的有效记忆，支持关键词、自然语言和历史日期 asOf（YYYY-MM-DD）。scope 设为 project 可查当前工作区项目；不能指定其他项目。用户明确深查或需要关系链、跨记录归纳时可设 deep。中文句子中的关系起点可用「」标出完整名称。match 为 semantic 表示按语义相似度找到的候选，使用前依据原文核对实际对象、关系和限制。relations 是带原始证据和适用区间的路径。conflicts 包含成对依据，pendingChanges 仍待确认。partial 表示结果不完整，可参考 reasons 缩小范围。只有不确定性会改变答案或操作、且无法用原文、本轮指示或条件式答案继续时才用 memory_clarify。后台任务记录歧义并完成可做部分。',
      parameters: { query: { type: 'string', required: true }, asOf: { type: 'string' }, scope: { type: 'string', enum: ['project'] }, deep: { type: 'boolean' } },
      input: (session: string, args: { query: string, asOf?: string, scope?: 'project', deep?: boolean }): MemoryRequest => ({ op: 'recall', session, ...args }) },
    { op: 'forget', description: '用户明确要求忘掉时使用。请用户说「忘掉 #编号」，也可以在关于你中操作。',
      parameters: { id: { type: 'integer', required: true } },
      input: (session: string, args: { id: number }): MemoryRequest => ({ op: 'forget', session, id: args.id }) },
  ] as const
  const output = {
    schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
    render: (_args: unknown, value: { text: string }) => [{ type: 'text' as const, text: value.text }],
  } as const
  function register<P extends ParameterSchemaSpec>(op: string, description: string, parameters: P, make: (session: string, args: unknown) => MemoryRequest) {
    ctx.tools.register(defineTool({
      name: 'memory_' + op, description, parameters, output,
      execute: async (args, exec) => ({ text: exec.agent
        ? await request(make(String(exec.agent.session.id), args), exec.agent, exec.signal) ?? '{"status":"unavailable"}'
        : '{"status":"unavailable"}' }),
    }))
  }
  for (const tool of tools) register(tool.op, tool.description, tool.parameters, (session, args) => tool.input(session, args as never))
  ctx.tools.register(defineTool({
    name: 'memory_clarify',
    description: '仅在当前回答或操作确实需要某项争议事实、也无法先给条件式答案或继续其他部分时使用。ref 必须来自本轮 memory_recall。回答只决定本轮用值。',
    parameters: { ref: { type: 'string', required: true } }, output,
    async execute({ ref }, exec) {
      const agent = exec.agent
      const unavailable = { text: '{"status":"unavailable"}' }
      if (!agent || !ctx.userQuestions) return unavailable
      const reply = await request({ op: 'clarify', session: String(agent.session.id), ref }, agent, exec.signal)
      if (!reply) return unavailable
      const result = memoryClarificationResult.safeParse(JSON.parse(reply))
      if (!result.success) return unavailable
      if (result.data.status !== 'ready') return { text: reply }
      const answer = await ctx.userQuestions.ask({ agent, signal: exec.signal, questions: [result.data.question] })
      return { text: JSON.stringify({ status: 'answered', scope: 'turn', answer }) }
    },
  }))
  send({ type: 'memory_ready', version: MEMORY_CONTRACT })
}

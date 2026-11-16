import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-questions'
import { memoryClarificationResult, memoryKinds } from '../../../src/memory/contracts/memory-contract.ts'
import type { MemoryRequest } from '../../../src/memory/contracts/memory-contract.ts'

export function registerMemoryTools(ctx: Context, request: (input: MemoryRequest, agent: Agent, signal?: AbortSignal) => Promise<string | null>,
  answerFileClarification: (questionId: string, text: string, agent: Agent, signal?: AbortSignal) => Promise<boolean>,
  cancelFileClarification: (questionId: string, agent: Agent) => void) {
  const tools = [
    { op: 'remember', description: '保存用户本轮明确要求记住的原文。只传原文，保留时间、条件和例外。',
      parameters: { text: { type: 'string', required: true }, kind: { type: 'string', enum: memoryKinds }, keywords: { type: 'array', items: { type: 'string' } } },
      input: (session: string, args: { text: string, kind?: typeof memoryKinds[number], keywords?: string[] }): MemoryRequest => ({ op: 'remember', session, ...args }) },
    { op: 'recall', description: '查有关的有效记忆，支持关键词、自然语言和历史日期 asOf（YYYY-MM-DD）。scope 设为 project 可查当前工作区项目；不能指定其他项目。用户明确深查或需要关系链、跨记录归纳时可设 deep。中文句子中的关系起点可用「」标出完整名称。match 为 semantic 表示按语义相似度找到的候选，使用前依据原文核对实际对象、关系和限制。notes 包含 daily/digest 的命中片段、完整文件行号及可见关联节点；文件检索的 notes.score 是固定加权倒数排名融合的排序分数，不是语义相似度、事实置信度或答案概率，单路降级也使用同一排名单位；结果顺序兼顾检索通道覆盖和文档多样性，不保证 score 降序，请保留返回顺序；可用 memory_read 读取返回 id 的指定行。核验事实时查看用户原文，并遵循 applicability 的替代状态。relations 是带原始证据和适用区间的路径。conflicts 包含成对依据，pendingChanges 仍待确认。partial 表示结果不完整，可参考 reasons 缩小范围。pendingClarification 表示原文件有待澄清的整理内容，不能作为确定事实；相关待确认结果可能附有本轮的 clarification.ref，可用于 memory_clarify。只有不确定性会改变答案或操作、且无法用原文、本轮指示或条件式答案继续时才用 memory_clarify。后台任务记录歧义并完成可做部分。',
      parameters: { query: { type: 'string', required: true }, asOf: { type: 'string' }, scope: { type: 'string', enum: ['project'] }, deep: { type: 'boolean' }, limit: { type: 'integer' }, min_score: { type: 'number' }, start_date: { type: 'string' }, end_date: { type: 'string' } },
      input: (session: string, args: { query: string, asOf?: string, scope?: 'project', deep?: boolean, limit?: number, min_score?: number, start_date?: string, end_date?: string }): MemoryRequest => ({ op: 'recall', session, ...args }) },
    { op: 'read', description: '按记忆搜索返回的文件 id 读取原文行。start_line/end_line 是完整 Markdown 文件的独立行号。默认返回可用于当前问题的内容；evidence=true 返回有替代状态、适用时间和条件的原文依据，不能把已被更正的内容当作现状。停用、遗忘或无权内容不会返回。',
      parameters: { id: { type: 'string', required: true }, start_line: { type: 'integer' }, end_line: { type: 'integer' }, evidence: { type: 'boolean' } },
      input: (session: string, args: { id: string, start_line?: number, end_line?: number, evidence?: boolean }): MemoryRequest => ({ op: 'file_read', session, ...args }) },
    { op: 'node_search', description: '搜索授权 digest 节点的名称和描述，不展开正文。用于找同一主题的长期记忆；需要依据时用 memory_read 读取返回 id。已失效的旧摘要不会作为当前节点返回。',
      parameters: { query: { type: 'string', required: true }, limit: { type: 'integer' } },
      input: (session: string, args: { query: string, limit?: number }): MemoryRequest => ({ op: 'node_search', session, ...args }) },
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
    description: '仅在当前回答或操作确实需要某项争议事实、也无法先给条件式答案或继续其他部分时使用。ref 必须来自本轮记忆检索。有待确认的文件只用实际答复作依据，协议会重新核验后恢复原整理任务。',
    parameters: { ref: { type: 'string', required: true } }, output,
    async execute({ ref }, exec) {
      const agent = exec.agent
      const unavailable = { text: '{"status":"unavailable"}' }
      if (!agent || !ctx.userQuestions) return unavailable
      if (agent.session.header.origin === 'subagent' || agent.session.header.origin === 'schedule') {
        return { text: '{"status":"rejected","reason":"foreground-only"}' }
      }
      const reply = await request({ op: 'clarify', session: String(agent.session.id), ref }, agent, exec.signal)
      if (!reply) return unavailable
      const result = memoryClarificationResult.safeParse(JSON.parse(reply))
      if (!result.success) return unavailable
      if (result.data.status === 'rejected') return { text: reply }
      const question = result.data.question
      const ask = () => ctx.userQuestions.ask({ agent, signal: exec.signal, questions: [question] })
      if (result.data.status !== 'ready-file') return { text: JSON.stringify({ status: 'answered', scope: 'turn', answer: await ask() }) }
      const cancel = () => cancelFileClarification(question.id, agent)
      if (exec.signal?.aborted) { cancel(); return unavailable }
      exec.signal?.addEventListener('abort', cancel, { once: true })
      let accepted = false
      try {
        const answer = await ask()
        const sole = answer.answers.length === 1 ? answer.answers[0] : undefined
        const text = sole?.id === question.id && sole.selected.length === 0 ? sole.custom?.trim() : undefined
        if (!text) return { text: '{"status":"unanswered"}' }
        accepted = await answerFileClarification(question.id, text, agent, exec.signal)
        return accepted ? { text: JSON.stringify({ status: 'answered', scope: 'turn', answer }) }
          : { text: '{"status":"rejected","reason":"stale-dispute"}' }
      } finally {
        exec.signal?.removeEventListener('abort', cancel)
        if (!accepted) cancel()
      }
    },
  }))
}

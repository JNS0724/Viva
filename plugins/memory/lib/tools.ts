import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-questions'
import { memoryClarificationResult, memoryKinds } from '../../../src/memory/contracts/memory-contract.ts'
import type { MemoryRequest } from '../../../src/memory/contracts/memory-contract.ts'

export function registerMemoryTools(ctx: Context, request: (input: MemoryRequest, agent: Agent, signal?: AbortSignal) => Promise<string | null>) {
  const tools = [
    { op: 'remember', description: '保存用户本轮明确要求记住的原文。只传原文，保留时间、条件和例外。',
      parameters: { text: { type: 'string', required: true }, kind: { type: 'string', enum: memoryKinds }, keywords: { type: 'array', items: { type: 'string' } } },
      input: (session: string, args: { text: string, kind?: typeof memoryKinds[number], keywords?: string[] }): MemoryRequest => ({ op: 'remember', session, ...args }) },
    { op: 'recall', description: '查有关的有效记忆，支持关键词、自然语言和历史日期 asOf（YYYY-MM-DD）。scope 设为 project 可查当前工作区项目；不能指定其他项目。用户明确深查或需要关系链、跨记录归纳时可设 deep。中文句子中的关系起点可用「」标出完整名称。match 为 semantic 表示按语义相似度找到的候选，使用前依据原文核对实际对象、关系和限制。notes 提供临时上下文，核验事实时应查看用户原文。relations 是带原始证据和适用区间的路径。conflicts 包含成对依据，pendingChanges 仍待确认。partial 表示结果不完整，可参考 reasons 缩小范围。只有不确定性会改变答案或操作、且无法用原文、本轮指示或条件式答案继续时才用 memory_clarify。后台任务记录歧义并完成可做部分。',
      parameters: { query: { type: 'string', required: true }, asOf: { type: 'string' }, scope: { type: 'string', enum: ['project'] }, deep: { type: 'boolean' }, limit: { type: 'integer' }, min_score: { type: 'number' }, start_date: { type: 'string' }, end_date: { type: 'string' } },
      input: (session: string, args: { query: string, asOf?: string, scope?: 'project', deep?: boolean, limit?: number, min_score?: number, start_date?: string, end_date?: string }): MemoryRequest => ({ op: 'recall', session, ...args }) },
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
}

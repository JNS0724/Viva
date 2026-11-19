import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { MemoryRequest } from '../../../src/memory/contracts/memory-contract.ts'
import { APP_WRITE_TIMEOUT_MS, MEMORY_READ_BUDGET_MS } from '../../../src/shared/request-budget.ts'
import { currentToolBudget } from '../../../src/shared/node/tool-call-budget.ts'

export function registerMemoryTools(ctx: Context, request: (input: MemoryRequest, agent: Agent, signal?: AbortSignal) => Promise<string | null>) {
  const tools = [
    { op: 'remember', description: '保存用户本轮要求保留的原文片段。text 必须在当前真实用户原文中精确出现，并完整保留时间、条件、归属和例外。不能把改写、模型建议或外部材料当作用户原话。',
      parameters: { text: { type: 'string', required: true } },
      input: (session: string, args: { text: string }): MemoryRequest => ({ op: 'remember', session, ...args }) },
    { op: 'recall', description: '搜索授权的 daily/digest 记忆文件，支持关键词、自然语言和历史日期 asOf（YYYY-MM-DD）。scope=project 查询当前工作区项目。notes 含命中片段、完整文件行号和可见关联节点，可用 memory_read 读取完整依据。notes.score 是固定加权倒数排名融合的排序分数，请保留返回顺序。核验时查看用户原文和 applicability 的替代状态、时间及条件。partial/reasons 表示结果不完整。若当前用户任务缺少必要信息，可以直接就当前任务提问。',
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
      name: 'memory_' + op, timeoutMs: op === 'remember' ? APP_WRITE_TIMEOUT_MS : MEMORY_READ_BUDGET_MS, description, parameters, output,
      execute: async (args, exec) => {
        const agent = exec.agent
        if (!agent) return { text: '{"status":"unavailable"}' }
        const budget = currentToolBudget()
        const invoke = () => request(make(String(agent.session.id), args), agent, exec.signal)
        const text = await (budget ? budget.run(invoke) : invoke())
        return { text: text ?? '{"status":"unavailable"}' }
      },
    }))
  }
  for (const tool of tools) register(tool.op, tool.description, tool.parameters, (session, args) => tool.input(session, args as never))
}

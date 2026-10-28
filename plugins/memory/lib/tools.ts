import type { ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'
import { recallMatches } from './match.ts'
import { MEMORY_KINDS } from './store.ts'
import type { Memory } from './store.ts'

/** Prefixed so they can't clash with another plugin's tools; dsh shows them to the model under these names. */
export const MEMORY_TOOL_NAMES = Object.freeze(['memory_remember', 'memory_recall', 'memory_forget'])
const RECALL_LIMIT = 5
const MAX_QUERY_CHARS = 200

const pad = (n: number) => String(n).padStart(2, '0')
const day = (ts: number) => {
  const date = new Date(ts)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}
const listLine = (memory: Memory) => {
  const keywords = memory.keywords.length ? `〔${memory.keywords.join('、')}〕` : ''
  return `#${memory.id}（${day(memory.createdAt)}，${memory.kind}）${memory.text}${keywords}`
}

function assertQuery(query: unknown): string {
  if (typeof query !== 'string' || !query.trim() || query.length > MAX_QUERY_CHARS) throw new Error('查询要写具体关键词，最多 200 个字符')
  return query
}

/**
 * The memory tools, independent of dsh so they can be tested directly. `parameters` is dsh's schema DSL;
 * lengths and secrets are checked by the store, which throws a readable message the model can relay.
 * Each `run` returns the text the model sees.
 */
export function memoryTools(db: ReturnType<typeof import('./store.ts').openMemoryDb>): Array<{
  name: string, description: string, parameters: ParameterSchemaSpec, run: (args: any) => string,
}> {
  return [
    {
      name: 'memory_remember',
      description: '把一条以后仍然有用的事实、约定、决定或偏好保存到用户的长期记忆。每条一句话，写清主语、对象和时间。'
        + '用户对你以后的回答方式提出要求时也要保存（kind=preference）；不调用本工具，下次对话就不会记得。',
      parameters: {
        text: { type: 'string', required: true, description: '要记住的内容，一句话' },
        kind: {
          type: 'string',
          enum: MEMORY_KINDS,
          description: 'role 用户的身份、部门、职责；person 常打交道的人；project 在推进的事；preference 对回答方式的偏好；fact 其他事实、约定、决定（默认）',
        },
        keywords: {
          type: 'array',
          items: { type: 'string' },
          description: '这条记忆涉及的人名、项目名、系统名或专有术语，1–4 个，例如 ["张三", "周报"]；不要写“项目”“工作”这类泛词',
        },
      },
      run({ text, kind = 'fact', keywords = [] }) {
        const { memory, created } = db.addMemory({ text, kind, keywords, source: 'agent' })
        return created ? `已记住（#${memory.id}）：${memory.text}` : `之前已经记过（#${memory.id}）：${memory.text}`
      },
    },
    {
      name: 'memory_recall',
      description: '用关键词在用户的长期记忆里检索。只返回足够相关的条目，可能一条都没有。',
      parameters: {
        query: { type: 'string', required: true, description: '具体关键词，空格分开；明确的对象可以只写一个，例如「常住」。多个词会提高相关性门槛，查不到时减少词再查，不要堆同义词或照抄整句话' },
      },
      run({ query }) {
        const found = recallMatches(db.allMemories(), assertQuery(query), RECALL_LIMIT)
        return found.length ? found.map(listLine).join('\n') : '没有找到相关的记忆。不要猜测，如实告诉用户你不知道。'
      },
    },
    {
      name: 'memory_forget',
      description: '按编号让一条记忆失效（编号来自 memory_recall 的结果），以后不再使用它。只在用户要求时使用。',
      parameters: { id: { type: 'integer', required: true, description: '记忆编号，例如 12' } },
      // Only marks it invalid: the user can bring it back from the "关于你" page; deleting is theirs to do.
      run({ id }) {
        const known = db.getMemory(id)
        if (!known) return `没有编号为 #${id} 的记忆。`
        if (known.invalidAt) return `#${id} 之前已经忘掉了。`
        const forgotten = db.invalidateMemory(id, { by: 'user' })
        // Gone in between (deleted from the app meanwhile): as if it had never been there.
        if (!forgotten) return `没有编号为 #${id} 的记忆。`
        return `已忘掉 #${id}：${forgotten.text}（用户可以在「关于你」里恢复）`
      },
    },
  ]
}

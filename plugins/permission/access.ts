import path from 'node:path'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'

/** dsh confines writes, but deliberately permits reads everywhere. Viva also asks before outside reads. */
export async function accessDecision({ preset, name, args, cwd, canonicalize }: {
  preset: string
  name: string
  args: unknown
  cwd?: string
  canonicalize: (file: string, cwd: string) => Promise<string>
}): Promise<PreToolDecision | null> {
  if (preset === 'danger-full-access' || preset === 'auto') return null
  // An arbitrary command can read beyond cwd. Never infer its read scope by parsing shell text.
  if (name === 'bash' || name === 'pwsh') return { kind: 'ask', reason: '命令可能访问工作区之外的文件，请确认后运行。' }
  const field = name === 'read' || name === 'read_image' ? 'file_path' : name === 'glob' || name === 'grep' ? 'path' : null
  if (!field) return null
  if (!cwd) return { kind: 'deny', reason: '无法确认工作目录，已停止文件访问。' }
  const values = typeof args === 'object' && args !== null ? args as Record<string, unknown> : {}
  const requested = values[field] ?? (field === 'path' ? '.' : undefined)
  if (typeof requested !== 'string' || !requested.trim()) return { kind: 'deny', reason: '文件路径无效。' }
  try {
    const [root, target] = await Promise.all([canonicalize(cwd, cwd), canonicalize(requested, cwd)])
    const relative = path.relative(root, target)
    if (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)) return null
    return { kind: 'ask', reason: `需要访问工作区之外的文件：${requested}` }
  } catch {
    return { kind: 'deny', reason: '无法核实文件所在位置，已停止文件访问。' }
  }
}

/**
 * The tools a session nobody watches may use (a schedule's run, system-design §12.2): looking things up only, as
 * dsh's sub-agents may (src/backend/dsh-profile.ts SUBAGENT_TOOLS, kept in step).
 */
export const READ_ONLY_TOOLS: readonly string[] = Object.freeze(['read', 'glob', 'grep', 'read_image', 'web_search', 'web_fetch', 'memory_recall', 'search_conversations', 'read_conversation', 'todo_write'])

/**
 * For a session nobody watches: only the read-only tools, and files in the workspace only. There is no one to ask,
 * so what would be asked is refused, whatever level the user picked.
 */
export async function unattendedDecision(request: { name: string, args: unknown, cwd?: string, canonicalize: (file: string, cwd: string) => Promise<string> }): Promise<PreToolDecision | null> {
  if (!READ_ONLY_TOOLS.includes(request.name)) return { kind: 'deny', reason: `定时任务只能查看，不能用 ${request.name}。` }
  const decision = await accessDecision({ ...request, preset: 'read-only' })
  return decision?.kind === 'ask' ? { kind: 'deny', reason: `定时任务无人确认：${decision.reason}` } : decision
}

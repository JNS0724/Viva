import type { Context } from '@deepseek-ai/cordis'
import { PtcExecutor } from '@deepseek-ai/dsh-tool-executor-ptc'
import { existsSync, writeFileSync } from 'node:fs'
import z from '@deepseek-ai/schemastery'

export const inject = ['tools', 'systemPrompt', 'ptcRuntime', 'sessions']
export const Config = z.object({ rejectSearch: z.boolean().default(false), crashBeforeSearch: z.string() })
/** Exercise the public per-agent executor selection while Viva's main router stays native. */
export function apply(ctx: Context, config: { rejectSearch?: boolean, crashBeforeSearch?: string } = {}) {
  const selected = new WeakSet<object>()
  ctx.on('system-prompt/assemble', (_presentation, { agent }, next) => {
    if (agent && !agent.ctx.tools.get('commit_route', agent) && !selected.has(agent)) {
      agent.ctx.tools.setExecutor(new PtcExecutor(agent.ctx))
      selected.add(agent)
    }
    return next()
  }, { prepend: true })
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.parent && exec.name === 'memory_node_search') {
      if (config.crashBeforeSearch && !existsSync(config.crashBeforeSearch)) {
        if (!exec.agent || await ctx.sessions.flush(exec.agent.session) !== true) throw new Error('No durable PTC prepare boundary')
        writeFileSync(config.crashBeforeSearch, 'dispatch-start flushed before prepare settles')
        process.kill(process.pid, 'SIGKILL')
      }
      if (config.rejectSearch || config.crashBeforeSearch) return { kind: 'deny', reason: 'Fixture rejects preparation' }
    }
    return next()
  })
}

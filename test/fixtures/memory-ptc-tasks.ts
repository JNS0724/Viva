import type { Context } from '@deepseek-ai/cordis'
import { PtcExecutor } from '@deepseek-ai/dsh-tool-executor-ptc'

export const inject = ['tools', 'systemPrompt', 'ptcRuntime']
/** Exercise the public per-agent executor selection while Viva's main router stays native. */
export function apply(ctx: Context) {
  const selected = new WeakSet<object>()
  ctx.on('system-prompt/assemble', (_presentation, { agent }, next) => {
    if (agent && !agent.ctx.tools.get('commit_route', agent) && !selected.has(agent)) {
      agent.ctx.tools.setExecutor(new PtcExecutor(agent.ctx))
      selected.add(agent)
    }
    return next()
  }, { prepend: true })
}

import type { Context } from '@deepseek-ai/cordis'
import { PtcExecutor } from '@deepseek-ai/dsh-tool-executor-ptc'
import { existsSync, writeFileSync } from 'node:fs'
import z from '@deepseek-ai/schemastery'

export const inject = ['tools', 'systemPrompt', 'ptcRuntime', 'sessions']
export const Config = z.object({ rejectSearch: z.boolean().default(false), crashBeforeSearch: z.string(), drainReadLog: z.string() })
/** Exercise the public per-agent executor selection while Viva's main router stays native. */
export function apply(ctx: Context, config: { rejectSearch?: boolean, crashBeforeSearch?: string, drainReadLog?: string } = {}) {
  const selected = new WeakSet<object>()
  const readSignals = new Map<string, AbortSignal>()
  ctx.on('tools/execute', (exec, next) => {
    if (exec.parent && exec.name === 'memory_read') readSignals.set(String(exec.callId), exec.signal)
    return next()
  }, { prepend: true })
  ctx.on('tools/ptc-dispatch-log', async (dispatch, next) => {
    const signal = readSignals.get(String(dispatch.subCallId))
    if (config.drainReadLog && signal) {
      // The pinned executor resolves the binding first, then normally aborts
      // its body controller and drains this still-pending log publication.
      if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
      writeFileSync(config.drainReadLog, 'settled dispatch log resumed after the normal program body closed')
    }
    return next()
  }, { prepend: true })
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

import { createHash } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdir, realpath } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { SaveTextSpill, SpillRef } from '@deepseek-ai/dsh-spill'
import { LocalSpillStore } from '@deepseek-ai/dsh-spill-local'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { openMemoryOwner } from '../../../../src/memory/node/owner.ts'
import type { trackNativeToolReads } from './tool-reads.ts'
import { publishGovernedNativeSpill, reserveNativeSpill } from './governed-spills.ts'
import { replaceServiceMethod } from './service-method.ts'

export function trackNativeSpills(ctx: Context, owner: ReturnType<typeof openMemoryOwner>, tools: ReturnType<typeof trackNativeToolReads>) {
  const settled = new AsyncLocalStorage<{ name: string, lease: NonNullable<ReturnType<typeof tools.settledSpill>> }>()
  ctx.on('tools/ptc-dispatch-log', (dispatch, next) => {
    const session = dispatch.agent?.session
    const lease = session && tools.settledSpill(session, dispatch.exec, String(dispatch.subCallId), dispatch.name)
    return lease ? settled.run({ name: dispatch.name, lease }, next) : next()
  }, { prepend: true })
  return ctx.inject(['spillStore'], scoped => {
    const store = scoped.spillStore, save = store.saveText
    let active = true
    const wrapped = async (input: SaveTextSpill): Promise<SpillRef> => {
      if (!active) return save.call(store, input)
      const session = ctx.sessions.get(SessionId(input.owner.sessionId))
      const candidate = settled.getStore()
      const log = input.source.kind === 'tool' && input.source.label === 'dispatch' && candidate?.name === input.source.toolName
        && candidate.lease.call.session === String(session?.id) && candidate.lease.call.callId === String(input.source.callId) ? candidate.lease : undefined
      const call = log ? log.current() ? log.call : undefined
        : input.source.kind === 'tool' && session ? tools.spill(session, input.source.callId, input.source.toolName) : undefined
      // Other storage backends have no verified local erase seam. The policy
      // falls back to inline text; no untracked artifact is written here.
      if (!call || !owner.ready() || call.generation !== owner.contextGeneration(call.session) || !(store instanceof LocalSpillStore)) {
        throw new Error('Native spill has no authenticated local execution')
      }
      if (!owner.nativeSpillGoverned(call)) return save.call(store, input)
      const current = () => active && owner.ready() && call.generation === owner.contextGeneration(call.session) && (log ? log.current() : Boolean(session
        && input.source.kind === 'tool' && tools.spill(session, input.source.callId, input.source.toolName)?.id === call.id))
      await mkdir(store.root, { recursive: true, mode: 0o700 })
      const intent = { call, root: await realpath(store.root), bytes: Buffer.byteLength(input.content, 'utf8'),
        hash: createHash('sha256').update(input.content).digest('hex') }
      const reserved = await reserveNativeSpill(intent, input.suggestedName)
      let id: string
      try { id = owner.beginNativeSpill(reserved.intent) }
      catch (error) { await reserved.handle.close(); throw error }
      const saved = await publishGovernedNativeSpill(reserved.handle, reserved.intent, input.content, current)
      owner.finishNativeSpill(id, saved.receipt)
      return saved.ref
    }
    const restore = replaceServiceMethod(store, 'saveText', wrapped)
    scoped.effect(() => () => { active = false; restore() }, 'memory spill receipts')
  })
}

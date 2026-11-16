import { createHash } from 'node:crypto'
import { mkdir, realpath } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { SaveTextSpill, SpillRef } from '@deepseek-ai/dsh-spill'
import { LocalSpillStore } from '@deepseek-ai/dsh-spill-local'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { openMemoryOwner } from '../../../../src/memory/node/owner.ts'
import type { trackNativeToolReads } from './tool-reads.ts'
import { verifyNativeSpill } from './local-spills.ts'

export function trackNativeSpills(ctx: Context, owner: ReturnType<typeof openMemoryOwner>, tools: ReturnType<typeof trackNativeToolReads>) {
  return ctx.inject(['spillStore'], scoped => {
    const store = scoped.spillStore, save = store.saveText
    const wrapped = async (input: SaveTextSpill): Promise<SpillRef> => {
      const session = ctx.sessions.get(SessionId(input.owner.sessionId))
      const call = input.source.kind === 'tool' && session ? tools.spill(session, input.source.callId, input.source.toolName) : undefined
      // Other storage backends have no verified local erase seam. The policy
      // falls back to inline text; no untracked artifact is written here.
      if (!call || !owner.ready() || call.generation !== owner.contextGeneration(call.session) || !(store instanceof LocalSpillStore)) {
        throw new Error('Native spill has no authenticated local execution')
      }
      await mkdir(store.root, { recursive: true, mode: 0o700 })
      const intent = { call, root: await realpath(store.root), bytes: Buffer.byteLength(input.content, 'utf8'),
        hash: createHash('sha256').update(input.content).digest('hex') }
      const id = owner.beginNativeSpill(intent)
      const result = await save.call(store, input)
      if (result.bytes !== intent.bytes) throw new Error('Native spill length differs from the saved file')
      owner.finishNativeSpill(id, await verifyNativeSpill(intent, result.locator))
      return result
    }
    store.saveText = wrapped
    scoped.effect(() => () => { if (store.saveText === wrapped) store.saveText = save }, 'memory spill receipts')
  })
}

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { memoryOriginalContentDigest } from './context-recovery.ts'

export type MemoryToolOrigin = { generation: number, recipients: ReadonlyMap<string, number> }
export type MemoryDeliveryProof = { contextGeneration: number, senderContextGeneration: number, contentDigest: string }
type Output = { digest: string, generation: number, durable: Promise<unknown> }
type Pending = { digest: string, resolve(proof: MemoryDeliveryProof): void, reject(error: Error): void, timer: ReturnType<typeof setTimeout> }
type Run = { parent: string, child: string, parentGeneration: number, initialGeneration: number | Promise<number>, outputs: Output[], pending: Pending[] }

/** Process-local causal bindings. Durable receipt storage remains the owner's responsibility. */
export function createMemoryDeliveryBindings() {
  const steps = new Map<string, MemoryToolOrigin>()
  const calls = new Map<string, MemoryToolOrigin>()
  const runs = new Map<string, Run>()
  const stepKey = (session: string, turn: number, step: number) => JSON.stringify([session, turn, step])
  const release = (session: string) => {
    const prefix = `[${JSON.stringify(session)},`
    for (const key of steps.keys()) if (key.startsWith(prefix)) steps.delete(key)
    for (const key of calls.keys()) if (key.startsWith(prefix)) calls.delete(key)
  }
  const runFor = (child: string) => [...runs.values()].find(run => run.child === child)
  function reject(run: Run, error: Error) {
    for (const pending of run.pending) { clearTimeout(pending.timer); pending.reject(error) }
    run.pending.length = 0
  }
  return {
    step(session: string, turn: number, step: number, generation: number, recipients: ReadonlyMap<string, number>) {
      release(session)
      steps.set(stepKey(session, turn, step), { generation, recipients: new Map(recipients) })
    },
    start(runId: string, parent: string, child: string, parentGeneration: number, childGeneration: number | Promise<number>) {
      const previous = runFor(child)
      if (previous) reject(previous, new Error('Subagent delivery run was replaced'))
      for (const [id, run] of runs) if (run.child === child) runs.delete(id)
      if (childGeneration instanceof Promise) void childGeneration.catch(() => {})
      runs.set(runId, { parent, child, parentGeneration, initialGeneration: childGeneration, outputs: [], pending: [] })
    },
    output(session: string, turn: number, step: number, content: readonly ContentBlock[], durable: Promise<unknown>) {
      const origin = steps.get(stepKey(session, turn, step))
      if (!origin) return
      void durable.catch(() => {})
      for (const block of content) if (block.type === 'tool-call') calls.set(JSON.stringify([session, block.id]), origin)
      if (content.length) runFor(session)?.outputs.push({ digest: memoryOriginalContentDigest({ content }), generation: origin.generation, durable })
    },
    tool(session: string, rootCallId: string) { return calls.get(JSON.stringify([session, rootCallId])) },
    relay(sender: string, recipient: string, digest: string, origin: MemoryToolOrigin): MemoryDeliveryProof {
      const run = runFor(sender)
      const contextGeneration = run?.parent === recipient ? run.parentGeneration : origin.recipients.get(recipient)
      if (contextGeneration === undefined) throw new Error('Derived delivery has no verified recipient generation')
      return { contextGeneration, senderContextGeneration: origin.generation, contentDigest: digest }
    },
    settlement(sender: string, recipient: string, digest: string): Promise<MemoryDeliveryProof> | undefined {
      const run = runFor(sender)
      if (!run || run.parent !== recipient) return undefined
      const promise = new Promise<MemoryDeliveryProof>((resolve, rejectPending) => {
        const pending: Pending = { digest, resolve, reject: rejectPending, timer: setTimeout(() => {
          run.pending = run.pending.filter(item => item !== pending)
          rejectPending(new Error('Subagent settlement has no verified completion receipt'))
        }, 10_000) }
        pending.timer.unref()
        run.pending.push(pending)
      })
      void promise.catch(() => {})
      return promise
    },
    async end(runId: string, content: readonly ContentBlock[] | undefined) {
      const run = runs.get(runId)
      if (!run) return undefined
      try {
        // DSH returns the last nonempty assistant event, even if a later recovery shadowed it.
        // Preserve event order: equal text across generations must not overwrite its origin.
        const output = run.outputs.at(-1)
        let generation: number
        if (content?.length) {
          if (!output || output.digest !== memoryOriginalContentDigest({ content })) throw new Error('Subagent output has no exact generation receipt')
          await output.durable
          generation = output.generation
        } else generation = await run.initialGeneration
        for (const pending of run.pending) {
          clearTimeout(pending.timer)
          pending.resolve({ contextGeneration: run.parentGeneration, senderContextGeneration: generation, contentDigest: pending.digest })
        }
        return { contextGeneration: run.parentGeneration, senderContextGeneration: generation }
      } catch (error) {
        reject(run, error instanceof Error ? error : new Error('Subagent output receipt failed'))
        throw error
      } finally { if (runs.get(runId) === run) runs.delete(runId) }
    },
    release,
    close() { for (const run of runs.values()) reject(run, new Error('Memory delivery bindings closed')); runs.clear(); steps.clear(); calls.clear() },
  }
}

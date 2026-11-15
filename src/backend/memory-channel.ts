import { DAILY_MEMORY_DEFAULTS } from '../memory/contracts/memory-daily-defaults.ts'
import { MEMORY_CONTRACT, isDailyMemoryStage, memoryComputeFailure, memoryComputeUsage, memoryRequest } from '../memory/contracts/memory-contract.ts'
import type { MemoryCompute, MemoryComputeFailure, MemoryComputeUsage, MemoryRequest } from '../memory/contracts/memory-contract.ts'
import { objectOf } from '../shared/unknown-value.ts'

export type MemoryDispatchAdmission = boolean | { allowed: boolean, deadline?: number | null }

import { MemoryComputeError } from '../memory/contracts/compute.ts'
export { MemoryComputeError } from '../memory/contracts/compute.ts'

type ComputationResult = ({ text: string } | { failure: MemoryComputeError['reason'] }) & { usage?: MemoryComputeUsage }

export function createMemoryChannel({ send, handle, onReady, beginDispatch, beginJobDispatch, endDispatch, timeoutMs = 120_000 }: {
  send: (message: object) => void,
  handle?: (request: MemoryRequest, parent: string | undefined, signal: AbortSignal) => string | Promise<string>,
  onReady?: () => void,
  beginDispatch?: (id: string, session: string, parent?: string) => MemoryDispatchAdmission | Promise<MemoryDispatchAdmission>,
  beginJobDispatch?: (id: string, jobId: string) => MemoryDispatchAdmission | Promise<MemoryDispatchAdmission>,
  endDispatch?: (id: string) => void,
  timeoutMs?: number,
}) {
  const jobs = new Map<string, { generation: number, daily: boolean, done: (result: ComputationResult) => void }>()
  const dispatches = new Map<string, 'pending' | 'allowed'>()
  const queries = new Map<string, AbortController>()
  let ready = false
  let closed = false

  function release(id: string) {
    const state = dispatches.get(id)
    dispatches.delete(id)
    if (state === 'allowed') endDispatch?.(id)
  }

  function cancelQuery(id: string) {
    const query = queries.get(id)
    queries.delete(id)
    query?.abort()
  }

  function compute(job: MemoryCompute, signal?: AbortSignal): Promise<string> | null {
    if (!ready || jobs.has(job.id) || signal?.aborted) return null
    const started = performance.now()
    return new Promise((resolve, reject) => {
      const abort = () => {
        send({ type: 'memory_compute_cancel', id: job.id, generation: job.generation })
        finish({ failure: 'aborted' })
      }
      const finish = (result: ComputationResult) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        jobs.delete(job.id)
        if (job.stage === 'extract' || job.stage === 'note' || job.stage === 'dream') {
          console.info(job.stage === 'extract' ? '[memory] extraction model' : '[memory] daily model', JSON.stringify({
            stage: job.stage,
            usage: result.usage ?? null, durationMs: Math.round(performance.now() - started),
            finishReason: 'failure' in result ? result.failure : 'stop',
          }))
        }
        if ('failure' in result) reject(new MemoryComputeError(result.failure))
        else resolve(result.text)
      }
      const daily = isDailyMemoryStage(job.stage)
      const timer = setTimeout(() => {
        send({ type: 'memory_compute_cancel', id: job.id, generation: job.generation })
        finish({ failure: 'timeout' })
      }, daily ? DAILY_MEMORY_DEFAULTS.backgroundTimeoutMs : timeoutMs)
      timer.unref()
      jobs.set(job.id, { generation: job.generation, daily, done: finish })
      signal?.addEventListener('abort', abort, { once: true })
      send({ type: 'memory_compute', job })
    })
  }

  return {
    compute,
    ready: () => ready,
    receive(raw: unknown) {
      const message = objectOf(raw)
      if (message?.type === 'memory_ready' && message.version === MEMORY_CONTRACT && handle && !closed) {
        ready = true
        onReady?.()
        return
      }
      if (message?.type === 'memory_computed' && typeof message.id === 'string') {
        const job = jobs.get(message.id)
        if (job && job.generation === message.generation) {
          const failure = memoryComputeFailure.safeParse(message.failure)
          const usage = memoryComputeUsage.safeParse(message.usage).data
          if (failure.success) job.done({ failure: failure.data, usage })
          else if (typeof message.text !== 'string') job.done({ failure: 'missing-reply', usage })
          else if (!job.daily && message.text.length >= 20_000) job.done({ failure: 'oversize-reply', usage })
          else job.done({ text: message.text, usage })
        }
      }
      if (typeof message?.id !== 'string' || message.id.length > 128) return
      const id = message.id
      if (message.type === 'memory_dispatched') {
        release(id)
        return
      }
      if (closed) return
      if (message.type === 'memory_query_cancel') {
        cancelQuery(id)
        return
      }
      const parent = typeof message.parent === 'string' && message.parent.length <= 128 ? message.parent : undefined
      if (message.type === 'memory_dispatch') {
        const session = typeof message.session === 'string' && message.session.length > 0 && message.session.length <= 128 ? message.session : undefined
        const jobId = typeof message.jobId === 'string' && message.jobId.length > 0 && message.jobId.length <= 128 ? message.jobId : undefined
        if (Boolean(session) === Boolean(jobId)) return
        if (dispatches.has(id)) return
        dispatches.set(id, 'pending')
        const grant = () => jobId
          ? jobs.has(jobId) && (beginJobDispatch?.(id, jobId) ?? false)
          : session && (beginDispatch?.(id, session, parent) ?? true)
        void Promise.resolve().then(grant).then(result => {
          const allowed = typeof result === 'object' ? result.allowed : Boolean(result)
          if (!allowed || !dispatches.has(id) || closed) {
            if (allowed) endDispatch?.(id)
            release(id)
            send({ type: 'memory_dispatch_result', id, allowed: false })
            return
          }
          dispatches.set(id, 'allowed')
          const deadline = typeof result === 'object' ? result.deadline : null
          send({ type: 'memory_dispatch_result', id, allowed: true, ...(deadline ? { deadline } : {}) })
        }, () => {
          release(id)
          send({ type: 'memory_dispatch_result', id, allowed: false })
        })
        return
      }
      if (message.type !== 'memory_query' || !handle || queries.has(id)) return
      const request = memoryRequest.safeParse(message.request)
      const controller = new AbortController()
      queries.set(id, controller)
      const reply = (result: { text: string } | { error: true }) => {
        if (queries.get(id) !== controller) return
        queries.delete(id)
        send({ type: 'memory_response', id, ...result })
      }
      try {
        if (!request.success) throw new Error('invalid memory request')
        const result = handle(request.data, parent, controller.signal)
        if (typeof result === 'string') reply({ text: result })
        else void result.then(text => reply({ text }), () => reply({ error: true }))
      } catch {
        reply({ error: true })
      }
    },
    close() {
      closed = true
      ready = false
      for (const id of queries.keys()) cancelQuery(id)
      for (const job of jobs.values()) job.done({ failure: 'aborted' })
    },
    processExited() { for (const id of dispatches.keys()) release(id) },
  }
}

import { MEMORY_CONTRACT, memoryRequest } from '../shared/memory-contract.ts'
import type { MemoryCompute, MemoryRequest } from '../shared/memory-contract.ts'
import { objectOf } from '../shared/unknown-value.ts'

export type MemoryDispatchAdmission = boolean | { allowed: boolean, deadline?: number | null }

export function createMemoryChannel({ send, handle, onReady, beginDispatch, beginJobDispatch, endDispatch, timeoutMs = 120_000 }: {
  send: (message: object) => void,
  handle?: (request: MemoryRequest, parent?: string) => string,
  onReady?: () => void,
  beginDispatch?: (id: string, session: string, parent?: string) => MemoryDispatchAdmission | Promise<MemoryDispatchAdmission>,
  beginJobDispatch?: (id: string, jobId: string) => MemoryDispatchAdmission | Promise<MemoryDispatchAdmission>,
  endDispatch?: (id: string) => void,
  timeoutMs?: number,
}) {
  const jobs = new Map<string, { generation: number, done: (text: string | null) => void }>()
  const dispatches = new Map<string, 'pending' | 'allowed'>()
  let ready = false
  let closed = false

  function release(id: string) {
    const state = dispatches.get(id)
    dispatches.delete(id)
    if (state === 'allowed') endDispatch?.(id)
  }

  function compute(job: MemoryCompute, signal?: AbortSignal): Promise<string> | null {
    if (!ready || jobs.has(job.id) || signal?.aborted) return null
    return new Promise((resolve, reject) => {
      const abort = () => {
        send({ type: 'memory_compute_cancel', id: job.id, generation: job.generation })
        finish(null)
      }
      const finish = (text: string | null) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        jobs.delete(job.id)
        if (text === null) reject(new Error('memory model computation did not finish'))
        else resolve(text)
      }
      const timer = setTimeout(() => finish(null), timeoutMs)
      timer.unref()
      jobs.set(job.id, { generation: job.generation, done: finish })
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
        if (job && job.generation === message.generation) job.done(typeof message.text === 'string' && message.text.length < 20_000 ? message.text : null)
      }
      if (typeof message?.id !== 'string' || message.id.length > 128) return
      const id = message.id
      if (message.type === 'memory_dispatched') {
        release(id)
        return
      }
      if (closed) return
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
      if (message.type !== 'memory_query' || !handle) return
      const request = memoryRequest.safeParse(message.request)
      try {
        if (!request.success) throw new Error('invalid memory request')
        send({ type: 'memory_response', id, text: handle(request.data, parent) })
      } catch {
        send({ type: 'memory_response', id: message.id, error: true })
      }
    },
    close() { closed = true; ready = false; for (const job of jobs.values()) job.done(null) },
    processExited() { for (const id of dispatches.keys()) release(id) },
  }
}

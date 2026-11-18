import { DIAGNOSTIC_LIMITS } from '../contracts.ts'
import type { DiagnosticComponent } from '../contracts.ts'
import { diagnosticBinding, emitDiagnostic, setDiagnosticBinding } from './context.ts'
import type { ManagedDiagnostics } from './managed.ts'
import { createDiagnosticChild, createDiagnosticPeer, safeDiagnosticSnapshot } from './peer.ts'
import type { ComponentDiagnosticSnapshot, DiagnosticChild } from './peer.ts'

type Send = Parameters<typeof createDiagnosticChild>[0]['send']
let installed: DiagnosticHub | undefined
export function diagnosticHub() { return installed }

/** Process-local diagnostics topology. Its IPC never shares a business queue or authorization. */
export function createDiagnosticHub({ component, writers, send, onBinding }: {
  component: DiagnosticComponent, writers: Array<{ component: DiagnosticComponent, writer: ManagedDiagnostics, snapshot?: ManagedDiagnostics['snapshot'] }>,
  send?: Send, onBinding?: (runId: string) => void,
}) {
  const children = new Set<DiagnosticChild>()
  const debugSync = new Map<DiagnosticChild, () => void>()
  let debugUntil = 0
  let closed = false
  const previous = installed, previousBinding = diagnosticBinding()
  function bind() {
    const id = writers[0]?.writer.identity()?.diagnosticRunId
    if (id && !closed) { setDiagnosticBinding(id); onBinding?.(id) }
  }
  for (const { writer } of writers) void writer.ready.then(bind).catch(() => {})
  async function collect(durationMs: number = DIAGNOSTIC_LIMITS.snapshotMs): Promise<ComponentDiagnosticSnapshot[]> {
    const started = performance.now()
    const local = writers.flatMap(({ component, writer, snapshot }) => {
      const value = safeDiagnosticSnapshot(snapshot ? snapshot() : writer.snapshot())
      return value ? [{ component, ...value }] : []
    })
    // Each relay keeps time for its own reply; a frozen grandchild cannot hide a live backend.
    const remaining = Math.max(1, durationMs - (performance.now() - started) - 150)
    const replies = await Promise.all([...children].map(child => child.request('snapshot', { durationMs: remaining })))
    for (const reply of replies) if (reply.ok) for (const snapshot of reply.snapshots ?? []) {
      if (local.length < 8 && !local.some(value => value.component === snapshot.component)) local.push(snapshot)
    }
    return local
  }
  async function prepare(clearId: string) {
    const peers = [...children]
    const results = await Promise.all([
      ...writers.map(({ writer }) => writer.prepare(clearId)),
      ...peers.map(async child => { const result = await child.request('clear.prepare', { clearId }); return result.ok && result.closed === true }),
    ])
    return results.every(Boolean) && children.size === peers.length && peers.every(child => children.has(child))
  }
  async function resume(clearId: string, runId: string) {
    debugUntil = 0
    const peers = [...children]
    const local = await Promise.all(writers.map(({ writer }) => writer.resume(clearId, runId)))
    if (local.every(Boolean)) { setDiagnosticBinding(runId); onBinding?.(runId) }
    const results = await Promise.all(peers.map(async child => (await child.request('clear.resume', { clearId, runId })).ok))
    return local.every(Boolean) && results.every(Boolean)
  }
  function debug(durationMs: number) {
    debugUntil = performance.now() + Math.min(15 * 60_000, Math.max(0, durationMs))
    for (const { writer } of writers) writer.setDebug(durationMs)
    for (const synchronize of debugSync.values()) synchronize()
  }
  const peer = send ? createDiagnosticPeer({ component, source: writers[0]!.writer, send, prepare, resume, debug, collect }) : undefined
  const hub = {
    collect, prepare, resume, debug,
    receive: (raw: unknown) => peer?.receive(raw) ?? false,
    attach(component: DiagnosticComponent, send: Send) {
      const child = createDiagnosticChild({ component, send, observe: emitDiagnostic })
      children.add(child)
      let applied = -1, sending = false
      const synchronize = () => {
        if (sending || applied === debugUntil || child.health().status !== 'responsive') return
        sending = true
        const target = debugUntil
        void child.request('debug', { durationMs: Math.max(0, target - performance.now()) }).then(result => {
          if (result.ok) applied = target
        }).finally(() => { sending = false })
      }
      debugSync.set(child, synchronize)
      return { receive(raw: unknown) { const accepted = child.receive(raw); if (accepted) synchronize(); return accepted },
        close() { child.close(); children.delete(child); debugSync.delete(child) } }
    },
    health: () => [...children].map(child => child.health()),
    close() {
      closed = true; peer?.close()
      for (const child of children) child.close()
      children.clear(); debugSync.clear()
      if (installed === hub) { installed = previous; setDiagnosticBinding(previousBinding) }
    },
  }
  installed = hub
  return hub
}
export type DiagnosticHub = ReturnType<typeof createDiagnosticHub>

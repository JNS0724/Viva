import { createDiagnosticHealthMonitor } from '../diagnostics/node/health.ts'
import { parseDiagnosticHealth } from '../diagnostics/health.ts'
import { emitDiagnostic } from '../diagnostics/node/context.ts'
import type { DiagnosticHealthSource } from '../diagnostics/node/health.ts'

interface Sender { id: number, isDestroyed(): boolean }
const senderOf = (value: unknown): value is Sender => value !== null && typeof value === 'object'
  && 'id' in value && Number.isSafeInteger(value.id) && 'isDestroyed' in value && typeof value.isDestroyed === 'function'
/** Each renderer is supervised separately, so a live island cannot conceal a frozen main window. */
export function createRendererHealth(source?: DiagnosticHealthSource) {
  const monitors = new Map<number, { sender: Sender, monitor: ReturnType<typeof createDiagnosticHealthMonitor> }>()
  const timer = setInterval(() => {
    for (const [id, { sender, monitor }] of monitors) {
      if (sender.isDestroyed()) { monitor.close(); monitors.delete(id) } else monitor.check()
    }
  }, 5_000)
  timer.unref()
  return {
    receive(sender: unknown, raw: unknown) {
      const health = parseDiagnosticHealth(raw)
      if (!health || health.component !== 'renderer' || !senderOf(sender) || sender.isDestroyed()) return
      let entry = monitors.get(sender.id)
      if (!entry) {
        if (monitors.size >= 8) return
        entry = { sender, monitor: createDiagnosticHealthMonitor({ component: 'renderer', observe: emitDiagnostic }) }
        monitors.set(sender.id, entry)
      }
      const stats = source?.snapshot().stats
      entry.monitor.receive(stats ? { ...health, sinkState: stats.state, droppedCount: stats.droppedCount } : health)
    },
    snapshot: () => [...monitors.values()].map(value => value.monitor.snapshot()),
    close() { clearInterval(timer); for (const { monitor } of monitors.values()) monitor.close(); monitors.clear() },
  }
}

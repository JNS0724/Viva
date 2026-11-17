import { argsProblem } from '../shared/ipc-contract.ts'
import type { IpcRegistry } from '../shared/ipc-contract.ts'
import { guardDiagnosticPort, parseDiagnosticContext } from '../diagnostics/contracts.ts'
import type { DiagnosticPort } from '../diagnostics/contracts.ts'
import { safeDiagnosticEvent } from '../diagnostics/node/record.ts'
import { emitDiagnostic, inDiagnosticContext } from '../diagnostics/node/context.ts'

/** The original channel decoder still authorizes every business call. */
export function registerDiagnosticIpc(ipcMain: IpcRegistry, { renderer, forwarded, invoke, exportBundle, openFolder, status }: {
  renderer: DiagnosticPort,
  forwarded: () => ReadonlySet<string>,
  invoke: (channel: string, args: readonly unknown[]) => Promise<unknown>,
  exportBundle: () => Promise<unknown>, openFolder: () => unknown, status: () => unknown,
}) {
  let second = 0, received = 0, droppedCount = 0
  const safeRenderer = guardDiagnosticPort(renderer)
  ipcMain.on('diagnostics:event', (_event, raw) => {
    const current = Math.floor(Date.now() / 1000)
    if (current !== second) { second = current; received = 0 }
    if (++received > 10 || !raw || typeof raw !== 'object') { droppedCount++; return }
    const event = safeDiagnosticEvent(raw)
    if (!event) { droppedCount++; return }
    const context = parseDiagnosticContext('diagnostics' in raw ? raw.diagnostics : undefined)
    inDiagnosticContext(context, () => safeRenderer.emit(event))
  })
  ipcMain.handle('diagnostics:invoke', async (_event, envelope) => {
    if (!forwarded().has(envelope.channel)) throw new Error('Channel is not forwarded by this window')
    const problem = argsProblem(envelope.channel, envelope.args)
    if (problem) throw new Error(problem)
    const context = parseDiagnosticContext(envelope.diagnostics)
    if (envelope.diagnostics !== undefined && !context) emitDiagnostic({ event: 'context.dropped', operation: 'ipc', reason: 'invalid_context' })
    return inDiagnosticContext(context, () => invoke(envelope.channel, envelope.args))
  })
  ipcMain.handle('diagnostics:export', () => exportBundle())
  ipcMain.handle('diagnostics:open-folder', () => openFolder())
  ipcMain.handle('diagnostics:status', () => status())
  return { droppedCount: () => droppedCount }
}

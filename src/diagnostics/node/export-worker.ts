import { writeDiagnosticBundle } from './bundle.ts'
import type { DiagnosticBundleRequest } from './bundle.ts'
import { safeDiagnosticReason } from '../contracts.ts'

process.once('message', (request: DiagnosticBundleRequest) => {
  void writeDiagnosticBundle(request).then(() => {
    process.send?.({ type: 'diagnostic-export-result', ok: true }, () => process.exit(0))
  }, error => {
    process.send?.({ type: 'diagnostic-export-result', ok: false, reason: safeDiagnosticReason(error) }, () => process.exit(1))
  })
})
process.on('disconnect', () => process.exit(1))

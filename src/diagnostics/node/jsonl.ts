import { DIAGNOSTIC_LIMITS } from '../contracts.ts'
import { setImmediate as yieldTurn } from 'node:timers/promises'

export interface DiagnosticFraming {
  sourceBytesRead: number; exportedThroughByte: number; trailingBytesOmitted: number
  partial_trailing_record: boolean; invalid_record: number
}

/** Bounded newline framing shared by export and startup inspection. Never decode a partial UTF-8 tail. */
export async function* diagnosticJsonl(input: AsyncIterable<Uint8Array>, report: DiagnosticFraming,
  options: { cooperate?: boolean; signal?: AbortSignal } = {}): AsyncGenerator<unknown> {
  let partial: Buffer = Buffer.alloc(0), oversized = false, offset = 0, frames = 0
  for await (const chunk of input) {
    const data = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    let from = 0
    while (from < data.length) {
      const newline = data.indexOf(10, from), end = newline === -1 ? data.length : newline
      const piece = data.subarray(from, end)
      if (partial.length + piece.length > DIAGNOSTIC_LIMITS.eventBytes) { oversized = true; partial = Buffer.alloc(0) }
      else if (!oversized) partial = partial.length ? Buffer.concat([partial, piece]) : Buffer.from(piece)
      offset += piece.length
      if (newline === -1) break
      offset++
      report.sourceBytesRead = offset
      if (options.cooperate && ++frames % 64 === 0) await yieldTurn(undefined, { signal: options.signal })
      options.signal?.throwIfAborted()
      if (oversized) report.invalid_record++
      else {
        let value: unknown, valid = false
        try { value = JSON.parse(partial.toString('utf8')); valid = true } catch { report.invalid_record++ }
        if (valid) yield value
      }
      report.exportedThroughByte = offset
      partial = Buffer.alloc(0); oversized = false; from = newline + 1
    }
  }
  report.sourceBytesRead = offset
  report.trailingBytesOmitted = offset - report.exportedThroughByte
  report.partial_trailing_record = report.trailingBytesOmitted > 0
}

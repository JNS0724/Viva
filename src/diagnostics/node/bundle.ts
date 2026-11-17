import { createReadStream, createWriteStream } from 'node:fs'
import { lstat, rename, unlink } from 'node:fs/promises'
import { Readable, Transform } from 'node:stream'
import { finished, pipeline } from 'node:stream/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { ZipFile } from 'yazl'
import { COMPONENTS, DIAGNOSTIC_LIMITS, OPERATIONS, REASONS, STAGES, safeDiagnosticReason } from '../contracts.ts'
import { newDiagnosticIdentity } from './identity.ts'
import type { DiagnosticIdentity } from './identity.ts'
import { sanitizeStoredDiagnostic } from './record.ts'
import { DIAGNOSTIC_FILE } from './quota.ts'

export interface DiagnosticFileRange { file: string; cutoff: number }
export interface DiagnosticFileManifest {
  entry: string; rawCutoffBytes: number; sourceBytesRead: number; exportedThroughByte: number
  trailingBytesOmitted: number; partial_trailing_record: boolean; outputBytes: number; invalid_record: number; reason?: string
}
export interface DiagnosticBundleRequest { directory: string; destination: string; temporary?: string; files: DiagnosticFileRange[]; snapshots?: unknown }
const object = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v)
const member = (items: readonly string[], v: unknown): v is string => typeof v === 'string' && items.includes(v)

/** Newline framing precedes UTF-8 decoding. Oversized/malformed records never enter the archive. */
export async function* diagnosticRecords(input: AsyncIterable<Uint8Array>, report: DiagnosticFileManifest, identity: DiagnosticIdentity): AsyncGenerator<Buffer> {
  let partial: Buffer = Buffer.alloc(0), oversized = false, offset = 0
  const record = (piece: Buffer): Buffer | undefined => {
    try {
      const parsed: unknown = JSON.parse(piece.toString('utf8'))
      const safe = sanitizeStoredDiagnostic(parsed, identity)
      if (!safe) { report.invalid_record++; return }
      return Buffer.from(`${JSON.stringify(safe)}\n`)
    } catch { report.invalid_record++; return }
  }
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
      if (oversized) report.invalid_record++
      else {
        const safe = record(partial)
        if (safe) { report.outputBytes += safe.length; yield safe }
      }
      report.exportedThroughByte = offset
      partial = Buffer.alloc(0); oversized = false; from = newline + 1
    }
  }
  report.sourceBytesRead = offset
  report.trailingBytesOmitted = offset - report.exportedThroughByte
  report.partial_trailing_record = report.trailingBytesOmitted > 0
}

function safeSnapshots(raw: unknown): unknown[] {
  if (!Array.isArray(raw)) return []
  return raw.slice(0, 8).flatMap(item => {
    if (!object(item) || !member(COMPONENTS, item.component) || !object(item.stats)) return []
    const stats = item.stats
    const numbers = Object.fromEntries(['queuedBytes', 'peakQueuedBytes', 'maxWriteDelayMs', 'droppedCount', 'writtenBytes', 'activeCount'].flatMap(key => {
      const value = stats[key]
      return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? [[key, value]] : []
    }))
    const active = Array.isArray(item.active) ? item.active.slice(0, 32).flatMap(entry => {
      if (!object(entry) || !member(OPERATIONS, entry.operation) || typeof entry.ageMs !== 'number' || !Number.isFinite(entry.ageMs)) return []
      return [{ operation: entry.operation, ageMs: Math.max(0, entry.ageMs), ...(member(STAGES, entry.stage) ? { stage: entry.stage } : {}) }]
    }) : []
    return [{ component: item.component, stats: { ...numbers,
      ...(member(['initializing', 'ready', 'stalled', 'unavailable', 'closed'], stats.state) ? { state: stats.state } : {}),
      ...(member(REASONS, stats.reason) ? { reason: stats.reason } : {}) }, active,
      activeOmitted: Array.isArray(item.active) ? Math.max(0, item.active.length - active.length) : 0 }]
  })
}

/** Runs in the supervised export process; no business database or memory RPC is consulted. */
export async function writeDiagnosticBundle(request: DiagnosticBundleRequest): Promise<void> {
  if (!path.isAbsolute(request.directory) || !path.isAbsolute(request.destination) || request.files.length > 128
    || request.files.some(file => !DIAGNOSTIC_FILE.test(file.file) || !Number.isSafeInteger(file.cutoff) || file.cutoff < 0 || file.cutoff > DIAGNOSTIC_LIMITS.fileBytes)
    || request.files.reduce((sum, file) => sum + file.cutoff, 0) > DIAGNOSTIC_LIMITS.exportSourceBytes) throw new Error('Invalid diagnostic export range')
  const temporary = request.temporary ?? `${request.destination}.${randomUUID()}.partial`
  if (path.dirname(temporary) !== path.dirname(request.destination) || !temporary.startsWith(`${request.destination}.`) || !temporary.endsWith('.partial')) throw new Error('Invalid diagnostic temporary file')
  const zip = new ZipFile()
  let outputBytes = 0
  const limiter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    outputBytes += chunk.length
    callback(outputBytes > DIAGNOSTIC_LIMITS.exportOutputBytes ? new Error('Diagnostic output limit') : null, chunk)
  } })
  const output = createWriteStream(temporary, { flags: 'wx', mode: 0o600, highWaterMark: DIAGNOSTIC_LIMITS.writeBytes })
  const completion = pipeline(zip.outputStream, limiter, output)
  zip.on('error', error => limiter.destroy(error))
  // Store the failure once. Future input waits must not hang after the destination fails.
  const failedOutput = completion.then(() => new Promise<never>(() => {}), error => Promise.reject(error))
  void failedOutput.catch(() => {})
  const reports: DiagnosticFileManifest[] = []
  const identity = newDiagnosticIdentity()
  try {
    for (const [index, file] of request.files.entries()) {
      const component = file.file.slice(0, file.file.indexOf('-'))
      const report: DiagnosticFileManifest = { entry: `${component}-${index + 1}.jsonl`, rawCutoffBytes: file.cutoff,
        sourceBytesRead: 0, exportedThroughByte: 0, trailingBytesOmitted: 0, partial_trailing_record: false, outputBytes: 0, invalid_record: 0 }
      reports.push(report)
      const source = path.join(request.directory, file.file)
      try { if (!(await lstat(source)).isFile()) { report.reason = 'invalid_record'; continue } }
      catch (error) { report.reason = safeDiagnosticReason(error); continue }
      if (!file.cutoff) continue
      const input = createReadStream(source, { start: 0, end: file.cutoff - 1, highWaterMark: DIAGNOSTIC_LIMITS.writeBytes })
      const sanitized = Readable.from(diagnosticRecords(input, report, identity), { highWaterMark: DIAGNOSTIC_LIMITS.writeBytes, objectMode: false })
      zip.addReadStream(sanitized, report.entry, { compress: false })
      await Promise.race([finished(sanitized, { cleanup: true }), failedOutput])
    }
    const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, createdAt: new Date().toISOString(),
      files: reports, snapshots: safeSnapshots(request.snapshots),
      missingSnapshots: COMPONENTS.filter(component => !safeSnapshots(request.snapshots).some(item => object(item) && item.component === component)) }, null, 2))
    zip.addBuffer(manifest, 'manifest.json', { compress: false })
    zip.end()
    await completion
    await rename(temporary, request.destination)
  } catch (error) {
    output.destroy()
    await completion.catch(() => {})
    await unlink(temporary).catch(() => {})
    throw error
  }
}

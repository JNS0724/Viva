import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createMemoryEmbedder } from '../../src/memory/node/memory-embedder.ts'
import type { SmokeApplication } from './application.ts'

/** Failure-only probe against the installed assets and the smoke profile's persisted evidence.
 * Return scores and counts only. The profile belongs to the synthetic scenario. */
export async function installedRecallScores(app: SmokeApplication, fileId: string, query: string) {
  const resources = await app.application.evaluate(() => process.resourcesPath)
  const root = path.join(resources, 'memory-embedding')
  const encoder = createMemoryEmbedder({ modelRoot: path.join(root, 'model'), runtimeRoot: path.join(root, 'runtime') })
  const db = new DatabaseSync(path.join(app.hooks.userData, 'memory', 'memory.db'), { readOnly: true })
  try {
    const rows = db.prepare('SELECT vector FROM memory_file_index_vectors WHERE json_extract(ref, \'$[1]\') = ?').all(fileId)
    const scores = []
    for (const text of [query, 'What causes lunar eclipses?', 'How do I tune a violin?']) {
      const vector = (await encoder.embedBatch([{ kind: 'query', text }]))?.[0]
      if (!vector) return { indexedPassages: rows.length, encoderReady: false }
      scores.push(rows.map(row => {
        if (!(row.vector instanceof Uint8Array) || row.vector.byteLength !== vector.byteLength) return null
        const sample = new Float32Array(Uint8Array.from(row.vector).buffer)
        return Number(sample.reduce((sum, value, index) => sum + value * vector[index]!, 0).toFixed(4))
      }))
    }
    return { indexedPassages: rows.length, encoderReady: true, scores }
  } finally { db.close(); encoder.close() }
}

import fs from 'node:fs'
import path from 'node:path'
import type { SmokeApplication } from './application.ts'
import type { OwnedProfile } from './owned-profile.ts'
import { assertOwnedProfile } from './owned-profile.ts'

declare global { interface Window { vivaSmokeEvents?: unknown[] } }

export async function recordMemoryEvents(session: SmokeApplication): Promise<void> {
  await session.page.evaluate(() => {
    window.vivaSmokeEvents = []
    window.agent.onEvent(value => {
      if (!value || typeof value !== 'object') return
      const event = value as Record<string, unknown>
      if (typeof event.type !== 'string') return
      const info = event.info && typeof event.info === 'object' ? event.info as Record<string, unknown> : null
      if (!['ready', 'turn_end', 'memory_context', 'error'].includes(event.type)) return
      const items = window.vivaSmokeEvents!
      items.push({ type: event.type, at: Date.now(), sessionId: info?.sessionId, injected: event.injected, message: event.type === 'error' ? event.message : undefined })
      if (items.length > 200) items.shift()
    })
  })
}

/** Only the scenario's owned synthetic data is inspected; raw profiles and credentials are never attachments. */
export async function failureDiagnostics(session: SmokeApplication | null, profile: OwnedProfile, directory: string): Promise<string[]> {
  assertOwnedProfile(profile)
  fs.mkdirSync(directory, { recursive: true })
  const errors: string[] = [], files: string[] = []
  if (session) {
    try {
      const snapshot = await session.page.evaluate(async () => {
        const info = await window.agent.getInfo()
        return { mode: info.mode, sessionId: info.sessionId, rows: [...document.querySelectorAll('.trace-row')].map(row => row.textContent), events: window.vivaSmokeEvents ?? [], url: location.href }
      })
      const file = path.join(directory, 'renderer.json')
      fs.writeFileSync(file, JSON.stringify(snapshot, null, 2)); files.push(file)
    } catch (error) { errors.push(`renderer: ${String(error)}`) }
    try {
      const file = path.join(directory, 'failure.png')
      fs.writeFileSync(file, (await session.window.webContents.capturePage()).toPNG()); files.push(file)
    } catch (error) { errors.push(`native screenshot: ${String(error)}`) }
  }
  try {
    const { DatabaseSync } = await import('node:sqlite')
    const file = path.join(profile.userData, 'memory', 'memory.db')
    if (fs.existsSync(file)) {
      const db = new DatabaseSync(file, { readOnly: true })
      try {
        db.exec('PRAGMA busy_timeout = 1000')
        const present = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => String(row.name)))
        const tables = ['memory_sources', 'memory_documents', 'memory_note_turns', 'owner_operations', 'owner_host_effects',
          'owner_file_host_receipts', 'owner_file_native_erasures', 'owner_native_original_completed', 'owner_native_cleanup_receipts']
        const tableCounts = Object.fromEntries(tables.filter(table => present.has(table)).map(table =>
          [table, Number(db.prepare(`SELECT count(*) AS count FROM ${table}`).get()?.count)]))
        const operations = present.has('owner_operations')
          ? db.prepare('SELECT id,state FROM owner_operations ORDER BY rowid DESC LIMIT 20').all() : []
        const hostEffects = present.has('owner_host_effects')
          ? db.prepare('SELECT id,acked FROM owner_host_effects ORDER BY rowid DESC LIMIT 20').all() : []
        const turns = present.has('owner_turns')
          ? db.prepare('SELECT session,turn,seq,state FROM owner_turns ORDER BY rowid DESC LIMIT 50').all() : []
        const contexts = present.has('owner_context_generations')
          ? db.prepare('SELECT session,generation FROM owner_context_generations ORDER BY rowid DESC LIMIT 20').all() : []
        const output = path.join(directory, 'memory-state.json')
        fs.writeFileSync(output, JSON.stringify({ layoutVersion: db.prepare('PRAGMA user_version').get()?.user_version,
          tableCounts, operations, hostEffects, turns, contexts }, null, 2)); files.push(output)
      } finally { db.close() }
    }
  } catch (error) { errors.push(`memory journal: ${String(error)}`) }
  const manifest = path.join(directory, 'diagnostics.json')
  fs.writeFileSync(manifest, JSON.stringify({ retainedSyntheticProfile: profile.root, files, errors }, null, 2)); files.push(manifest)
  return files
}

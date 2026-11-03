import fs from 'node:fs'
import path from 'node:path'
import type { SmokeApplication } from './application.ts'
import type { OwnedProfile } from './owned-profile.ts'
import { assertOwnedProfile } from './owned-profile.ts'

declare global { interface Window { vivaSmokeEvents?: unknown[] } }

export async function recordMemoryEvents(session: SmokeApplication): Promise<void> {
  await session.page.evaluate(() => {
    window.vivaSmokeEvents = []
    window.agent.onEvent(event => {
      if (!['ready', 'turn_end', 'memory_context', 'error'].includes(event.type)) return
      const items = window.vivaSmokeEvents!
      items.push({ type: event.type, at: Date.now(), sessionId: event.info?.sessionId, injected: event.injected, message: event.type === 'error' ? event.message : undefined })
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
    const file = path.join(profile.userData, 'memory.db')
    if (fs.existsSync(file)) {
      const db = new DatabaseSync(file, { readOnly: true })
      try {
        db.exec('PRAGMA busy_timeout = 1000')
        const rows = db.prepare('SELECT id, session_id, turn, created_at, fixed, pushed FROM injections ORDER BY id DESC LIMIT 20').all()
        const output = path.join(directory, 'memory-injections.json')
        fs.writeFileSync(output, JSON.stringify(rows, null, 2)); files.push(output)
      } finally { db.close() }
    }
  } catch (error) { errors.push(`memory journal: ${String(error)}`) }
  const manifest = path.join(directory, 'diagnostics.json')
  fs.writeFileSync(manifest, JSON.stringify({ retainedSyntheticProfile: profile.root, files, errors }, null, 2)); files.push(manifest)
  return files
}

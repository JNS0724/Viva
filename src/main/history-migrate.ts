import fs from 'node:fs'
import path from 'node:path'

const LEGACY_VERSION = 1
const BACKUP_SUFFIX = '-imported'

/** One conversation of the earlier one-JSON-file-per-conversation history. */
export interface LegacyConversation { id: unknown, createdAt: number, updatedAt: number, sessionId: string | null, messages: unknown }

function readLegacyFile(file: string): LegacyConversation {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (raw?.version !== LEGACY_VERSION) throw new Error(`不支持的历史文件版本：${raw?.version}`)
  return {
    id: raw.id,
    createdAt: Number(raw.createdAt) || 0,
    updatedAt: Number(raw.updatedAt) || 0,
    sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : null,
    messages: raw.messages,
  }
}

/**
 * One-time import of the earlier one-JSON-file-per-conversation history into the database.
 * The old folder is renamed to `<dir>-imported` rather than deleted, so nothing is lost if the import misses something.
 * @returns how many conversations were imported
 */
export function migrateLegacyHistory({ dir, db, onError = () => {} }: {
  dir: string, db: { importConversation: (conversation: LegacyConversation) => boolean }, onError?: (err: Error) => void,
}): number {
  if (!fs.existsSync(dir)) return 0
  let imported = 0
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.json'))) {
    try {
      if (db.importConversation(readLegacyFile(path.join(dir, name)))) imported += 1
    } catch (err: any) {
      onError(new Error(`跳过无法导入的历史文件 ${name}：${err.message}`))
    }
  }
  fs.renameSync(dir, `${dir}${BACKUP_SUFFIX}`)
  return imported
}

import { randomBytes, randomUUID, createHmac, createSecretKey } from 'node:crypto'
import { mkdir, open, readFile, rename, unlink, lstat } from 'node:fs/promises'
import path from 'node:path'

export interface DiagnosticIdentity { version: 1; runId: string; salt: string }
const valid = (value: unknown): value is DiagnosticIdentity => value !== null && typeof value === 'object'
  && 'version' in value && value.version === 1 && 'runId' in value && typeof value.runId === 'string' && /^[a-f0-9-]{36}$/.test(value.runId)
  && 'salt' in value && typeof value.salt === 'string' && /^[a-f0-9]{64}$/.test(value.salt)
export const newDiagnosticIdentity = (): DiagnosticIdentity => ({ version: 1, runId: randomUUID(), salt: randomBytes(32).toString('hex') })
const keys = new WeakMap<DiagnosticIdentity, { salt: string; key: ReturnType<typeof createSecretKey> }>()
export function diagnosticAlias(identity: DiagnosticIdentity, value: string | number): string {
  let cached = keys.get(identity)
  if (!cached || cached.salt !== identity.salt) { cached = { salt: identity.salt, key: createSecretKey(Buffer.from(identity.salt, 'hex')) }; keys.set(identity, cached) }
  return createHmac('sha256', cached.key).update(String(value)).digest('hex').slice(0, 32)
}
export async function loadDiagnosticIdentity(directory: string): Promise<DiagnosticIdentity> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  if ((await lstat(directory)).isSymbolicLink()) throw new Error('Diagnostic directory is a symlink')
  const file = path.join(directory, 'identity.json')
  const readIdentity = async () => {
    const info = await lstat(file)
    if (!info.isFile() || info.size > 1024) throw new Error('Invalid diagnostic identity file')
    const data: unknown = JSON.parse(await readFile(file, 'utf8'))
    if (!valid(data)) throw new Error('Invalid diagnostic identity')
    return data
  }
  try { return await readIdentity() }
  catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error
  }
  const identity = newDiagnosticIdentity()
  let handle: Awaited<ReturnType<typeof open>>
  try { handle = await open(file, 'wx', 0o600) }
  catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw error
    // Another process owns this tiny initial write. Never overwrite its salt.
    for (let attempt = 0; attempt < 5; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 25))
      try { return await readIdentity() } catch { /* Still being published. */ }
    }
    throw new Error('Diagnostic identity is not ready')
  }
  try { await handle.writeFile(JSON.stringify(identity)) } finally { await handle.close() }
  return identity
}
export async function replaceDiagnosticIdentity(directory: string): Promise<DiagnosticIdentity> {
  const identity = newDiagnosticIdentity()
  const temporary = path.join(directory, 'identity.tmp')
  const handle = await open(temporary, 'w', 0o600)
  try { await handle.writeFile(JSON.stringify(identity)) } finally { await handle.close() }
  try { await rename(temporary, path.join(directory, 'identity.json')) } catch (error) { await unlink(temporary).catch(() => {}); throw error }
  return identity
}

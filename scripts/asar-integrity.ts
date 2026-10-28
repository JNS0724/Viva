import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { getRawHeader } from '@electron/asar'
import { NtExecutable, NtExecutableResource } from 'resedit'
import type { PlistObject } from 'app-builder-lib/out/util/plist.js'

export interface WindowsIntegrity { file: string, alg: string, value: string }

/** Read the final header from disk, after repacking; do not reuse the original archive's header hash. */
export function finalAsarHash(archive: string): string {
  return createHash('sha256').update(getRawHeader(archive).headerString).digest('hex')
}

export function refreshedWindowsIntegrity(records: readonly WindowsIntegrity[], hash: string): WindowsIntegrity[] {
  let found = false
  const updated = records.map(record => {
    if (path.win32.normalize(record.file).toLowerCase() !== 'resources\\app.asar') return record
    found = true
    return { ...record, alg: 'SHA256', value: hash }
  })
  if (!found) throw new Error('The executable has no integrity record for resources/app.asar')
  return updated
}

/** Refresh the packaging metadata before signing, without changing Electron's fuse configuration. */
export async function refreshAsarIntegrity({ resources, platform, executable }: {
  resources: string, platform: string, executable?: string,
}): Promise<string> {
  const hash = finalAsarHash(path.join(resources, 'app.asar'))
  if (platform === 'win32') {
    if (!executable) throw new Error('Windows executable path is required')
    const binary = NtExecutable.from(fs.readFileSync(executable))
    const resource = NtExecutableResource.from(binary)
    const entries = resource.entries.filter(entry => entry.type === 'INTEGRITY' && entry.id === 'ELECTRONASAR')
    if (entries.length !== 1) throw new Error(`Expected one ELECTRONASAR resource, found ${entries.length}`)
    const records: unknown = JSON.parse(Buffer.from(entries[0].bin).toString('utf8'))
    if (!Array.isArray(records) || records.some(record => !record || typeof record.file !== 'string' || typeof record.alg !== 'string' || typeof record.value !== 'string')) {
      throw new Error('Invalid ELECTRONASAR resource')
    }
    entries[0].bin = Uint8Array.from(Buffer.from(JSON.stringify(refreshedWindowsIntegrity(records, hash)))).buffer
    resource.outputResource(binary)
    fs.writeFileSync(executable, Buffer.from(binary.generate()))
  } else if (platform === 'darwin') {
    const { parsePlistFile, savePlistFile } = await import('app-builder-lib/out/util/plist.js')
    const file = path.join(resources, '..', 'Info.plist')
    const parsed: unknown = await parsePlistFile(file)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid Info.plist')
    const plist = parsed as PlistObject
    const current = plist.ElectronAsarIntegrity
    if (!current || typeof current !== 'object' || Array.isArray(current)) throw new Error('Missing ElectronAsarIntegrity')
    plist.ElectronAsarIntegrity = { ...current, 'Resources/app.asar': { algorithm: 'SHA256', hash } }
    await savePlistFile(file, plist)
  }
  return hash
}

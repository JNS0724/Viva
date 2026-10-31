import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { extractFile, listPackage } from '@electron/asar'

/** Refuse an incompatible artifact before it can start against any profile. */
export function inspectArtifact(executable: string) {
  const binary = fs.realpathSync(executable)
  const resources = process.platform === 'darwin'
    ? path.resolve(path.dirname(binary), '..', 'Resources')
    : path.join(path.dirname(binary), 'resources')
  const archive = path.join(resources, 'app.asar')
  const entries = listPackage(archive, { isPack: false }).map(entry => entry.replaceAll('\\', '/'))
  if (!entries.includes('/out/src/main/automation-driver.js')) throw new Error('Artifact has no external automation driver; build the current candidate first')
  const leaked = entries.filter(entry => /^\/out\/test(?:\/|$)|^\/out\/src\/main\/(?:smoke|live)(?:[-.]|\/)|\/node_modules\/(?:@playwright|playwright(?:-core)?)(?:\/|$)/.test(entry))
  if (leaked.length) throw new Error(`Artifact contains test-only code: ${leaked.slice(0, 5).join(', ')}`)
  const metadata = JSON.parse(extractFile(archive, 'package.json').toString('utf8')) as { version: string }
  const main = extractFile(archive, path.join('out', 'src', 'main', 'main.js'))
  return { executable: binary, archive, version: metadata.version, mainSha256: createHash('sha256').update(main).digest('hex'), testCodeEntries: leaked.length }
}

import { existsSync } from 'node:fs'
import { lstat, open, readdir, realpath, rm } from 'node:fs/promises'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { projectionCacheDomainSpec } from '@deepseek-ai/dsh-session-projection-cache'
import Storage from '@deepseek-ai/dsh-storage'
import * as json from '@deepseek-ai/dsh-storage-json'
import * as domain from '@deepseek-ai/dsh-storage-domain'

async function projectionArtifacts(root: string, sessions: readonly SessionId[]) {
  const unit = path.join(root, projectionCacheDomainSpec.name)
  if (existsSync(unit + '.json')) throw new Error('Legacy native projection cache still needs cleanup')
  const folder = path.join(unit, 'sessions')
  if (!existsSync(folder)) return { folder, artifacts: [] }
  if (await realpath(folder) !== folder) throw new Error('Native projection cache contains a linked directory')
  const filenames = await readdir(folder)
  const artifacts = sessions.flatMap(session => {
    const file = session + '.json'
    return filenames.filter(name => name === file || name === file + '.deleting'
      || name.startsWith(file + '.bak.') && /^\d{12}$/u.test(name.slice(file.length + 5)))
  })
  // The pinned per-record writer uses an unowned UUID temporary in this
  // table. At a cold boundary it cannot be a live or committed checkpoint.
  artifacts.push(...filenames.filter(name => /^\.[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.tmp$/u.test(name)))
  const paths = artifacts.map(name => path.join(folder, name))
  for (const file of paths) {
    const state = await lstat(file)
    if (!state.isFile() || state.nlink !== 1) throw new Error('Native projection cache contains a linked record')
  }
  return { folder, artifacts: paths }
}

/** Cold, scoped removal through the same domain used by the native cache. */
export async function clearNativeProjections(root: string, sessions: readonly SessionId[]) {
  if (!sessions.length || !existsSync(root)) return
  root = await realpath(root)
  await projectionArtifacts(root, sessions)
  const context = new Context()
  const hub = await context.plugin(Storage)
  try {
    const backend = await context.plugin(json, { root })
    try {
      const domains = await context.plugin(domain, { backend: 'json' })
      try {
        const project = await context.storageDomain.open(projectionCacheDomainSpec)
        try {
          const entries = project.table('sessions')
          await entries.deleteMany(sessions)
          if (sessions.some(id => entries.get(id) !== undefined)) throw new Error('Native projection cache was not cleared')
        } finally { await project.close() }
      } finally { await domains.dispose() }
      const { folder, artifacts } = await projectionArtifacts(root, sessions)
      // A killed stock delete can leave the renamed document unreadable by the
      // domain, but its old bytes still exist. Its exact key remains in the name.
      for (const file of artifacts) await rm(file)
      if (artifacts.length && process.platform !== 'win32') {
        const directory = await open(folder, 'r')
        try { await directory.sync() } finally { await directory.close() }
      }
      if ((await projectionArtifacts(root, sessions)).artifacts.length) throw new Error('Native projection cache files were not cleared')
    } finally { await backend.dispose() }
  } finally { await hub.dispose() }
}

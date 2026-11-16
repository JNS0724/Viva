import type { VivaMemoryClient } from './memory-client.ts'
import { t } from '../shared/i18n/translate.ts'
import fs from 'node:fs'
import path from 'node:path'
import { memoryDomainErrorCode } from '../memory/contracts/domain-error.ts'
import type { MemoryFileMutationResult, MemoryFileWriteResult } from '../memory/contracts/file-management.ts'
import { MAX_MEMORY_CHARS } from '../memory/contracts/text-limits.ts'
import { handlerOf, type IpcRegistry } from '../shared/ipc-contract.ts'
import type { IpcResults, MemoryFileSourceView, MemorySummaryView } from '../shared/ipc-results.ts'

/** Where documents picked during the intro are copied, inside the workspace so the agent can read them. */
export const DOCS_DIR_NAME = '我的资料'
const MAX_DOCS = 10
const MAX_DOC_BYTES = 50 * 1024 * 1024
const MAX_COPY_ATTEMPTS = 100

/** `name.ext`, or `name (2).ext` and so on when that is taken. */
function freeName(dir: string, fileName: string) {
  const { name, ext } = path.parse(fileName)
  for (let n = 1; n <= MAX_COPY_ATTEMPTS; n += 1) {
    const candidate = n === 1 ? fileName : `${name} (${n})${ext}`
    if (!fs.existsSync(path.join(dir, candidate))) return candidate
  }
  throw new Error(t("main.memory-ipc.too.many.files.with.the.same.name", { fileName: fileName }))
}

/**
 * Copies the picked documents into `<cwd>/我的资料`, leaving the originals alone.
 * @returns paths relative to the workspace, with forward slashes
 */
export function copyIntoWorkspace(files: readonly string[], cwd: string): Array<{ name: string, path: string }> {
  if (files.length > MAX_DOCS) throw new Error(t("main.memory-ipc.add.up.to.documents.at.a.time", { MAX_DOCS: MAX_DOCS }))
  const dir = path.join(cwd, DOCS_DIR_NAME)
  fs.mkdirSync(dir, { recursive: true })
  return files.map((file) => {
    const stat = fs.statSync(file)
    if (!stat.isFile()) throw new Error(t("main.memory-ipc.not.a.file", { value1: path.basename(file) }))
    if (stat.size > MAX_DOC_BYTES) throw new Error(t("main.memory-ipc.exceeds.mb", { value1: path.basename(file) }))
    const name = freeName(dir, path.basename(file))
    fs.copyFileSync(file, path.join(dir, name), fs.constants.COPYFILE_EXCL)
    return { name, path: `${DOCS_DIR_NAME}/${name}` }
  })
}

function assertMemoryText(value: unknown) {
  if (typeof value !== 'string' || value.length > MAX_MEMORY_CHARS * 2) throw new Error('invalid memory text')
  return value
}

async function fileWrite(write: Promise<MemoryFileMutationResult>): Promise<MemoryFileWriteResult> {
  try { return { status: 'applied', receipt: await write } }
  catch (error) {
    const code = memoryDomainErrorCode.safeParse(error && typeof error === 'object'
      ? ('domainCode' in error ? error.domainCode : 'code' in error ? error.code : undefined) : undefined)
    if (code.success) return { status: 'rejected', code: code.data }
    throw error
  }
}

export function registerRuntimeMemoryIpc(ipcMain: Pick<IpcRegistry, 'handle'>, { client, habits, cwd, chooseDocs, sourceLink, projectScope, fileMode = false }: {
  client: VivaMemoryClient,
  habits: () => { text: string, samples: number },
  cwd: () => string,
  chooseDocs: () => Promise<string[] | null>,
  projectScope?: () => ReturnType<typeof import('./memory-project.ts').memoryProjectScope>,
  sourceLink?: (sourceId: string, segmentId?: string) => string | null,
  fileMode?: boolean,
}) {
  const handle = handlerOf(ipcMain)
  const linkFor = (edge: { sourceId: string, conversationId: string | null }) =>
    edge.conversationId ? sourceLink?.(edge.sourceId, edge.conversationId) ?? null : null
  const withLinks = (item: Awaited<ReturnType<VivaMemoryClient['listMemories']>>['items'][number]) => ({
    ...item, evidence: item.evidence.map(edge => ({
      ...edge, link: linkFor(edge),
    })),
  })
  const list = async (query = '') => {
    const result = await client.listMemories(query)
    return { ...result, items: result.items.map(withLinks) }
  }
  const summary = ({ generated, items }: Awaited<ReturnType<typeof client.profileView>>): MemorySummaryView => ({
    generated,
    items: items.map(({ text, dependency, evidence }) => ({
      id: dependency.id, text, source: evidence ? { text: evidence.text, link: linkFor(evidence) } : null,
    })),
  })
  handle('memory:get', async () => {
    if (fileMode) {
      const profile = await client.profile(), onboarding = await client.onboarding()
      const cleanupPending = await client.cleanupPending(), revision = await client.revision()
      const project = projectScope?.()
      const fileProfile = await client.fileProfile(project)
      return { fileMode: true, profile, items: [], total: 0, onboarding, cleanupPending, revision, habits: habits(),
        fileProfile: project?.id === projectScope?.()?.id ? fileProfile : { ...fileProfile, project: null } }
    }
    const project = projectScope?.()
    return {
      profile: await client.profile(), ...await list(), onboarding: await client.onboarding(),
      cleanupPending: await client.cleanupPending(),
      revision: await client.revision(), habits: habits(),
      summaries: { user: summary(await client.profileView({ kind: 'user' })), project: project ? summary(await client.profileView(project)) : null },
    }
  })
  handle('memory:list', list)
  handle('memory:list-files', client.listFiles)
  handle('memory:read-file', async (identity, restrictionId): Promise<IpcResults['memory:read-file']> => {
    const item = await client.readFile(identity, restrictionId)
    if (!item) return null
    const link = (source: typeof item.sources[number]): MemoryFileSourceView => ({ ...source,
      link: source.namespace === 'canonical' ? sourceLink?.(source.sourceId) ?? null : null,
    })
    const { sources, stoppedSnapshot, ...file } = item
    return { ...file, sources: sources.map(link), ...(stoppedSnapshot
      ? { stoppedSnapshot: { ...stoppedSnapshot, sources: stoppedSnapshot.sources.map(link) } } : {}) }
  })
  handle('memory:set-file-enabled', client.setFileEnabled)
  handle('memory:undo-file', client.undoFile)
  handle('memory:create-file', request => fileWrite(client.createFile(request)))
  handle('memory:edit-file', request => fileWrite(client.editFile(request)))
  handle('memory:forget-file', async request => {
    const result = await fileWrite(client.forgetFile(request))
    if (result.status === 'rejected') return result
    const operation = await client.fileOperation(request.operationId)
    // A mutation receipt proves withdrawal, not completion of every stored copy.
    return { ...result, cleanup: operation?.state === 'completed' && operation.cleanup === 'complete' ? 'complete' : 'pending' }
  })
  handle('memory:set-profile', (changes, operation) => client.setProfile(changes, operation))
  handle('memory:add', (text, kind = 'fact', operation) => client.addMemory(assertMemoryText(text), kind, operation))
  handle('memory:update', (id, text, revision, operation) => client.editMemory(id, assertMemoryText(text), revision, operation))
  handle('memory:delete', (id, revision, operation) => client.deleteMemory(id, revision, operation))
  handle('memory:forget', (id, revision, operation) => client.stopMemory(id, revision, operation))
  handle('memory:restore', (id, revision, operation) => client.restoreMemory(id, revision, operation))
  handle('memory:resolve-conflict-pair', (first, second, resolution, operation, conflictId, interval) => client.resolveConflictPair(first, second, resolution.kind === 'replace' ? { ...resolution, text: assertMemoryText(resolution.text) } : resolution,
      operation, conflictId, interval))
  handle('memory:list-invalid', async () => (await client.listInvalid()).map(withLinks))
  handle('memory:list-changes', async (): Promise<IpcResults['memory:list-changes']> => (await client.listChanges()).map(change => ({
    ...change, evidence: change.evidence.map(edge => ({ text: edge.text, link: linkFor(edge) })),
  })))
  handle('memory:undo-change', (id, revision, operation, expectedRevisions): Promise<IpcResults['memory:undo-change']> =>
    client.undoChange(id, revision, operation, expectedRevisions))
  handle('memory:rebuild-indexes', () => client.rebuildIndexes())
  handle('memory:onboarding', client.setOnboarding)
  handle('memory:add-docs', async () => {
    const files = await chooseDocs()
    return files?.length ? copyIntoWorkspace(files, cwd()) : []
  })
}

import { t } from '../shared/i18n/translate.ts'
import fs from 'node:fs'
import path from 'node:path'
import { MAX_MEMORY_CHARS, type openMemoryDb } from '../../plugins/memory/lib/store.ts'
import { handlerOf, type IpcRegistry } from './ipc-contract.ts'

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

/**
 * IPC for the "关于你" page and the intro: the profile, the memories and the habits read from history.
 */
export function registerMemoryIpc(ipcMain: Pick<IpcRegistry, 'handle'>, { db, habits, cwd, chooseDocs }: {
  db: ReturnType<typeof openMemoryDb>,
  habits: () => { text: string, samples: number },
  cwd: () => string,
  chooseDocs: () => Promise<string[] | null>,
}) {
  const handle = handlerOf(ipcMain)

  handle('memory:get', () => ({
    profile: db.getProfile(),
    ...db.listMemories(),
    onboarding: db.onboarding(),
    synthesis: db.latestSynthesis(),
    habits: habits(),
  }))
  handle('memory:list', (query = '') => db.listMemories({ query }))
  handle('memory:set-profile', (changes) => db.setProfile(changes, 'user'))
  handle('memory:add', (text, kind = 'fact') => db.addMemory({ text: assertMemoryText(text), kind, source: 'user' }).memory)
  handle('memory:update', (id, text) => db.updateMemory(id, assertMemoryText(text)))
  handle('memory:delete', (id) => db.deleteMemory(id))
  handle('memory:restore', (memory) => db.restoreMemory(memory))
  handle('memory:list-invalid', () => db.listInvalid())
  handle('memory:revive', (id) => db.reviveMemory(id))
  handle('memory:onboarding', (status) => {
    db.setOnboarding(status)
    return db.onboarding()
  })
  handle('memory:add-docs', async () => {
    const files = await chooseDocs()
    return files?.length ? copyIntoWorkspace(files, cwd()) : []
  })
}

import fs from 'node:fs'
import path from 'node:path'
import { MAX_MEMORY_CHARS } from '../../plugins/memory/lib/store.js'

/** Where documents picked during the intro are copied, inside the workspace so the agent can read them. */
export const DOCS_DIR_NAME = '我的资料'
const MAX_DOCS = 10
const MAX_DOC_BYTES = 50 * 1024 * 1024
const MAX_COPY_ATTEMPTS = 100

/** `name.ext`, or `name (2).ext` and so on when that is taken. */
function freeName(dir, fileName) {
  const { name, ext } = path.parse(fileName)
  for (let n = 1; n <= MAX_COPY_ATTEMPTS; n += 1) {
    const candidate = n === 1 ? fileName : `${name} (${n})${ext}`
    if (!fs.existsSync(path.join(dir, candidate))) return candidate
  }
  throw new Error(`「${fileName}」的同名文件太多了`)
}

/**
 * Copies the picked documents into `<cwd>/我的资料`, leaving the originals alone.
 * @returns {Array<{ name: string, path: string }>} paths relative to the workspace, with forward slashes
 */
export function copyIntoWorkspace(files, cwd) {
  if (files.length > MAX_DOCS) throw new Error(`一次最多添加 ${MAX_DOCS} 份文档`)
  const dir = path.join(cwd, DOCS_DIR_NAME)
  fs.mkdirSync(dir, { recursive: true })
  return files.map((file) => {
    const stat = fs.statSync(file)
    if (!stat.isFile()) throw new Error(`不是文件：${path.basename(file)}`)
    if (stat.size > MAX_DOC_BYTES) throw new Error(`「${path.basename(file)}」超过 50 MB`)
    const name = freeName(dir, path.basename(file))
    fs.copyFileSync(file, path.join(dir, name), fs.constants.COPYFILE_EXCL)
    return { name, path: `${DOCS_DIR_NAME}/${name}` }
  })
}

function assertMemoryText(value) {
  if (typeof value !== 'string' || value.length > MAX_MEMORY_CHARS * 2) throw new Error('invalid memory text')
  return value
}

/**
 * IPC for the "关于你" page and the intro: the profile, the memories and the habits read from history.
 * @param {{ handle: (channel: string, listener: Function) => void }} ipcMain
 * @param {{
 *   db: ReturnType<import('../../plugins/memory/lib/store.js').openMemoryDb>,
 *   habits: () => { text: string, samples: number },
 *   cwd: () => string,
 *   chooseDocs: () => Promise<string[] | null>,
 * }} deps
 */
export function registerMemoryIpc(ipcMain, { db, habits, cwd, chooseDocs }) {
  const handle = (channel, listener) => ipcMain.handle(channel, (_event, ...args) => listener(...args))

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

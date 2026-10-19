import { parseProviderInput, PROTOCOLS, providerView } from './model-providers.js'

const MAX_ID_CHARS = 100

function assertId(value) {
  if (typeof value !== 'string' || !value || value.length > MAX_ID_CHARS) throw new Error('invalid provider id')
  return value
}

/**
 * IPC for the 模型 section of settings: the model providers the user adds besides DeepSeek.
 * dsh reads them from its profile at launch, so a change restarts it; the conversation carries on.
 * @param {{ handle: (channel: string, listener: Function) => void }} ipcMain
 * @param {{
 *   store: ReturnType<import('./model-providers.js').createModelStore>,
 *   restart: () => Promise<object | null>,
 * }} deps
 */
export function registerModelsIpc(ipcMain, { store, restart }) {
  const handle = (channel, listener) => ipcMain.handle(channel, (_event, ...args) => listener(...args))
  const view = () => ({ providers: store.list().map(providerView), protocols: PROTOCOLS })

  handle('models:get', view)

  handle('models:add', async (input) => {
    const added = store.add(parseProviderInput(input, store.list().map((provider) => provider.name)))
    return { ...view(), added: added.name, info: await restart() }
  })

  handle('models:remove', async (id) => {
    store.remove(assertId(id))
    return { ...view(), info: await restart() }
  })
}

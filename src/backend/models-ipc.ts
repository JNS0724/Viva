import { handlerOf, type IpcRegistry } from '../shared/ipc-contract.ts'
import { t } from '../shared/i18n/translate.ts'
import { DiscoveryError, discoverModels, type DiscoveredModel, type DiscoveryRequest } from './model-discovery.ts'
import { MODEL_DEFAULTS, parseEndpoint, parseProviderInput, PROTOCOLS, providerView, type createModelStore } from './model-providers.ts'

const MAX_ID_CHARS = 100

function assertId(value: unknown) {
  if (typeof value !== 'string' || !value || value.length > MAX_ID_CHARS) throw new Error('invalid provider id')
  return value
}

/**
 * Whether a provider's saved key may go to `baseURL`: only where it went before (scheme, host and port). Neither
 * a changed address nor 获取可用模型 sends it elsewhere; the window never holds the key, so it can only ask the
 * main process to use it, and that ask must not carry it to another host.
 */
function keyMayGo(saved: { baseURL: string, key: string }, baseURL: string): boolean {
  return !saved.key || new URL(saved.baseURL).origin === new URL(baseURL).origin
}

/** What the form says when the endpoint does not list its models. */
function discoveryMessage(err: DiscoveryError): string {
  switch (err.reason) {
    case 'refused': return t('main.models.discovery.refused', { status: err.status ?? '' })
    case 'status': return t('main.models.discovery.status', { status: err.status ?? '' })
    case 'redirected': return t('main.models.discovery.redirected')
    case 'timeout': return t('main.models.discovery.timeout')
    case 'unreachable': return t('main.models.discovery.unreachable')
    case 'too-large': return t('main.models.discovery.too.large')
    default: return t('main.models.discovery.not.a.listing')
  }
}

/**
 * IPC for the 模型 section of settings: the model providers the user adds besides DeepSeek.
 * dsh reads them from its profile at launch, so a change restarts it; the conversation carries on.
 */
export function registerModelsIpc(ipcMain: Pick<IpcRegistry, 'handle'>, { store, restart, discover = discoverModels }: {
  store: ReturnType<typeof createModelStore>, restart: () => Promise<object | null>,
  discover?: (request: DiscoveryRequest) => Promise<DiscoveredModel[]>,
}) {
  const handle = handlerOf(ipcMain)
  const view = () => ({ providers: store.list().map(providerView), protocols: PROTOCOLS, defaults: MODEL_DEFAULTS })
  const otherNames = (id: string | null) => store.list().filter((provider) => provider.id !== id).map((provider) => provider.name)

  handle('models:get', view)

  handle('models:add', async (input) => {
    const added = store.add(parseProviderInput(input, otherNames(null)))
    return { ...view(), added: added.name, info: await restart() }
  })

  handle('models:update', async (id, input) => {
    const config = parseProviderInput(input, otherNames(id))
    const saved = store.list().find((provider) => provider.id === assertId(id))
    if (saved && !config.key && !keyMayGo(saved, config.baseURL)) throw new Error(t('main.models.key.needed.for.new.host'))
    const updated = store.update(id, config)
    return { ...view(), updated: updated.name, info: await restart() }
  })

  handle('models:remove', async (id) => {
    store.remove(assertId(id))
    return { ...view(), info: await restart() }
  })

  /** 获取可用模型: the form's endpoint, with the typed key, or (editing, left blank) the provider's own. */
  handle('models:discover', async (input, providerId) => {
    const endpoint = parseEndpoint(input)
    const saved = providerId ? store.list().find((provider) => provider.id === assertId(providerId)) : undefined
    const own = saved && keyMayGo(saved, endpoint.baseURL) ? saved.key : ''
    try {
      return { models: await discover({ ...endpoint, key: endpoint.key || own }) }
    } catch (err) {
      if (err instanceof DiscoveryError) throw new Error(discoveryMessage(err))
      throw err
    }
  })
}

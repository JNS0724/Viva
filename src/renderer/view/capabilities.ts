import { onLocaleChange } from '../../shared/i18n/locale.ts'
import { t } from '../../shared/i18n/translate.ts'
import { CAPABILITY_TABS, capabilityCounts, capabilityFeedback, openTab, type CapabilityTab } from '../capabilities-state.ts'
import type { ExtensionStatus } from '../capability-types.ts'
import { h, keepingInput } from './dom.ts'
import { serverMain, serversSide } from './capability-mcp.ts'
import { pluginMain, pluginsSide } from './capability-plugins.ts'
import { skillMain, skillsSide } from './capability-skills.ts'
import { sourceMain, sourcesSide } from './capability-sources.ts'

/**
 * 能力 (capabilities-state.ts): a page of the hub beside 关于你 and 设置. Skills, MCP, plugins and 消息源 as tabs; each lists on
 * the left and shows the one picked on the right, as 后台 and 动态 do.
 */
let TAB_NAMES: Readonly<Record<CapabilityTab, string>> = tabNames()
function tabNames() {
  return { skills: t('capabilities.skills'), mcp: 'MCP', plugins: t('capabilities.plugins'), sources: t('capabilities.sources') }
}
onLocaleChange(() => { TAB_NAMES = tabNames() })

const SIDES: Record<CapabilityTab, (state: State, handlers: Handlers) => Node[]> = { skills: skillsSide, mcp: serversSide, plugins: pluginsSide, sources: (state, handlers) => sourcesSide(state, handlers) }
const MAINS: Record<CapabilityTab, (state: State, handlers: Handlers) => HTMLElement> = { skills: skillMain, mcp: serverMain, plugins: pluginMain, sources: (state, handlers) => sourceMain(state, handlers) }

function tabs(state: State, handlers: Handlers) {
  const counts = capabilityCounts(state)
  return h('div', { class: 'seg cap-tabs', role: 'group', 'aria-label': t('capabilities.title') },
    CAPABILITY_TABS.map((tab) => h('button', {
      type: 'button', 'data-tab': tab, 'aria-pressed': String(openTab(state) === tab), onClick: () => handlers.capabilityTab(tab),
    }, TAB_NAMES[tab], h('span', { class: 'cap-tab-count', text: String(counts[tab]) }))))
}

/** Said only when Viva's memory plugin was left out: without it there is no memory. */
function memoryLine(status: ExtensionStatus, connected: boolean) {
  if (!connected || status.memory) return null
  const problem = (status.plugins ?? []).find((plugin) => plugin.contract === 'memory')?.problem
  return h('p', { class: 'ext-memory', 'data-on': 'false' },
    problem ? t('extensions.the.memory.plugin.version.is.incompatible.automatic', { problem }) : t('extensions.the.memory.plugin.was.not.loaded.automatic'))
}

/** What the last change came to, under the tabs: there whatever is listed or picked. */
function feedback(state: State) {
  const { error, notice } = capabilityFeedback(state)
  return [
    error ? h('p', { class: 'form-error cap-feedback', role: 'alert', text: error }) : null,
    notice ? h('p', { class: 'form-notice cap-feedback', role: 'status', text: notice }) : null,
  ]
}

export function renderCapabilitiesPage(container: HTMLElement, state: State, handlers: Handlers, { connected }: { connected: boolean }) {
  if (!state.capabilities.open) {
    container.replaceChildren()
    return
  }
  const tab = openTab(state)
  const loaded = tab === 'plugins' ? state.plugins.loaded : tab === 'sources' ? state.sources.loaded : state.extensions.loaded
  const side = h('nav', { class: 'tp-side cap-side', 'aria-label': t('capabilities.title') },
    h('div', { class: 'tp-side-head' }, h('h1', { class: 'feed-title', text: t('capabilities.title') })),
    tabs(state, handlers),
    memoryLine(state.extensions.status as ExtensionStatus, connected && state.extensions.loaded),
    ...feedback(state),
    ...(loaded ? SIDES[tab](state, handlers) : [h('p', { class: 'help cap-empty', text: t('extensions.loading') })]))
  const main = loaded ? MAINS[tab](state, handlers) : h('div', { class: 'tp-main tp-empty' })
  keepingInput(container, () => container.replaceChildren(side, main))
}

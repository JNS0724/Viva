import { t } from '../../shared/i18n/translate.ts'
import { pluginStanding, shownPlugin, type PluginStanding } from '../capabilities-state.ts'
import { problemText } from '../plugins-state.ts'
import type { PluginFit, PluginView } from '../capability-types.ts'
import { h } from './dom.ts'
import { installCard, installForm } from './plugins.ts'

/**
 * 能力 · 插件 (view/capabilities.ts): the dsh plugins the user installed and the one picked: what it is, whether it runs
 * here (plugin-fit.ts), switched on or off, removed; and adding one (ADD_PLUGIN), by the spec, what it names, then 安装.
 */
export const ADD_PLUGIN = '+add'

function standingText(standing: PluginStanding) {
  if (standing.kind === 'error') return { tone: 'off', text: problemText(standing.code, standing.detail) }
  if (standing.kind === 'stalled') return { tone: 'off', text: t('plugins.not.running', { rows: standing.rows.join('、') }) }
  if (standing.kind === 'off') return { tone: 'idle', text: t('plugins.off') }
  if (standing.kind === 'unsupported') return { tone: 'off', text: t('plugins.unsupported') }
  return { tone: 'ok', text: t('plugins.on') }
}

/** Whether it works in Viva, in words; null when that cannot be told. */
function fitText(fit: PluginFit): string | null {
  if (fit.kind === 'declared') return t('plugins.fit.declared')
  if (fit.kind === 'fits') return t('plugins.fit.fits')
  if (fit.kind === 'web-part') return t('plugins.fit.web.part')
  if (fit.kind === 'needs-web') return t('plugins.fit.needs.web', { needs: fit.needs.join('、') })
  return null
}

const pluginsOf = (state: State) => state.plugins.plugins as readonly PluginView[]

export function pluginsSide(state: State, handlers: Handlers): Node[] {
  if (!state.plugins.connected) return [h('p', { class: 'help cap-empty', text: t('plugins.not.connected') })]
  const adding = state.capabilities.selected === ADD_PLUGIN
  const shown = adding ? null : shownPlugin(state)
  return [
    ...pluginsOf(state).map((plugin) => {
      const standing = standingText(pluginStanding(plugin))
      return h('button', {
        class: 'tp-row cap-row', type: 'button', 'data-name': plugin.name, 'aria-current': plugin.name === shown?.name ? 'page' : null,
        onClick: () => handlers.selectCapability(plugin.name),
      }, h('span', { class: 'tp-name', text: plugin.name }), h('span', { class: 'ext-status', 'data-tone': standing.tone, text: standing.text }))
    }),
    pluginsOf(state).length ? null : h('p', { class: 'help cap-empty', text: t('plugins.none') }),
    h('button', {
      class: 'tp-row cap-row cap-add', type: 'button', 'aria-current': adding ? 'page' : null, onClick: () => handlers.selectCapability(ADD_PLUGIN),
    }, h('span', { class: 'tp-name', text: t('capabilities.add.plugin') })),
  ].filter((node) => node !== null)
}

function pluginFacts(plugin: PluginView, state: State, handlers: Handlers) {
  const busy = Boolean(state.plugins.busy)
  const fit = fitText(plugin.fit)
  return [
    plugin.description ? h('p', { class: 'cap-text', text: plugin.description }) : null,
    h('dl', { class: 'cap-facts' },
      plugin.version ? [h('dt', { text: t('capabilities.version') }), h('dd', { text: plugin.version })] : null,
      fit ? [h('dt', { text: t('capabilities.in.viva') }), h('dd', { text: fit })] : null,
      plugin.overrides.length ? [h('dt', { text: t('capabilities.changes') }), h('dd', { text: t('plugins.overrides', { rows: plugin.overrides.join('、') }) })] : null),
    h('div', { class: 'settings-actions' },
      h('button', { class: 'btn btn-outline btn-small', type: 'button', disabled: busy, text: plugin.enabled ? t('plugins.disable') : t('plugins.enable'), onClick: () => handlers.setPluginEnabled(plugin.name, !plugin.enabled) }),
      plugin.removable ? h('button', { class: 'btn btn-outline btn-small', type: 'button', disabled: busy, text: t('plugins.remove'), onClick: () => handlers.removePlugin(plugin.name) }) : null),
  ]
}

export function pluginMain(state: State, handlers: Handlers): HTMLElement {
  if (!state.plugins.connected) return h('div', { class: 'tp-main tp-empty' }, h('p', { class: 'empty', text: t('plugins.not.connected') }))
  const plugin = state.capabilities.selected === ADD_PLUGIN ? null : shownPlugin(state)
  if (!plugin) {
    return h('div', { class: 'tp-main' },
      h('header', { class: 'tp-head' }, h('h2', { class: 'tp-title', text: t('capabilities.add.plugin') })),
      h('div', { class: 'tp-scroll' },
        h('p', { class: 'help', text: t('plugins.help') }),
        installForm(state.plugins, handlers),
        installCard(state.plugins, handlers)))
  }
  const standing = standingText(pluginStanding(plugin))
  return h('div', { class: 'tp-main' },
    h('header', { class: 'tp-head' },
      h('h2', { class: 'tp-title', text: plugin.name }),
      h('span', { class: 'ext-status cap-standing', 'data-tone': standing.tone, title: standing.text, text: standing.text })),
    h('div', { class: 'tp-scroll' }, ...pluginFacts(plugin, state, handlers)))
}

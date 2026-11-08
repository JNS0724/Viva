import { t } from '../../shared/i18n/translate.ts'
import { localeRevision } from '../../shared/i18n/locale.ts'
import { isBusy } from '../state.ts'
import { h, label } from './dom.ts'
import { icon } from './icons.ts'
import { reconcileChildren } from './reconcile.ts'

/** A choice dsh offers (a model, a reasoning effort): what it is called, and the value to set. */
type Choice = { value: string, name: string, group?: string }

const effortName = (info: AgentInfo) => info.efforts?.find((e: Choice) => e.value === info.effort)?.name ?? ''
const buttons = new WeakMap<HTMLButtonElement, { name: HTMLSpanElement, effort: HTMLSpanElement, chevron: SVGSVGElement }>()
const menus = new WeakMap<HTMLElement, { key: string, handlers: Handlers }>()

function modelOption(model: Choice, info: AgentInfo, handlers: Handlers) {
  const selected = model.value === info.modelValue
  return h('button', {
    type: 'button',
    class: 'model-option',
    'aria-pressed': String(selected),
    onClick: () => handlers.setConfig('model', model.value),
  },
  h('span', { class: 'model-option-name', text: model.name }),
  model.group ? h('span', { class: 'model-option-group', text: model.group }) : null,
  selected ? h('span', { class: 'model-check', text: '●' }) : null)
}

function effortRow(info: AgentInfo, handlers: Handlers) {
  return h('div', { class: 'effort-row', role: 'group', 'aria-label': t("model-picker.reasoning.effort") }, (info.efforts ?? []).map((effort: Choice) => h('button', {
    type: 'button',
    class: 'effort',
    'aria-pressed': String(effort.value === info.effort),
    text: effort.name,
    onClick: () => handlers.setConfig('reasoning_effort', effort.value),
  })))
}

function menu(info: AgentInfo, handlers: Handlers) {
  return h('div', { class: 'model-menu', role: 'dialog', 'aria-label': t("model-picker.choose.model") },
    label(t("models.model")),
    (info.models ?? []).map((model: Choice) => modelOption(model, info, handlers)),
    info.efforts?.length ? [label(t("model-picker.reasoning.effort")), effortRow(info, handlers)] : null,
    h('p', { class: 'model-hint', text: t("model-picker.takes.effect.from.the.next.turn") }))
}

/** Model + reasoning-effort switcher in the composer. Disabled mid-turn because dsh pins the route per turn. */
export function renderModelPicker(dom: { modelArea: HTMLElement, modelBtn: HTMLButtonElement, modelMenu: HTMLElement }, state: State, handlers: Handlers) {
  const { info } = state
  // No agent yet (setup state): there is nothing to choose from, so the switcher is not shown at all.
  dom.modelArea.hidden = info.mode === 'setup'
  const hasChoices = (info.models?.length ?? 0) > 0
  const disabled = !hasChoices || isBusy(state) || state.switching || state.newTopicPending
  const effort = effortName(info)
  dom.modelBtn.disabled = disabled
  dom.modelBtn.title = isBusy(state) ? t("model-picker.you.can.switch.models.after.this.turn") : t("model-picker.switch.model.and.reasoning.effort")
  dom.modelBtn.setAttribute('aria-expanded', String(state.picker && !disabled))
  let parts = buttons.get(dom.modelBtn)
  if (!parts) {
    parts = { name: h('span', { class: 'model-btn-name' }), effort: h('span', { class: 'model-btn-effort' }), chevron: icon('chevron', 14) }
    buttons.set(dom.modelBtn, parts)
  }
  if (parts.name.textContent !== (info.model || '—')) parts.name.textContent = info.model || '—'
  if (parts.effort.textContent !== effort.toUpperCase()) parts.effort.textContent = effort.toUpperCase()
  reconcileChildren(dom.modelBtn, effort ? [parts.name, parts.effort, parts.chevron] : [parts.name, parts.chevron])
  if (!state.picker || disabled) {
    if (dom.modelMenu.firstChild) dom.modelMenu.replaceChildren()
    menus.delete(dom.modelMenu)
    return
  }
  // Only the choices and their selection own this menu. Background streams do not.
  const key = JSON.stringify([localeRevision(), info.models, info.modelValue, info.efforts, info.effort])
  const previous = menus.get(dom.modelMenu)
  if (previous?.key === key && previous.handlers === handlers) return
  dom.modelMenu.replaceChildren(menu(info, handlers))
  menus.set(dom.modelMenu, { key, handlers })
}

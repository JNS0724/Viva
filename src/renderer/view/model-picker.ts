import { isBusy } from '../state.ts'
import { h, label } from './dom.ts'
import { icon } from './icons.ts'

/** A choice dsh offers (a model, a reasoning effort): what it is called, and the value to set. */
type Choice = { value: string, name: string, group?: string }

const effortName = (info: AgentInfo) => info.efforts?.find((e: Choice) => e.value === info.effort)?.name ?? ''

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
  return h('div', { class: 'effort-row', role: 'group', 'aria-label': '推理强度' }, info.efforts.map((effort: Choice) => h('button', {
    type: 'button',
    class: 'effort',
    'aria-pressed': String(effort.value === info.effort),
    text: effort.name,
    onClick: () => handlers.setConfig('reasoning_effort', effort.value),
  })))
}

function menu(info: AgentInfo, handlers: Handlers) {
  return h('div', { class: 'model-menu', role: 'dialog', 'aria-label': '选择模型' },
    label('MODEL'),
    info.models.map((model: Choice) => modelOption(model, info, handlers)),
    info.efforts?.length ? [label('REASONING EFFORT'), effortRow(info, handlers)] : null,
    h('p', { class: 'model-hint', text: '从下一轮对话开始生效' }))
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
  dom.modelBtn.title = isBusy(state) ? '本轮结束后可以切换模型' : '切换模型与推理强度'
  dom.modelBtn.setAttribute('aria-expanded', String(state.picker && !disabled))
  // replaceChildren would print a null as "null", unlike h()
  dom.modelBtn.replaceChildren(...[
    h('span', { class: 'model-btn-name', text: info.model || '—' }),
    effort ? h('span', { class: 'model-btn-effort', text: effort.toUpperCase() }) : null,
    icon('chevron', 14),
  ].filter((part): part is HTMLSpanElement | SVGSVGElement => Boolean(part)))
  dom.modelMenu.replaceChildren(...(state.picker && !disabled ? [menu(info, handlers)] : []))
}

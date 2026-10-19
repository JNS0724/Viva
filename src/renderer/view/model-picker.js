import { isBusy } from '../state.js'
import { h, label } from './dom.js'
import { icon } from './icons.js'

const effortName = (info) => info.efforts?.find((e) => e.value === info.effort)?.name ?? ''

function modelOption(model, info, handlers) {
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

function effortRow(info, handlers) {
  return h('div', { class: 'effort-row', role: 'group', 'aria-label': '推理强度' }, info.efforts.map((effort) => h('button', {
    type: 'button',
    class: 'effort',
    'aria-pressed': String(effort.value === info.effort),
    text: effort.name,
    onClick: () => handlers.setConfig('reasoning_effort', effort.value),
  })))
}

function menu(info, handlers) {
  return h('div', { class: 'model-menu', role: 'dialog', 'aria-label': '选择模型' },
    label('MODEL'),
    info.models.map((model) => modelOption(model, info, handlers)),
    info.efforts?.length ? [label('REASONING EFFORT'), effortRow(info, handlers)] : null,
    h('p', { class: 'model-hint', text: '从下一轮对话开始生效' }))
}

/** Model + reasoning-effort switcher in the composer. Disabled mid-turn because dsh pins the route per turn. */
export function renderModelPicker(dom, state, handlers) {
  const { info } = state
  // No agent yet (setup state): there is nothing to choose from, so the switcher is not shown at all.
  dom.modelArea.hidden = info.mode === 'setup'
  const hasChoices = (info.models?.length ?? 0) > 0
  const disabled = !hasChoices || isBusy(state)
  const effort = effortName(info)
  dom.modelBtn.disabled = disabled
  dom.modelBtn.title = isBusy(state) ? '本轮结束后可以切换模型' : '切换模型与推理强度'
  dom.modelBtn.setAttribute('aria-expanded', String(state.picker && !disabled))
  // replaceChildren would print a null as "null", unlike h()
  dom.modelBtn.replaceChildren(...[
    h('span', { class: 'model-btn-name', text: info.model || '—' }),
    effort ? h('span', { class: 'model-btn-effort', text: effort.toUpperCase() }) : null,
    icon('chevron', 14),
  ].filter(Boolean))
  dom.modelMenu.replaceChildren(...(state.picker && !disabled ? [menu(info, handlers)] : []))
}

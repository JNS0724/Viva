/**
 * Tiny element factory. Strings always become text nodes, so agent output can never inject markup.
 * @template {keyof HTMLElementTagNameMap} K
 * @param {K} tag
 * @param {Record<string, unknown> | null} [props]
 * @param {...unknown} children
 * @returns {HTMLElementTagNameMap[K]} the element of that tag (an input for 'input', and so on)
 */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag)
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue
    if (key === 'class') el.className = String(value)
    else if (key === 'text') el.textContent = String(value)
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), /** @type {EventListener} */ (value))
    else el.setAttribute(key, value === true ? '' : String(value))
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue
    el.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
  return el
}

/** Small uppercase monospace label, e.g. "01 / TIME". */
export const label = (text) => h('span', { class: 'label', text })

const FIELDS = 'input[name], textarea[name], select[name]'
/** @typedef {HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement} Field */
/** @param {ParentNode} root @returns {Field[]} */
const fieldsIn = (root) => /** @type {Field[]} */ ([...root.querySelectorAll(FIELDS)])
const isCheckbox = (el) => el instanceof HTMLInputElement && el.type === 'checkbox'

/**
 * Rebuilds `container` without losing what the user typed: named fields keep their value, checked
 * state, focus and caret. A field whose `data-version` changed starts fresh (e.g. cleared after saving).
 * @param {HTMLElement} container
 * @param {() => void} rebuild
 */
export function keepingInput(container, rebuild) {
  const saved = new Map(fieldsIn(container).map((el) => [el.name, { value: el.value, checked: isCheckbox(el) && /** @type {HTMLInputElement} */ (el).checked, version: el.dataset.version }]))
  const active = container.contains(document.activeElement) ? /** @type {Field | null} */ (document.activeElement) : null
  const typed = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ? active : null
  const focus = active?.name ? { name: active.name, start: typed?.selectionStart ?? null, end: typed?.selectionEnd ?? null } : null
  rebuild()
  for (const el of fieldsIn(container)) {
    const prior = saved.get(el.name)
    if (!prior || prior.version !== el.dataset.version) continue
    if (isCheckbox(el)) /** @type {HTMLInputElement} */ (el).checked = prior.checked
    else if (el.value !== prior.value) {
      el.value = prior.value
      // A select drives what else the form shows; let it update as if picked again.
      if (el.tagName === 'SELECT') el.dispatchEvent(new Event('change'))
    }
  }
  const target = focus && /** @type {Field | null} */ (container.querySelector(`[name="${CSS.escape(focus.name)}"]`))
  if (!target) return
  target.focus()
  if (typeof focus.start === 'number' && 'setSelectionRange' in target) target.setSelectionRange(focus.start, focus.end)
}

/**
 * Tiny element factory. Strings always become text nodes, so agent output can never inject markup.
 * @returns the element of that tag (an input for 'input', and so on)
 */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> | null = {}, ...children: unknown[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue
    if (key === 'class') el.className = String(value)
    else if (key === 'text') el.textContent = String(value)
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value as EventListener)
    else el.setAttribute(key, value === true ? '' : String(value))
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue
    el.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
  return el
}

/** Small uppercase monospace label, e.g. "01 / TIME". */
export const label = (text: string) => h('span', { class: 'label', text })

const FIELDS = 'input[name], textarea[name], select[name]'
type Field = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
const fieldsIn = (root: ParentNode): Field[] => [...root.querySelectorAll<Field>(FIELDS)]
const isCheckbox = (el: Element): el is HTMLInputElement => typeof HTMLInputElement !== 'undefined' && el instanceof HTMLInputElement && el.type === 'checkbox'

type ComposingState = { active: boolean, deferred: (() => void) | null }
const composingIn = new WeakMap<HTMLElement, ComposingState>()

function compositionOf(container: HTMLElement): ComposingState | null {
  if (typeof container.addEventListener !== 'function') return null
  let state = composingIn.get(container)
  if (state) return state
  state = { active: false, deferred: null }
  container.addEventListener('compositionstart', () => { state!.active = true })
  container.addEventListener('compositionend', () => {
    state!.active = false
    if (!state!.deferred) return
    const schedule = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn: () => void) => setTimeout(fn, 0)
    schedule(() => {
      if (state!.active || !state!.deferred || container.isConnected === false) return
      const run = state!.deferred
      state!.deferred = null
      run()
    })
  })
  composingIn.set(container, state)
  return state
}

/** Calls `onChange` as the user types, deferring mid-pinyin IME composition updates until confirmed. */
export function composedInput(onChange: (value: string) => void) {
  return {
    onInput: (event: Event) => {
      if ((event as InputEvent).isComposing) return
      onChange((event.currentTarget as HTMLInputElement).value)
    },
    onCompositionEnd: (event: Event) => onChange((event.currentTarget as HTMLInputElement).value),
  }
}

/**
 * Rebuilds `container` without losing what the user typed: named fields keep their value, checked
 * state, focus and caret. A field whose `data-version` changed starts fresh (e.g. cleared after saving).
 * Active IME composition inside `container` defers the rebuild until composition completes.
 */
export function keepingInput(container: HTMLElement, rebuild: () => void): void {
  const composition = compositionOf(container)
  if (composition?.active && container.contains(document.activeElement)) {
    composition.deferred = () => keepingInput(container, rebuild)
    return
  }
  if (composition) composition.deferred = null
  const saved = new Map(fieldsIn(container).map((el) => [el.name, { value: el.value, checked: isCheckbox(el) && el.checked, version: el.dataset.version }]))
  const active = container.contains(document.activeElement) ? document.activeElement as Field | null : null
  const typed = active && 'selectionStart' in active ? active as HTMLInputElement | HTMLTextAreaElement : null
  const focus = active?.name ? { name: active.name, start: typed?.selectionStart ?? null, end: typed?.selectionEnd ?? null } : null
  rebuild()
  for (const el of fieldsIn(container)) {
    const prior = saved.get(el.name)
    if (!prior || prior.version !== el.dataset.version) continue
    if (isCheckbox(el)) el.checked = prior.checked
    else if (el.value !== prior.value) {
      el.value = prior.value
      // A select drives what else the form shows; let it update as if picked again.
      if (el.tagName === 'SELECT') el.dispatchEvent(new Event('change'))
    }
  }
  const target = focus && container.querySelector<Field>(`[name="${CSS.escape(focus.name)}"]`)
  if (!target) return
  target.focus()
  if (typeof focus.start === 'number' && 'setSelectionRange' in target) target.setSelectionRange(focus.start, focus.end)
}

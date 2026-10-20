import { formatElapsed } from '../selectors.js'
import { catFor } from './cat.js'
import { h } from './dom.js'

/**
 * The Viva island as an element, for its two hosts: the capsule in the window's title bar ('bar') and the
 * island on the desktop ('desk', desk.js). It is made once and updated in place, so a change of state
 * reads as one shape growing or shrinking around the cat, not as a new element. The cat stays at the top
 * left in every form. What it shows comes from islandView (island-view.js).
 *
 * Actions go to `act`: toggle, jump (to the card in the thread), cancel, trace, open (the window),
 * permission { requestId, optionId }, answer { questionId, id, label }.
 */

const NS = 'http://www.w3.org/2000/svg'
/** The island's border, on both sides: its content is this much narrower than the shape. */
const BORDER = 3
const SIZES = {
  bar: { head: 36, panel: 360, maxHead: 360, cat: 30 },
  desk: { head: 48, panel: 392, maxHead: 420, cat: 40 },
}

/** Forms whose panel opens by itself on the desktop: they need the user. */
const NEEDS_USER = new Set(['waiting', 'asking'])

function ring() {
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('class', 'isl-ring')
  svg.setAttribute('viewBox', '0 0 18 18')
  svg.setAttribute('aria-hidden', 'true')
  const track = document.createElementNS(NS, 'circle')
  for (const [key, value] of Object.entries({ cx: 9, cy: 9, r: 7 })) track.setAttribute(key, String(value))
  const arc = document.createElementNS(NS, 'path')
  arc.setAttribute('d', 'M9 2a7 7 0 0 1 7 7')
  svg.append(track, arc)
  return svg
}

const elapsedSince = (view, now) => formatElapsed(now - (view.startedAt ?? now))

/** What sits beside the cat: the label and, depending on the host, a few words more. */
function headParts(view, host, now) {
  const label = (text) => h('b', { class: 'isl-label', text })
  const time = (text) => h('span', { class: 'isl-time', text })
  const more = (text) => (text ? h('span', { class: 'isl-more', text }) : null)
  const desk = host === 'desk'
  switch (view.form) {
    case 'mini': return []
    case 'working': return desk
      ? [label(view.label), more(view.action), time(elapsedSince(view, now)), ring()]
      : [label(view.label), time(elapsedSince(view, now)), view.steps ? more(`· ${view.steps} 步`) : null, ring()]
    case 'waiting':
    case 'asking': return desk ? [label(view.label)] : [label('需要你处理'), more('↓')]
    case 'done': return [label(view.label), time(formatElapsed(view.elapsedMs ?? 0)), desk ? more(view.detail) : null]
    default: return [label(view.label), more(view.detail)]
  }
}

function stepList(view) {
  return h('ol', { class: 'isl-steps' }, view.recent.map((step) => h('li', { 'data-tone': step.tone, text: step.title })))
}

const button = (text, cls, onClick) => h('button', { type: 'button', class: `isl-btn ${cls}`, text, onClick })

function permissionPanel(view, act) {
  const { permission } = view
  return [
    h('div', { class: 'isl-title', text: permission.title }),
    h('div', { class: 'isl-actions' },
      permission.options.map((option) => button(option.name, option.allow ? 'isl-btn-hot' : 'isl-btn-line',
        () => act({ kind: 'permission', requestId: permission.requestId, optionId: option.optionId }))),
      button('查看详情', 'isl-btn-ghost isl-push', () => act({ kind: 'open' }))),
  ]
}

function questionPanel(view, act) {
  const { question } = view
  return [
    h('div', { class: 'isl-title', text: question.text }),
    h('div', { class: 'isl-actions' },
      question.options.map((label) => button(label, 'isl-btn-line', () => act({ kind: 'answer', questionId: question.questionId, id: question.id, label }))),
      button(question.options.length ? '其他…' : '打开窗口回答', 'isl-btn-ghost', () => act({ kind: 'open' }))),
  ]
}

/** Whether the form has something to unfold: the desktop's questions, else the steps so far. */
function hasPanel(view, host) {
  if (host === 'desk' && NEEDS_USER.has(view.form)) return true
  if (NEEDS_USER.has(view.form) || view.form === 'mini' || !view.recent.length) return false
  return host === 'bar' || view.form === 'working'
}

/** The unfolded part: what the agent waits on (desktop), or the steps so far with stop while it works. */
function panelParts(view, host, act) {
  if (host === 'desk' && view.form === 'waiting') return permissionPanel(view, act)
  if (host === 'desk' && view.form === 'asking') return questionPanel(view, act)
  const working = view.form === 'working'
  return [
    stepList(view),
    h('div', { class: 'isl-actions' },
      working ? button('停止', 'isl-btn-line', () => act({ kind: 'cancel' })) : null,
      host === 'desk' ? button('打开窗口', 'isl-btn-ghost', () => act({ kind: 'open' })) : button('查看完整过程 →', 'isl-btn-ghost', () => act({ kind: 'trace' }))),
  ]
}

/** In the title bar a click unfolds the steps, or, when the agent waits on the user, goes to the card. */
function headAction(view, host, unfolds) {
  if (host === 'desk') return { kind: 'open' }
  if (NEEDS_USER.has(view.form)) return { kind: 'jump' }
  return unfolds ? { kind: 'toggle' } : null
}

/**
 * @param {'bar' | 'desk'} host
 * @param {(action: object) => void} act
 */
export function createIsland(host, act) {
  const size = SIZES[host]
  const cats = new Map()
  const cat = h('span', { class: 'isl-cat', 'aria-hidden': 'true' })
  const head = h('button', { type: 'button', class: 'isl-head' })
  const panel = h('div', { class: 'isl-panel' })
  const el = h('div', { class: 'isl', 'data-host': host }, h('div', { class: 'isl-clip' }, head, panel), cat)
  let last = null
  let signature = ''
  let hovered = false
  let onHead = null

  head.addEventListener('click', () => onHead && act(onHead))

  /** Sizes are set in pixels, so the shape can animate between them; never wider than its place allows. */
  function layout(open) {
    if (!el.isConnected) return
    const room = (parseFloat(getComputedStyle(el.parentElement).maxWidth) || Infinity) - BORDER
    head.style.width = 'max-content'
    const headWidth = Math.min(Math.ceil(head.getBoundingClientRect().width), size.maxHead, room)
    const inner = open ? Math.min(size.panel - BORDER, room) : headWidth
    head.style.width = `${inner}px`
    panel.style.width = `${inner}px`
    el.style.width = `${inner + BORDER}px`
    el.style.height = `${open ? size.head + panel.scrollHeight : size.head}px`
  }

  /**
   * @param {object} view from islandView, with form 'mini' for the desktop's resting cat
   * @param {{ now?: number, pinned?: boolean }} [options] pinned: opened by a click in the title bar
   */
  function update(view, { now = Date.now(), pinned = false } = {}) {
    last = { view, now, pinned }
    const unfolds = hasPanel(view, host)
    const open = unfolds && (pinned || hovered || (host === 'desk' && NEEDS_USER.has(view.form)))
    const next = JSON.stringify([view, open])
    if (next === signature) {
      const time = head.querySelector('.isl-time')
      if (time && view.form === 'working') time.textContent = elapsedSince(view, now)
      return
    }
    signature = next
    Object.assign(el.dataset, { form: view.form, tone: view.tone, open: String(open) })
    cat.replaceChildren(catFor(cats, 'island', view.form === 'mini' ? 'idle' : view.mood, { size: size.cat, frame: true }))
    head.replaceChildren(...headParts(view, host, now).filter(Boolean))
    onHead = headAction(view, host, unfolds)
    head.disabled = !onHead
    head.setAttribute('aria-label', [view.label, view.action ?? view.detail].filter(Boolean).join('：'))
    if (onHead?.kind === 'toggle') head.setAttribute('aria-expanded', String(open))
    else head.removeAttribute('aria-expanded')
    panel.replaceChildren(...(open ? [h('div', { class: 'isl-in' }, panelParts(view, host, act))] : []))
    panel.inert = !open
    layout(open)
  }

  // Hovering (or tabbing into) the island unfolds its steps; leaving folds them unless a click pinned them.
  const setHover = (on) => {
    if (hovered === on) return
    hovered = on
    if (last) update(last.view, last)
  }
  el.addEventListener('mouseenter', () => setHover(true))
  el.addEventListener('mouseleave', () => setHover(false))
  el.addEventListener('focusin', () => setHover(true))
  el.addEventListener('focusout', (event) => { if (!el.contains(event.relatedTarget)) setHover(false) })

  return { el, update }
}

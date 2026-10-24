import { formatElapsed } from '../selectors.ts'
import { catFor } from './cat.ts'
import { h } from './dom.ts'
import { INPUT_FORMS } from './island-input.ts'
import type { createIslandInput } from './island-input.ts'
import { backgroundSection, tailCell, taskTag } from './island-tasks.ts'

/**
 * The Viva island as an element, for its two hosts: the capsule in the window's title bar ('bar') and the
 * island on the desktop ('desk', desk.js). It is made once and updated in place, so a change of state
 * reads as one shape growing or shrinking around the cat, not as a new element. The cat stays at the top
 * left in every form. What it shows comes from islandView (island-view.js).
 *
 * Actions go to `act`: toggle, jump (to the card in the thread), cancel, trace, open (the window),
 * input (the desktop's), coached, permission { requestId, optionId }, answer { questionId, id, label },
 * tasks (the count at the tail: the 后台 page).
 *
 * In the title bar a click unfolds the steps. On the desktop the island is glanced at from another app, so
 * it never unfolds the steps: it opens by itself only for what needs the user (and, once, to say what it
 * can do), and a pointer resting on it shows what it can do instead: stop, open the window, the grip to
 * drag it by, and, when idle, that it takes questions and files.
 *
 * On the desktop the island may also be an input (island-input.js), given as `input`: its forms are as wide
 * as the input, always open, and their field lies over the head.
 */

const NS = 'http://www.w3.org/2000/svg'
/** The island's border, on both sides: its content is this much narrower than the shape. */
const BORDER = 3
type Host = 'bar' | 'desk'
const SIZES: Record<Host, { head: number, panel: number, maxHead: number, cat: number, input?: number }> = {
  bar: { head: 48, panel: 360, maxHead: 360, cat: 36 },
  desk: { head: 48, panel: 392, maxHead: 420, cat: 36, input: 560 },
}

/** Forms that need the user; on the desktop their panel opens by itself, as does the first-time note. */
const NEEDS_USER = new Set(['waiting', 'asking'])
const OPENS_ITSELF = new Set([...NEEDS_USER, 'coach'])
/**
 * On the desktop, a pointer resting this long on the island shows what it can do; one passing by does not.
 * Once it leaves, the island waits a little before it shrinks, so a pointer slipping off the edge does not jolt it.
 */
const HOVER_MS = 200
const LEAVE_MS = 400

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

const elapsedSince = (view: IslandShown, now: number) => formatElapsed(now - (view.startedAt ?? now))

/**
 * What sits beside the cat: the label and, depending on the host, a few words more.
 * @param context tools: the pointer rests on it
 */
function headParts(view: IslandShown, { host, now, tools, shortcut }: { host: Host, now: number, tools: boolean, shortcut: string }) {
  const label = (text: string) => h('b', { class: 'isl-label', text })
  const time = (text: string) => h('span', { class: 'isl-time', text })
  const more = (text: string | null | undefined) => (text ? h('span', { class: 'isl-more', text }) : null)
  const desk = host === 'desk'
  switch (view.form) {
    case 'mini': return tools
      ? [h('span', { class: 'isl-ask', text: '问 Viva，或把文件拖过来' }), h('span', { class: 'isl-kbd', text: shortcut })]
      : []
    case 'coach': return [label(view.label)]
    case 'working': return desk
      ? [label(view.label), more(view.action), time(elapsedSince(view, now)), ring()]
      : [label(view.label), time(elapsedSince(view, now)), view.steps ? more(`· ${view.steps} 步`) : null, ring()]
    case 'waiting':
    case 'asking': return desk ? [label(view.label), taskTag(view)] : [label('需要你处理'), taskTag(view), more('↓')]
    // A task in the background that has just ended says only that (island-view.js).
    case 'done': return view.task ? [label(view.label)] : [label(view.label), time(formatElapsed(view.elapsedMs ?? 0)), desk ? more(view.detail) : null]
    default: return [label(view.label), more(view.detail)]
  }
}

function stepList(view: IslandShown) {
  return h('ol', { class: 'isl-steps' }, view.recent.map((step) => h('li', { 'data-tone': step.tone, text: step.title })))
}

const button = (text: string, cls: string, onClick: () => void) => h('button', { type: 'button', class: `isl-btn ${cls}`, text, onClick })
/** Buttons by role (prompt-card.js), as on the thread's card: the main one filled, the others outlined, the least a link. */
const ROLE: Readonly<Record<string, string>> & { text: string, secondary: string } = Object.freeze({ primary: 'isl-btn-primary', secondary: 'isl-btn-secondary', text: 'isl-btn-text' })

/** What it is to allow: its title and, for a command, the command itself on one line. */
function permissionPanel(view: IslandShown, act: IslandAct) {
  const { permission } = view
  return [
    taskTag(view),
    h('div', { class: 'isl-title', text: permission.title }),
    permission.command ? h('pre', { class: 'isl-detail', text: permission.command, title: permission.command }) : null,
    h('div', { class: 'isl-actions' },
      permission.options.map((option: { optionId: string, name: string, role: string }) => button(option.name, ROLE[option.role],
        () => act({ kind: 'permission', requestId: permission.requestId, optionId: option.optionId }))),
      button('查看详情', `${ROLE.text} isl-push`, () => act({ kind: 'open' }))),
  ]
}

function questionPanel(view: IslandShown, act: IslandAct) {
  const { question } = view
  return [
    question.header ? h('span', { class: 'isl-tag', text: question.header }) : null,
    h('div', { class: 'isl-title', text: question.text }),
    h('div', { class: 'isl-actions' },
      question.options.map((label: string) => button(label, ROLE.secondary, () => act({ kind: 'answer', questionId: question.questionId, id: question.id, label }))),
      button(question.options.length ? '其他…' : '打开窗口回答', question.options.length ? ROLE.text : ROLE.secondary, () => act({ kind: 'open' })),
      question.skippable ? button('跳过', `${ROLE.text} isl-push`, () => act({ kind: 'skip', questionId: question.questionId })) : null),
  ]
}

/** The first time the cat rests on the desktop: what it can do, which nothing on it shows otherwise. */
function coachPanel(act: IslandAct, shortcut: string) {
  const tips = [`点我，或在任何应用里按 ${shortcut}，随时提问`, '把文件拖到我身上，交给我处理', '按住可以拖到别处；右键看更多']
  return [
    h('ul', { class: 'isl-tips' }, tips.map((text) => h('li', { text }))),
    h('div', { class: 'isl-actions' }, button('知道了', 'isl-btn-blue', () => act({ kind: 'coached' }))),
  ]
}

/**
 * Whether the form has something to unfold: on the desktop only what opens by itself, in the title bar the
 * steps and the tasks in the background.
 */
function hasPanel(view: IslandShown, host: Host, pinned = false) {
  const tasks = Boolean(view.background?.items.length)
  // On the desktop the 后台 list opens only when asked for (a click on the count at the tail, desk.js).
  if (host === 'desk') return OPENS_ITSELF.has(view.form) || (pinned && tasks)
  return !NEEDS_USER.has(view.form) && (view.recent.length > 0 || tasks)
}

/** How long a turn runs before the opened island offers it the background (D). */
export const OFFER_MS = 30_000

/**
 * Whether the opened island offers the turn the background: one with words to move by that has run a while,
 * or that the agent said would take long.
 */
export function offersBackground(view: IslandShown, now: number) {
  if (view.form !== 'working' || !view.movable) return false
  return Boolean(view.offered) || now - (view.startedAt ?? now) >= OFFER_MS
}

/** 这件要一会儿: not asked, only there for whoever opens the island while waiting (D). */
const offerRow = (act: IslandAct) => h('div', { class: 'isl-offer' },
  h('span', { text: '这件要一会儿。放到后台，你先忙别的？' }),
  button('放到后台', 'isl-btn-blue isl-push', () => act({ kind: 'background' })))

/** The unfolded part: on the desktop what the agent waits on, in the title bar the steps so far, then the tasks. */
function panelParts(view: IslandShown, host: Host, act: IslandAct, shortcut: string, offer: boolean, now: number): View[] {
  if (host === 'desk' && view.form === 'waiting') return permissionPanel(view, act)
  if (host === 'desk' && view.form === 'asking') return questionPanel(view, act)
  if (host === 'desk' && view.form === 'coach') return coachPanel(act, shortcut)
  if (host === 'desk') return [backgroundSection(view, act, now)]
  const working = view.form === 'working'
  const steps = view.recent.length ? [
    stepList(view),
    h('div', { class: 'isl-actions' },
      working ? button('停止', 'isl-btn-line', () => act({ kind: 'cancel' })) : null,
      button('查看完整过程 →', ROLE.text, () => act({ kind: 'trace' }))),
  ] : []
  return [...steps, offer ? offerRow(act) : null, backgroundSection(view, act, now)]
}

const tool = (label: string, cls: string, onClick: () => void, text = '') => h('button', { type: 'button', class: `isl-tool ${cls}`, title: label, 'aria-label': label, text, onClick })

/**
 * On the desktop, with the pointer resting on the island: stop while it works, the window when a click
 * would not open it, and the grip it is dragged by.
 */
function deskTools(view: IslandShown, act: IslandAct) {
  const grip = h('span', { class: 'isl-grip', title: '按住拖动', 'aria-hidden': 'true' })
  if (view.form === 'working') return [tool('停止', 'isl-tool-stop', () => act({ kind: 'cancel' })), grip]
  if (view.form === 'mini') return [tool('打开窗口', 'isl-tool-open', () => act({ kind: 'open' }), '↗'), grip]
  return [grip]
}

/**
 * A click on the head. On the desktop: the resting cat takes a question, anything else opens the window.
 * In the title bar it unfolds the steps, or, when the agent waits on the user, goes to the card.
 */
function headAction(view: IslandShown, host: Host, unfolds: boolean): { kind: string } | null {
  if (host === 'desk') return view.form === 'mini' || view.form === 'coach' ? { kind: 'input' } : { kind: 'open' }
  if (NEEDS_USER.has(view.form)) return { kind: 'jump' }
  return unfolds ? { kind: 'toggle' } : null
}

/**
 * What an update has to redraw. The row (head and tools) follows the pointer as well; the panel does not, so
 * the tools appearing under a resting pointer leave its buttons alone: one held down meanwhile is the one
 * let go, and the click still happens.
 * @param offer offersBackground
 */
export function islandSignatures(view: IslandShown, open: boolean, showTools: boolean, offer = false) {
  const panel = JSON.stringify([view, open, offer])
  return { panel, row: JSON.stringify([panel, showTools]) }
}

/** options: the desktop's input, and the ask shortcut as the user presses it */
export function createIsland(host: Host, act: IslandAct, { input = null as ReturnType<typeof createIslandInput> | null, shortcut = '' } = {}) {
  const size = SIZES[host]
  const cats = new Map<string, { key: string, el: HTMLElement }>()
  const cat = h('span', { class: 'isl-cat', 'aria-hidden': 'true' })
  const head = h('button', { type: 'button', class: 'isl-head' })
  const tools = h('span', { class: 'isl-tools' })
  const row = h('div', { class: 'isl-row' }, head, tools)
  const panel = h('div', { class: 'isl-panel' })
  const clip = h('div', { class: 'isl-clip' }, row, panel)
  const el = h('div', { class: 'isl', 'data-host': host }, clip, cat)
  let last: { view: IslandShown, now: number, pinned: boolean } | null = null
  let signature = { panel: '', row: '' }
  let hovered = false
  let onHead: { kind: string } | null = null

  // The count at the tail is the way to the 后台 page; the rest of the head does what its form says.
  head.addEventListener('click', (event) => {
    if ((event.target as Element).closest?.('.isl-bg')) act({ kind: 'tasks' })
    else if (onHead) act(onHead)
  })

  /**
   * Sizes are set in pixels, so the shape can animate between them; never wider than its place allows.
   * @param wide the input's forms, as wide as the input
   */
  function layout(open: boolean, wide: boolean) {
    if (!el.isConnected) return
    const room = (parseFloat(el.parentElement ? getComputedStyle(el.parentElement).maxWidth : '') || Infinity) - BORDER
    head.style.width = 'max-content'
    const toolsWidth = Math.ceil(tools.getBoundingClientRect().width)
    // With nothing beside the cat the island is a circle around it, not a capsule with an empty end.
    const bare = !head.childElementCount && !toolsWidth
    const contentWidth = bare ? size.head - BORDER : Math.ceil(head.getBoundingClientRect().width) + toolsWidth
    const headWidth = Math.min(contentWidth, size.maxHead, room)
    const opened = open ? Math.min(size.panel - BORDER, room) : headWidth
    const inner = wide ? Math.min((size.input ?? size.panel) - BORDER, room) : opened
    head.style.width = `${Math.max(inner - toolsWidth, 0)}px`
    panel.style.width = `${inner}px`
    el.style.width = `${inner + BORDER}px`
    el.style.height = `${open ? size.head + panel.scrollHeight : size.head}px`
  }

  /**
   * @param view from islandView, with form 'mini' for the desktop's resting cat
   * @param options pinned: opened by a click in the title bar
   */
  function update(view: IslandShown, { now = Date.now(), pinned = false } = {}) {
    last = { view, now, pinned }
    const wide = Boolean(input) && INPUT_FORMS.has(view.form)
    const unfolds = wide || hasPanel(view, host, pinned)
    const open = unfolds && (wide || pinned || host === 'desk')
    const showTools = host === 'desk' && hovered && !wide && !view.dragging && view.form !== 'coach'
    const offer = host === 'bar' && open && offersBackground(view, now)
    const next = islandSignatures(view, open, showTools, offer)
    if (next.row === signature.row) {
      const time = head.querySelector('.isl-time')
      if (time && view.form === 'working') time.textContent = elapsedSince(view, now)
      return
    }
    const panelChanged = next.panel !== signature.panel
    signature = next
    // The panel fades in as it opens; redrawn while open (a step every second as the agent works) it stays put.
    const wasOpen = el.dataset.open === 'true'
    Object.assign(el.dataset, { form: view.form, tone: view.tone, open: String(open) })
    cat.replaceChildren(catFor(cats, 'island', view.form === 'mini' ? 'idle' : view.mood, { size: size.cat, frame: true }))
    const tail = tailCell(view)
    const parts = view.form === 'input' ? [] : [...headParts(view, { host, now, tools: showTools, shortcut }), tail]
    head.replaceChildren(...parts.filter((part): part is NonNullable<typeof part> => Boolean(part)))
    tools.replaceChildren(...(showTools ? deskTools(view, act) : []))
    if (input && view.form === 'input') {
      input.sync(view)
      if (input.entry.parentNode !== clip) clip.append(input.entry)
    } else input?.entry.remove()
    onHead = wide ? null : headAction(view, host, unfolds)
    head.disabled = !onHead && !tail
    head.setAttribute('aria-label', [view.label, view.action ?? view.detail].filter(Boolean).join('：'))
    if (onHead?.kind === 'toggle') head.setAttribute('aria-expanded', String(open))
    else head.removeAttribute('aria-expanded')
    if (panelChanged) {
      const parts = wide && input ? input.panel(view) : panelParts(view, host, act, shortcut, offer, now)
      panel.replaceChildren(...(open ? [h('div', { class: wasOpen ? 'isl-in isl-in-still' : 'isl-in' }, parts)] : []))
      panel.inert = !open
    }
    layout(open, wide)
  }

  /**
   * On the desktop, whether the pointer is over the island, as the main process sees it (desk.js): a pointer
   * resting on it shows its tools, one passing by on its way elsewhere does not.
   */
  let hoverTimer: ReturnType<typeof setTimeout> | undefined
  function setPointer(on: boolean) {
    clearTimeout(hoverTimer)
    hoverTimer = setTimeout(() => {
      if (hovered === on) return
      hovered = on
      if (last) update(last.view, last)
    }, on ? HOVER_MS : LEAVE_MS)
  }

  return { el, update, setPointer }
}

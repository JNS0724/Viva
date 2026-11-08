import { t } from '../../shared/i18n/translate.ts'
import { localeRevision } from '../../shared/i18n/locale.ts'
import { formatElapsed } from '../selectors.ts'
import { maidFor, maidMood } from './maid.ts'
import type { MaidSlots } from './maid.ts'
import { h, keepingInput } from './dom.ts'
import { queueLayout } from './reconcile.ts'
import type { createIslandInput } from './island-input.ts'
import { backgroundSection, tailCell, taskTag } from './island-tasks.ts'

/** Shared task/request content with separate title-bar and desktop hosts. The desktop keeps a 72px
 * portrait in one 80px target, with explicit expansion of its neighbouring surface. Views wire actions;
 * the controller owns IPC, pointer intention, draft lifetime and native placement. */

const NS = 'http://www.w3.org/2000/svg'
/** The island's border, on both sides: its content is this much narrower than the shape. */
const BORDER = 3
type Host = 'bar' | 'desk'
/**
 * In the title bar the island carries no picture of her, only a dot in the tone of the moment: the conversation's
 * latest answer shows her already. On the desktop she is the island, large enough to read her expression.
 */
const SIZES = {
  bar: { head: 36, panel: 360, maxHead: 360 },
}

export type DeskLayout = 'rest' | 'capsule' | 'input' | 'content'

/** Desktop layout follows content, independently of the title bar's compact representation. */
export function deskLayoutFor(view: IslandShown, open: boolean, _tools = false): DeskLayout {
  if (view.dragging) return 'rest'
  if (open) return view.form === 'input' ? 'input' : 'content'
  return view.form === 'mini' && !view.background?.count && !view.background?.done ? 'rest' : 'capsule'
}

function deskHead(view: IslandShown, now: number) {
  const attachments = view.form === 'input'
  let label = view.label
  let detail = view.action ?? view.task ?? view.question?.header ?? view.detail
  if (attachments || view.form === 'drop') {
    label = t('desk.give.to.viva')
    if (attachments) detail = t('island-input.attachments', { count: view.files.length + (view.images?.length ?? 0) })
  } else if (view.form === 'mini') {
    label = t('desk.ask.viva')
    detail = t('island-dom.ask.viva.or.drop.files.here')
  }
  const elapsed = view.form === 'working' ? elapsedSince(view, now)
    : view.form === 'done' && !view.task ? formatElapsed(view.elapsedMs ?? 0) : null
  return h('span', { class: 'isl-copy' },
    h('span', { class: 'isl-status' }, h('span', { class: 'isl-dot', 'aria-hidden': 'true' }),
      h('b', { class: 'isl-label', text: label }), elapsed ? h('span', { class: 'isl-time', text: elapsed }) : null),
    detail ? h('span', { class: 'isl-more', text: detail, title: detail }) : null)
}

const desktopPanel = (body: View[], actions: View[]) => [
  h('div', { class: 'isl-body', tabindex: '0', 'aria-label': t('island-dom.content') }, ...body),
  h('div', { class: 'isl-footer' }, ...actions),
]

/** Requests jump to their card in the title bar; on the desktop they wait for explicit expansion. */
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
      ? [h('span', { class: 'isl-ask', text: t("island-dom.ask.viva.or.drop.files.here") }), h('span', { class: 'isl-kbd', text: shortcut })]
      : []
    case 'coach': return [label(view.label)]
    case 'working': return desk
      ? [label(view.label), more(view.action), time(elapsedSince(view, now)), ring()]
      : [label(view.label), time(elapsedSince(view, now)), view.steps ? more(t("island-dom.steps", { steps: view.steps })) : null, ring()]
    case 'waiting':
    case 'asking': return desk ? [label(view.label), taskTag(view)] : [label(t("island-dom.needs.your.attention")), taskTag(view), more('↓')]
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
  return desktopPanel([
    taskTag(view),
    h('div', { class: 'isl-title', text: permission.title }),
    permission.command ? h('pre', { class: 'isl-detail', text: permission.command, title: permission.command }) : null,
  ], [
    permission.options.map((option: { optionId: string, name: string, role: string }) => button(option.name, ROLE[option.role],
      () => act({ kind: 'permission', requestId: permission.requestId, optionId: option.optionId }))),
    button(t("island-dom.view.details"), `${ROLE.text} isl-push`, () => act({ kind: 'open' })),
  ])
}

function questionPanel(view: IslandShown, act: IslandAct) {
  const { question } = view
  return desktopPanel([
    question.header ? h('span', { class: 'isl-tag', text: question.header }) : null,
    h('div', { class: 'isl-title', text: question.text }),
    question.options.length ? h('p', { class: 'isl-choice-hint', text: t('desk.interaction.immediate.answer') }) : null,
    h('div', { class: 'isl-choices' },
      question.options.map((label: string) => h('button', { type: 'button', class: 'isl-btn isl-btn-secondary', onClick: () => act({ kind: 'answer', questionId: question.questionId, id: question.id, label }) },
        h('span', { text: label }), h('span', { class: 'isl-choice-action', text: t('desk.interaction.answer') })))),
  ], [
    button(t('desk.interaction.other.answer'), question.options.length ? ROLE.text : ROLE.secondary, () => act({ kind: 'open' })),
    question.skippable ? button(t("island-dom.skip"), `${ROLE.text} isl-push`, () => act({ kind: 'skip', questionId: question.questionId })) : null,
  ])
}

/** The first time the cat rests on the desktop: what it can do, which nothing on it shows otherwise. */
function coachPanel(act: IslandAct, shortcut: string) {
  const tips = [t("island-dom.click.me.or.press.in.any.app", { shortcut: shortcut }), t("island-dom.drop.files.onto.me.for.help"), t("island-dom.drag.to.move.right.click.for.more")]
  return desktopPanel([
    h('ul', { class: 'isl-tips' }, tips.map((text) => h('li', { text }))),
  ], [button(t("island-dom.got.it"), 'isl-btn-blue', () => act({ kind: 'coached' }))])
}

/**
 * Whether the form has something to unfold: on the desktop only what opens by itself, in the title bar the
 * steps and the tasks in the background.
 */
function hasPanel(view: IslandShown) {
  const tasks = Boolean(view.background?.items.length)
  return !NEEDS_USER.has(view.form) && (view.recent.length > 0 || tasks)
}

/** The unfolded part: on the desktop what the agent waits on, in the title bar the steps so far, then the tasks. */
function panelParts(view: IslandShown, host: Host, act: IslandAct, shortcut: string, now: number): View[] {
  if (host === 'desk' && view.form === 'waiting') return permissionPanel(view, act)
  if (host === 'desk' && view.form === 'asking') return questionPanel(view, act)
  if (host === 'desk' && view.form === 'coach') return coachPanel(act, shortcut)
  if (host === 'desk' && ['resolved', 'done', 'error', 'pending'].includes(view.form)) return desktopPanel([
    h('div', { class: 'isl-title', text: view.detail || view.label }),
  ], [button(t('desk.interaction.open'), 'isl-btn-blue', () => act({ kind: 'open' })),
    button(t('desk.interaction.continue'), ROLE.text, () => act({ kind: 'input' }))])
  if (host === 'desk') return desktopPanel([backgroundSection(view, act, now)], [
    button(t('island-dom.view.full.activity'), `${ROLE.text} isl-push`, () => act({ kind: 'tasks' })),
  ])
  const working = view.form === 'working'
  const steps = view.recent.length ? [
    stepList(view),
    h('div', { class: 'isl-actions' },
      working ? button(t("island-dom.stop"), 'isl-btn-line', () => act({ kind: 'cancel' })) : null,
      button(t("island-dom.view.full.activity"), ROLE.text, () => act({ kind: 'trace' }))),
  ] : []
  return [...steps, backgroundSection(view, act, now)]
}

/**
 * A click on the head. On the desktop: the resting cat takes a question, anything else opens the window.
 * In the title bar it unfolds the steps, or, when the agent waits on the user, goes to the card.
 */
function headAction(view: IslandShown, unfolds: boolean): { kind: string } | null {
  if (NEEDS_USER.has(view.form)) return { kind: 'jump' }
  return unfolds ? { kind: 'toggle' } : null
}

/**
 * What an update has to redraw. The row (head and tools) follows the pointer as well; the panel does not, so
 * the tools appearing under a resting pointer leave its buttons alone: one held down meanwhile is the one
 * let go, and the click still happens.
 */
export function islandSignatures(view: IslandShown, open: boolean, showTools: boolean) {
  const panel = JSON.stringify([view, open])
  return { panel, row: JSON.stringify([panel, showTools]) }
}

/** options: the desktop's input, and the ask shortcut as the user presses it */
function createBarIsland(act: IslandAct) {
  const size = SIZES.bar
  const face = h('span', { class: 'isl-face', 'aria-hidden': 'true' }, h('span', { class: 'isl-dot' }))
  const head = h('button', { type: 'button', class: 'isl-head' })
  const tools = h('span', { class: 'isl-tools' })
  const row = h('div', { class: 'isl-row' }, head, tools)
  const panel = h('div', { class: 'isl-panel' })
  const clip = h('div', { class: 'isl-clip' }, row, panel)
  const el = h('div', { class: 'isl', 'data-host': 'bar' }, clip, face)
  let signature = { panel: '', row: '' }
  let onHead: { kind: string } | null = null
  head.addEventListener('click', event => {
    if ((event.target as Element).closest('.isl-bg')) act({ kind: 'tasks' })
    else if (onHead) act(onHead)
  })
  function layout(open: boolean) {
    head.style.width = 'max-content'
    queueLayout(el, () => {
      if (!el.isConnected) return
      const room = (parseFloat(el.parentElement ? getComputedStyle(el.parentElement).maxWidth : '') || Infinity) - BORDER
      const toolsWidth = Math.ceil(tools.getBoundingClientRect().width)
      const bare = !head.childElementCount && !toolsWidth
      const headWidth = Math.min(bare ? size.head - BORDER : Math.ceil(head.getBoundingClientRect().width) + toolsWidth, size.maxHead, room)
      const inner = open ? Math.min(size.panel - BORDER, room) : headWidth
      return () => {
        head.style.width = `${Math.max(inner - toolsWidth, 0)}px`
        panel.style.width = `${inner}px`; el.style.width = `${inner + BORDER}px`
        if (!open) el.style.height = `${size.head}px`
        else queueLayout(panel, () => {
          const height = size.head + panel.scrollHeight
          return () => { if (el.dataset.open === 'true') el.style.height = `${height}px` }
        })
      }
    })
  }
  function update(view: IslandShown, { now = Date.now(), pinned = false } = {}) {
    const unfolds = hasPanel(view), open = unfolds && pinned
    const next = islandSignatures(view, open, false)
    next.row = `${localeRevision()}:${next.row}`; next.panel = `${localeRevision()}:${next.panel}`
    if (next.row === signature.row) {
      const clock = head.querySelector('.isl-time')
      if (clock && view.form === 'working') clock.textContent = elapsedSince(view, now)
      return
    }
    const panelChanged = next.panel !== signature.panel, wasOpen = el.dataset.open === 'true'
    signature = next
    Object.assign(el.dataset, { form: view.form, tone: view.tone, open: String(open) })
    head.replaceChildren(...[...headParts(view, { host: 'bar', now, tools: false, shortcut: '' }), tailCell(view)].filter((part): part is NonNullable<typeof part> => Boolean(part)))
    onHead = headAction(view, unfolds)
    head.disabled = !onHead && !view.background
    head.setAttribute('aria-label', [view.label, view.action ?? view.detail].filter(Boolean).join('：'))
    if (onHead?.kind === 'toggle') head.setAttribute('aria-expanded', String(open))
    else head.removeAttribute('aria-expanded')
    if (panelChanged) {
      panel.replaceChildren(...(open ? [h('div', { class: wasOpen ? 'isl-in isl-in-still' : 'isl-in' }, panelParts(view, 'bar', act, '', now))] : []))
      panel.inert = !open
    }
    layout(open)
  }
  return { el, update, setPointer(_on: boolean) {} }
}
/** The desktop portrait is a stable target. Only its neighbouring surface changes shape. */
function createDesktopIsland(act: IslandAct, input: ReturnType<typeof createIslandInput> | null, shortcut: string) {
  const maids: MaidSlots = new Map()
  const avatar = h('button', { type: 'button', class: 'isl-anchor', 'aria-label': t('desk.interaction.toggle'), onClick: () => act({ kind: 'toggle' }) })
  const surface = h('section', { class: 'isl-surface', 'aria-label': t('island-dom.content') })
  const peek = h('div', { class: 'isl-peek' })
  const el = h('div', { class: 'isl', 'data-host': 'desk', 'data-interaction': 'anchored' }, avatar, peek, surface)
  let signature = ''
  function update(view: IslandShown, { now = Date.now(), pinned = false } = {}) {
    const open = Boolean(view.desktopOpen ?? (view.form === 'input' || pinned)) && !view.dragging
    const wide = view.form === 'input'
    Object.assign(el.dataset, { form: view.form, tone: view.tone, open: String(open), layout: deskLayoutFor(view, open) })
    avatar.setAttribute('aria-expanded', String(open))
    avatar.setAttribute('aria-label', t('desk.interaction.toggle'))
    avatar.title = t('desk.interaction.gesture')
    const portrait = maidFor(maids, 'island', view.form === 'drop' ? 'listening' : maidMood(view.mood, view.tone), { size: 72, framing: 'whole', moving: true, badge: false })
    if (avatar.firstChild !== portrait) avatar.replaceChildren(portrait)
    surface.hidden = !open
    peek.hidden = open || view.dragging || view.form === 'mini' && !view.background?.count && !view.background?.done
    const next = JSON.stringify([view, open, localeRevision()])
    if (next === signature) {
      const clock = peek.querySelector('.isl-time')
      if (clock && view.form === 'working') clock.textContent = elapsedSince(view, now)
      return
    }
    signature = next
    const tail = tailCell(view, true)
    if (tail) {
      tail.addEventListener('click', () => act({ kind: 'panel', panel: 'background' }))
      tail.setAttribute('aria-expanded', String(open && view.desktopPanel === 'background'))
    }
    peek.replaceChildren(h('button', { type: 'button', class: 'isl-peek-open', onClick: () => act({ kind: 'toggle' }) }, deskHead(view, now)), ...(tail ? [tail] : []))
    if (!open) { surface.inert = true; return }
    surface.inert = false
    const title = view.desktopPanel === 'background' ? t('tasks-page.background.tasks')
      : wide ? t(view.steering ? 'desk.interaction.supplement' : 'desk.ask.viva') : view.label
    const header = h('header', { class: 'isl-surface-head' },
      h('div', { class: 'isl-copy' }, h('b', { class: 'isl-label', text: title }),
        view.targetLabel ? h('span', { class: 'isl-more', text: view.targetLabel, title: view.targetLabel }) : null),
      button(t('desk.interaction.open'), ROLE.text, () => act({ kind: 'open' })),
      button(t('desk.interaction.collapse'), ROLE.text, () => act({ kind: 'dismiss' })))
    const notice = view.waitingNotice ? h('div', { class: 'isl-notice', role: 'status' },
      h('span', { text: view.waitingNotice.label }), button(t('desk.interaction.view'), ROLE.text, () => act({ kind: 'panel', panel: 'request' }))) : null
    const running = wide && view.steering ? h('div', { class: 'isl-running' }, h('span', { text: t('desk.interaction.running') }),
      button(t('desk.interaction.stop.current'), ROLE.secondary, () => act({ kind: 'cancel' }))) : null
    keepingInput(surface, () => {
      const content = (wide || view.form === 'drop') && input ? input.panel(view) : panelParts(view, 'desk', act, shortcut, now)
      if (wide && input) input.sync(view)
      surface.replaceChildren(header, ...[notice, running, wide && input ? input.entry : null].filter((node): node is NonNullable<typeof node> => Boolean(node)), ...content.filter((node): node is HTMLElement => node instanceof HTMLElement))
    })
  }
  return { el, update, setPointer(on: boolean) { el.dataset.hover = String(on) } }
}

export function createIsland(host: Host, act: IslandAct, { input = null as ReturnType<typeof createIslandInput> | null, shortcut = '' } = {}) {
  return host === 'desk' ? createDesktopIsland(act, input, shortcut) : createBarIsland(act)
}

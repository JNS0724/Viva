import { t } from '../../shared/i18n/translate.ts'
import { localeRevision } from '../../shared/i18n/locale.ts'
import { formatElapsed } from '../selectors.ts'
import { maidFor, maidMood } from './maid.ts'
import type { MaidSlots } from './maid.ts'
import { h } from './dom.ts'
import { queueLayout, reconcileChildren } from './reconcile.ts'
import type { createIslandInput } from './island-input.ts'
import { createBackgroundSection, createTailCell, taskTag } from './island-tasks.ts'

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

/** Each region owns its nodes: summaries may change while a request or an action stays valid. */
function createPanelParts(host: Host, act: IslandAct, shortcut: string) {
  const background = createBackgroundSection(act)
  const steps = h('ol', { class: 'isl-steps' })
  const stop = button('', 'isl-btn-line', () => act({ kind: 'cancel' }))
  const trace = button('', ROLE.text, () => act({ kind: 'trace' }))
  const actions = h('div', { class: 'isl-actions' })
  const body = h('div', { class: 'isl-body', tabindex: '0' })
  const tasks = button('', `${ROLE.text} isl-push`, () => act({ kind: 'tasks' }))
  const footer = h('div', { class: 'isl-footer' }, tasks)
  let requestKey = '', request: View[] = [], stepsKey = ''
  return (view: IslandShown, now: number): View[] => {
    if (host === 'desk' && ['waiting', 'asking', 'coach', 'resolved', 'done', 'error', 'pending'].includes(view.form)) {
      const content = view.form === 'waiting' ? [view.task, view.permission]
        : view.form === 'asking' ? view.question : view.form === 'coach' ? null : view.detail || view.label
      const key = JSON.stringify([localeRevision(), view.form, content])
      if (key !== requestKey) {
        requestKey = key
        if (view.form === 'waiting') request = permissionPanel(view, act)
        else if (view.form === 'asking') request = questionPanel(view, act)
        else if (view.form === 'coach') request = coachPanel(act, shortcut)
        else request = desktopPanel([h('div', { class: 'isl-title', text: view.detail || view.label })], [
          button(t('desk.interaction.open'), 'isl-btn-blue', () => act({ kind: 'open' })),
          button(t('desk.interaction.continue'), ROLE.text, () => act({ kind: 'input' })),
        ])
      }
      return request
    }
    const section = background.update(view, now)
    if (host === 'desk') {
      body.setAttribute('aria-label', t('island-dom.content'))
      tasks.textContent = t('island-dom.view.full.activity')
      reconcileChildren(body, section ? [section] : [])
      return [body, footer]
    }
    const nextSteps = JSON.stringify(view.recent)
    if (nextSteps !== stepsKey) {
      stepsKey = nextSteps
      steps.replaceChildren(...view.recent.map(step => h('li', { 'data-tone': step.tone, text: step.title })))
    }
    stop.textContent = t('island-dom.stop')
    trace.textContent = t('island-dom.view.full.activity')
    reconcileChildren(actions, view.form === 'working' ? [stop, trace] : [trace])
    return [...(view.recent.length ? [steps, actions] : []), ...(section ? [section] : [])]
  }
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
  const { count = 0, done = 0, alsoWaiting = 0 } = view.background ?? {}
  const row = JSON.stringify([view.form, view.tone, view.label, view.action, view.detail, view.task,
    view.startedAt, view.steps, view.elapsedMs, hasPanel(view), Boolean(view.background), count, done, alsoWaiting, open, showTools])
  return { panel, row }
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
  const parts = createPanelParts('bar', act, '')
  const tail = createTailCell()
  const inner = h('div', { class: 'isl-in' })
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
    const rowChanged = next.row !== signature.row, panelChanged = next.panel !== signature.panel
    if (!rowChanged && !panelChanged) {
      const clock = head.querySelector('.isl-time')
      if (clock && view.form === 'working') clock.textContent = elapsedSince(view, now)
      return
    }
    const wasOpen = el.dataset.open === 'true'
    signature = next
    Object.assign(el.dataset, { form: view.form, tone: view.tone, open: String(open) })
    if (rowChanged) {
      reconcileChildren(head, [...headParts(view, { host: 'bar', now, tools: false, shortcut: '' }), tail.update(view)]
        .filter((part): part is NonNullable<typeof part> => Boolean(part)))
      onHead = headAction(view, unfolds)
      head.disabled = !onHead && !view.background
      head.setAttribute('aria-label', [view.label, view.action ?? view.detail].filter(Boolean).join('：'))
      if (onHead?.kind === 'toggle') head.setAttribute('aria-expanded', String(open))
      else head.removeAttribute('aria-expanded')
    }
    if (panelChanged) {
      if (open) {
        inner.className = wasOpen ? 'isl-in isl-in-still' : 'isl-in'
        reconcileChildren(inner, parts(view, now).filter((part): part is HTMLElement => part instanceof HTMLElement))
      }
      reconcileChildren(panel, open ? [inner] : [])
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
  const parts = createPanelParts('desk', act, shortcut)
  const tail = createTailCell(true)
  tail.el.addEventListener('click', () => act({ kind: 'panel', panel: 'background' }))
  const peekOpen = h('button', { type: 'button', class: 'isl-peek-open', onClick: () => act({ kind: 'toggle' }) })
  const label = h('b', { class: 'isl-label' }), target = h('span', { class: 'isl-more' })
  const copy = h('div', { class: 'isl-copy' }, label)
  const openWindow = button('', ROLE.text, () => act({ kind: 'open' }))
  const collapse = button('', ROLE.text, () => act({ kind: 'dismiss' }))
  const header = h('header', { class: 'isl-surface-head' }, copy, openWindow, collapse)
  const noticeLabel = h('span'), noticeButton = button('', ROLE.text, () => act({ kind: 'panel', panel: 'request' }))
  const notice = h('div', { class: 'isl-notice', role: 'status' }, noticeLabel, noticeButton)
  const runningLabel = h('span'), runningStop = button('', ROLE.secondary, () => act({ kind: 'cancel' }))
  const running = h('div', { class: 'isl-running' }, runningLabel, runningStop)
  let inputKey = '', inputParts: View[] = []
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
    const cell = tail.update(view)
    cell?.setAttribute('aria-expanded', String(open && view.desktopPanel === 'background'))
    peekOpen.replaceChildren(deskHead(view, now))
    reconcileChildren(peek, [peekOpen, ...(cell ? [cell] : [])])
    if (!open) { surface.inert = true; return }
    surface.inert = false
    const title = view.desktopPanel === 'background' ? t('tasks-page.background.tasks')
      : wide ? t(view.steering ? 'desk.interaction.supplement' : 'desk.ask.viva') : view.label
    if (label.textContent !== title) label.textContent = title
    if (target.textContent !== (view.targetLabel ?? '')) target.textContent = view.targetLabel ?? ''
    target.title = view.targetLabel ?? ''
    reconcileChildren(copy, view.targetLabel ? [label, target] : [label])
    openWindow.textContent = t('desk.interaction.open')
    collapse.textContent = t('desk.interaction.collapse')
    noticeLabel.textContent = view.waitingNotice?.label ?? ''
    noticeButton.textContent = t('desk.interaction.view')
    runningLabel.textContent = t('desk.interaction.running')
    runningStop.textContent = t('desk.interaction.stop.current')
    let content: View[]
    if ((wide || view.form === 'drop') && input) {
      const key = JSON.stringify([localeRevision(), view.form, view.count, view.files, view.images, view.busy, view.error, view.steering])
      if (key !== inputKey) { inputKey = key; inputParts = input.panel(view) }
      content = inputParts
    } else content = parts(view, now)
    if (wide && input) input.sync(view)
    // Detaching a focused textarea ends native IME composition, even if its value and caret are restored.
    reconcileChildren(surface, [
      header,
      ...[view.waitingNotice ? notice : null, wide && view.steering ? running : null, wide && input ? input.entry : null]
        .filter((node): node is NonNullable<typeof node> => Boolean(node)),
      ...content.filter((node): node is HTMLElement => node instanceof HTMLElement),
    ])
  }
  return { el, update, setPointer(on: boolean) { el.dataset.hover = String(on) } }
}

export function createIsland(host: Host, act: IslandAct, { input = null as ReturnType<typeof createIslandInput> | null, shortcut = '' } = {}) {
  return host === 'desk' ? createDesktopIsland(act, input, shortcut) : createBarIsland(act)
}

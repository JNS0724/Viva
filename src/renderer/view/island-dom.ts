import { t } from '../../shared/i18n/translate.ts'
import { localeRevision } from '../../shared/i18n/locale.ts'
import { formatElapsed } from '../selectors.ts'
import { userError } from '../user-error.ts'
import { maidFor, maidMood, showMaid } from './maid.ts'
import type { MaidSlots } from './maid.ts'
import { h } from './dom.ts'
import { reconcileChildren } from './reconcile.ts'
import type { createIslandInput } from './island-input.ts'
import { createBackgroundSection, createTailCell } from './island-tasks.ts'
import { deskCard } from '../island-desk-card.ts'
import type { DeskAction, DeskCard } from '../island-desk-card.ts'
import { cardButton, cardPart, iconButton, nameIcon } from './island-card.ts'

/** Shared task/request content with separate title-bar and desktop hosts. The desktop keeps a 72px
 * portrait in one 80px target, with explicit expansion of its neighbouring surface. Views wire actions;
 * the controller owns IPC, pointer intention, draft lifetime and native placement. */

type Host = 'bar' | 'desk'
const BAR_FACE_PX = 46
/**
 * In the title bar the island is a vertical badge (46px portrait + tucked status chin inside 72px);
 * on the desktop she is the island at 72px, with her neighbouring status and cards beside her.
 */

export type DeskLayout = 'rest' | 'capsule' | 'input' | 'content'

/** Desktop layout follows content, independently of the title bar's compact representation. */
export function deskLayoutFor(view: IslandShown, open: boolean, _tools = false): DeskLayout {
  if (view.dragging) return 'rest'
  if (open) return view.form === 'input' ? 'input' : 'content'
  // At rest she is alone unless tasks go on: what ended is counted on her corner, not in a strip (update below).
  return view.form === 'mini' && !view.background?.count ? 'rest' : 'capsule'
}

const safeDetail = (view: IslandShown): string | undefined =>
  (view.form === 'error' && !view.incomplete && view.detail ? userError(view.detail) : view.detail)

/** The second line of the peek: what the state is about, said once (the label says the state). */
function peekDetail(view: IslandShown): string | undefined {
  if (view.form === 'waiting' && view.permission) return view.permission.title
  if (view.form === 'asking' && view.question) return view.question.header ?? view.question.text
  return view.action ?? view.task ?? safeDetail(view)
}

/**
 * How the desktop portrait says where things stand at a glance (ui-guidelines 桌面岛): a ring for each, and for some
 * a sign, so shape as well as colour tells them apart. `rest`: the cat alone with nothing going on; `plain`: a form
 * of the island's own (the input, a note), drawn as it always was.
 */
export type DeskSignal = 'rest' | 'plain' | 'working' | 'confirm' | 'asking' | 'done' | 'error' | 'offline'
const SIGNAL_OF_FORM: Readonly<Record<string, DeskSignal>> = { working: 'working', waiting: 'confirm', asking: 'asking', done: 'done', error: 'error', pending: 'offline' }
/** Resting as the cat alone, the island keeps the tone of what it rests on: a turn done and not yet seen is still that. */
const SIGNAL_OF_TONE: Readonly<Record<string, DeskSignal>> = { working: 'working', done: 'done', error: 'error', pending: 'offline' }
export const deskSignal = (view: Pick<IslandShown, 'form' | 'tone'>): DeskSignal =>
  (view.form === 'mini' ? SIGNAL_OF_TONE[view.tone] ?? 'rest' : SIGNAL_OF_FORM[view.form] ?? 'plain')
/** The sign before the state's words, and on the portrait when it is alone; working says itself by turning. */
export const DESK_SIGNS: Readonly<Partial<Record<DeskSignal, string>>> = { confirm: '!', asking: '?', done: '✓', error: '×', offline: '–' }
/** Signs worn on the portrait: its dashed grey ring already says offline. */
const WORN_SIGNS: ReadonlySet<DeskSignal> = new Set(['confirm', 'asking', 'done', 'error'])
/** The sign is worn only with the portrait alone: beside the state's words it would say it twice. */
export const wearsSign = (signal: DeskSignal, alone: boolean): boolean => alone && WORN_SIGNS.has(signal)

function deskHead(view: IslandShown, now: number) {
  const attachments = view.form === 'input'
  let label = view.label
  let detail = peekDetail(view)
  if (attachments || view.form === 'drop') {
    label = t('desk.give.to.viva')
    if (attachments) detail = t('island-input.attachments', { count: view.files.length + (view.images?.length ?? 0) })
  } else if (view.form === 'mini') {
    // Resting with tasks in the background: say that they go on, and what the first one does.
    const running = view.background?.count ? view.background.items[0] : null
    label = t(running ? 'island-view.background.working' : 'desk.ask.viva')
    detail = running ? running.now ?? running.title : undefined
  }
  const since = view.form === 'working' ? view.startedAt ?? now : null
  const elapsed = since !== null ? formatElapsed(now - since)
    : view.form === 'done' && !view.task ? formatElapsed(view.elapsedMs ?? 0) : null
  return h('span', { class: 'isl-copy' },
    h('span', { class: 'isl-status' }, h('span', { class: 'isl-dot', 'aria-hidden': 'true', text: DESK_SIGNS[deskSignal(view)] }),
      h('b', { class: 'isl-label', text: label }), elapsed ? h('span', { class: 'isl-time', 'data-since': since, text: elapsed }) : null),
    detail ? h('span', { class: 'isl-more', text: detail, title: detail }) : null)
}

/** Requests jump to their card in the title bar; on the desktop they wait for explicit expansion. */
const NEEDS_USER = new Set(['waiting', 'asking'])

const elapsedSince = (view: IslandShown, now: number) => formatElapsed(now - (view.startedAt ?? now))

export type BarAction = { kind: 'jump', taskId?: string } | { kind: 'tasks' } | { kind: 'task', taskId: string, focusQuestion: string }

/** Title-bar badge clicks jump to a foreground request, open a waiting background task, or open background work when tasks run; idle is display-only. */
export function barActionFor(view: IslandShown): BarAction | null {
  if (NEEDS_USER.has(view.form)) {
    if (view.taskId && view.question?.needsText) return { kind: 'task', taskId: view.taskId, focusQuestion: view.question.questionId }
    return view.taskId ? { kind: 'jump', taskId: view.taskId } : { kind: 'jump' }
  }
  if ((view.background?.count ?? 0) > 0) return { kind: 'tasks' }
  return null
}

/** Semantic ring & sign for the title-bar portrait, surfacing active background work when the foreground is idle. */
export function barSignal(view: IslandShown): DeskSignal {
  const base = deskSignal(view)
  if (base !== 'rest' && base !== 'plain') return base
  if (view.background?.waiting) return 'confirm'
  if ((view.background?.count ?? 0) > 0) return 'working'
  return 'rest'
}

function barChinText(view: IslandShown): string {
  if (NEEDS_USER.has(view.form)) return t('island-dom.needs.your.attention')
  if (view.form === 'idle' && view.background?.waiting) return t('island-dom.needs.your.attention')
  if (view.form === 'idle' && (view.background?.count ?? 0) > 0) return t('island-view.background.working')
  return view.label
}

/**
 * What an update has to redraw. The row (head and tools) follows the pointer as well; the panel does not, so
 * the tools appearing under a resting pointer leave its buttons alone: one held down meanwhile is the one
 * let go, and the click still happens.
 */
export function islandSignatures(view: IslandShown, open: boolean, showTools: boolean) {
  const panel = JSON.stringify([view, open])
  const { count = 0, alsoWaiting = 0 } = view.background ?? {}
  const row = JSON.stringify([view.form, view.tone, view.label, view.action, view.detail, view.task,
    view.startedAt, view.steps, view.elapsedMs, Boolean(view.background), count, alsoWaiting, open, showTools])
  return { panel, row }
}

const button = (text: string, cls: string, onClick: () => void) => h('button', { type: 'button', class: `isl-btn ${cls}`, text, onClick })
/** Buttons by role (prompt-card.js), as on the thread's card: the main one filled, the others outlined, the least a link. */
const ROLE: Readonly<Record<string, string>> & { text: string, secondary: string } = Object.freeze({ primary: 'isl-btn-primary', secondary: 'isl-btn-secondary', text: 'isl-btn-text' })

function createBarIsland(act: IslandAct) {
  const maids: MaidSlots = new Map()
  const face = h('span', { class: 'isl-face', 'aria-hidden': 'true' })
  const bgSlot = h('span', { class: 'isl-bar-bg-slot' })
  const portraitBox = h('span', { class: 'isl-bar-portrait' }, face, bgSlot)
  const chin = h('span', { class: 'isl-bar-chin' })
  const head = h('button', { type: 'button', class: 'isl-head' }, portraitBox, chin)
  const el = h('div', { class: 'isl', 'data-host': 'bar' }, head)
  let signature = ''
  let onHead: BarAction | null = null
  head.addEventListener('click', () => {
    if (onHead) act(onHead)
  })
  function update(view: IslandShown, { now = Date.now() } = {}) {
    const signal = barSignal(view)
    const portrait = maidFor(maids, 'bar', maidMood(view.mood, view.tone), { size: BAR_FACE_PX, framing: 'face', moving: !view.still })
    showMaid(face, portrait)
    onHead = barActionFor(view)
    head.disabled = !onHead
    const next = `${localeRevision()}:${signal}:${view.taskId ?? ''}:${islandSignatures(view, false, false).row}`
    if (next === signature) {
      const clock = chin.querySelector('.isl-time')
      if (clock && view.form === 'working') clock.textContent = elapsedSince(view, now)
      return
    }
    signature = next
    const tone = view.form === 'idle' && view.background?.waiting ? 'waiting'
      : view.form === 'idle' && (view.background?.count ?? 0) > 0 ? 'working' : view.tone
    Object.assign(el.dataset, { form: view.form, tone, signal, open: 'false' })
    const bgCount = view.background?.count ?? 0
    reconcileChildren(bgSlot, bgCount > 0 ? [
      h('span', {
        class: `isl-bar-bg isl-bg${view.background?.waiting ? ' isl-bg-waits' : ''}`,
        'aria-hidden': 'true',
      }, h('b', { text: String(bgCount) })),
    ] : [])
    const signText = DESK_SIGNS[signal] ?? ''
    const signEl = h('span', { class: 'isl-bar-sign', 'aria-hidden': 'true', text: signText })
    const labelEl = h('b', { class: 'isl-label', text: barChinText(view) })
    const timeText = view.form === 'working' ? elapsedSince(view, now)
      : view.form === 'done' && !view.task && view.elapsedMs ? formatElapsed(view.elapsedMs) : ''
    reconcileChildren(chin, [signEl, labelEl, timeText ? h('span', { class: 'isl-time', text: timeText }) : null]
      .filter((part): part is NonNullable<typeof part> => Boolean(part)))
    const detail = view.action ?? safeDetail(view)
    const bgLabel = bgCount > 0 ? t('background.running.count', { p0: bgCount }) : ''
    const summary = [barChinText(view), detail, bgLabel].filter(Boolean).join(' · ')
    head.setAttribute('aria-label', summary)
    head.title = summary
  }
  return { el, update, setPointer(_on: boolean) {} }
}
/** The desktop portrait is a stable target. Only its neighbouring surface changes shape. */
function createDesktopIsland(act: IslandAct, input: ReturnType<typeof createIslandInput> | null, shortcut: string) {
  const maids: MaidSlots = new Map()
  const avatar = h('button', { type: 'button', class: 'isl-anchor', 'aria-label': t('desk.interaction.toggle'), onClick: () => act({ kind: 'toggle' }) })
  const surface = h('section', { class: 'isl-surface', 'aria-label': t('island-dom.content') })
  const peek = h('div', { class: 'isl-peek' })
  const sign = h('span', { class: 'isl-sign', 'aria-hidden': 'true', hidden: true })
  /** Her corner, alone at rest: what ended in the background and is not yet seen, counted there rather than in a strip. */
  const corner = h('span', { class: 'isl-corner', hidden: true })
  const el = h('div', { class: 'isl', 'data-host': 'desk', 'data-interaction': 'anchored' }, avatar, sign, corner, peek, surface)
  const tail = createTailCell(true)
  tail.el.addEventListener('click', () => act({ kind: 'panel', panel: 'background' }))
  const peekOpen = h('button', { type: 'button', class: 'isl-peek-open', onClick: () => act({ kind: 'toggle' }) })
  const card = createDeskCardParts(act, shortcut)
  const strips = createInputStrips(act, card.tools)
  const switching = h('span', { role: 'status' })
  const switchingIndicator = h('i', { class: 'isl-bg-ring', 'aria-hidden': 'true' })
  let inputKey = '', inputParts: View[] = []
  let signature = ''
  /** The clocks shown (the peek's, the working strip's) tick every second without a redraw. */
  const tick = (now: number) => {
    for (const clock of el.querySelectorAll<HTMLElement>('[data-since]')) clock.textContent = formatElapsed(now - Number(clock.dataset.since))
  }
  /** The input and files dragged over it: no head, the field first; ↗ and × sit on the strip above it, or in the corner. */
  function inputSurface(view: IslandShown, now: number): HTMLElement[] {
    if (!input) return []
    const key = JSON.stringify([localeRevision(), view.form, view.count, view.files, view.images, view.error, view.steering, view.targetLabel])
    if (key !== inputKey) { inputKey = key; inputParts = input.panel(view) }
    const parts = inputParts.filter((node): node is HTMLElement => node instanceof HTMLElement)
    if (view.form === 'drop') return parts
    card.closeWith({ kind: 'dismiss' })
    return [...strips.update(view, now), input.entry, ...parts]
  }
  function update(view: IslandShown, { now = Date.now(), pinned = false } = {}) {
    const open = Boolean(view.desktopOpen ?? (view.form === 'input' || pinned)) && !view.dragging
    const wide = view.form === 'input'
    const signal = deskSignal(view)
    Object.assign(el.dataset, { form: view.form, tone: view.tone, signal, open: String(open), layout: deskLayoutFor(view, open) })
    avatar.setAttribute('aria-expanded', String(open))
    avatar.setAttribute('aria-label', t('desk.interaction.toggle'))
    avatar.title = t('desk.interaction.gesture')
    const portrait = maidFor(maids, 'island', view.form === 'drop' ? 'listening' : maidMood(view.mood, view.tone), { size: 72, framing: 'whole', moving: !view.still, badge: false })
    showMaid(avatar, portrait)
    surface.hidden = !open
    // At rest the cat is alone: the strip beside her only for what goes on (tasks running). What ended is not the
    // island's: the conversation tells it.
    peek.hidden = open || view.dragging || view.form === 'mini' && !view.background?.count
    const alone = peek.hidden && !open && !view.dragging
    // Alone with tasks going on (the strip folded away while dragged), their count takes her corner before her sign:
    // it is the way to the 后台 list, and her ring already says the rest.
    const counted = alone && Boolean(view.background?.count || view.background?.alsoWaiting)
    sign.textContent = DESK_SIGNS[signal] ?? ''
    sign.hidden = counted || !wearsSign(signal, peek.hidden && !open)
    const next = JSON.stringify([view, open, localeRevision()])
    if (next === signature) return tick(now)
    signature = next
    const cell = tail.update(view)
    cell?.setAttribute('aria-expanded', String(open && view.desktopPanel === 'background'))
    peekOpen.replaceChildren(deskHead(view, now))
    const cornered = Boolean(cell) && counted
    corner.hidden = !cornered
    reconcileChildren(corner, cornered && cell ? [cell] : [])
    reconcileChildren(peek, [peekOpen, ...(cell && !cornered ? [cell] : [])])
    if (!open) { surface.inert = true; return }
    surface.inert = false
    card.name()
    // The 后台 list is the panel the user opened, whatever the conversation's own form is meanwhile.
    const cardView = view.desktopPanel === 'background' ? { ...view, form: 'background' } : view
    const shown = deskCard(cardView, { shortcut })
    if (view.form === 'switching') switching.textContent = view.label
    const content = view.form === 'switching' ? [switchingIndicator, switching, card.dismissButton]
      : shown ? card.draw(shown, view, now) : inputSurface(view, now)
    if (wide && input) input.sync(view)
    // Detaching a focused textarea ends native IME composition, even if its value and caret are restored.
    reconcileChildren(surface, content)
  }
  return { el, update, setPointer(on: boolean) { el.dataset.hover = String(on) } }
}

/**
 * A card's head (state dot, state, a few words, ↗ and ×), body and buttons (island-desk-card.ts). Its nodes are kept
 * while the card says the same, so a button held down when the view changes is the one let go.
 */
function createDeskCardParts(act: IslandAct, shortcut: string) {
  let close: DeskAction = { kind: 'dismiss' }
  const open = iconButton('external', () => act({ kind: 'open' }))
  const fold = iconButton('close', () => act(close))
  const tools = h('span', { class: 'isl-tools-desk' })
  const dot = h('span', { class: 'isl-dot', 'aria-hidden': 'true' })
  const label = h('b', { class: 'isl-label' }), meta = h('span', { class: 'isl-more' })
  const header = h('header', { class: 'isl-surface-head' })
  const body = h('div', { class: 'isl-body', tabindex: '0' })
  const footer = h('div', { class: 'isl-footer' })
  const background = createBackgroundSection(act, { desk: true })
  let key = '', parts: Array<HTMLElement | null> = [], buttons: HTMLElement[] = []
  return {
    tools,
    get dismissButton() { close = { kind: 'dismiss' }; return fold },
    closeWith(next: DeskAction) { close = next; reconcileChildren(tools, [open, fold]) },
    /** Names the icons and the body in the language now shown. */
    name() {
      nameIcon(open, t('desk.interaction.open'))
      nameIcon(fold, t('desk-card.close'))
      body.setAttribute('aria-label', t('island-dom.content'))
    },
    draw(card: DeskCard, view: IslandShown, now: number): HTMLElement[] {
      // Keyed on what the body and buttons say and do, not on the head: a state line that changes every moment
      // never rebuilds a button the user is holding down.
      const next = JSON.stringify([localeRevision(), shortcut, card.body, card.actions])
      if (next !== key) {
        key = next
        parts = card.body.map(part => part.kind === 'background' ? null : cardPart(part, act))
        buttons = card.actions.map(button => cardButton(button, act))
      }
      close = card.close
      if (label.textContent !== card.label) label.textContent = card.label
      if (meta.textContent !== card.meta) { meta.textContent = card.meta; meta.title = card.meta }
      reconcileChildren(header, [dot, label, meta, ...(card.openIcon ? [open] : []), fold])
      const section = card.body.some(part => part.kind === 'background') ? background.update(view, now) : null
      const content = parts.map(part => part ?? section).filter((part): part is HTMLElement => Boolean(part))
      reconcileChildren(body, content)
      reconcileChildren(footer, buttons)
      return [header, ...(content.length ? [body] : []), ...(buttons.length ? [footer] : [])]
    },
  }
}

/**
 * Above the input: what waits on the user (orange), or what the agent does now while the input adds to it. The
 * first strip carries ↗ and ×; with none, they sit in the field's corner.
 */
function createInputStrips(act: IslandAct, tools: HTMLElement) {
  const noticeLabel = h('span', { class: 'isl-strip-text' }), noticeButton = button('', ROLE.text, () => act({ kind: 'panel', panel: 'request' }))
  const noticeDot = h('i', { class: 'isl-dot', 'aria-hidden': 'true' })
  const notice = h('div', { class: 'isl-notice' }, noticeDot, noticeLabel, noticeButton)
  noticeLabel.setAttribute('role', 'status')
  const pulse = h('span', { class: 'isl-pulse', 'aria-hidden': 'true' })
  const runningLabel = h('span', { class: 'isl-strip-text' }), runningTime = h('span', { class: 'isl-time' })
  const runningStop = button('', ROLE.text, () => act({ kind: 'cancel' }))
  const running = h('div', { class: 'isl-running' }, pulse, runningLabel, runningTime, runningStop)
  return {
    update(view: IslandShown, now: number): HTMLElement[] {
      const waiting = view.waitingNotice
      const what = waiting?.permission?.title ?? waiting?.question?.text
      noticeLabel.textContent = waiting ? (what ? t('desk-card.notice', { label: waiting.label, what }) : waiting.label) : ''
      noticeLabel.title = noticeLabel.textContent
      noticeButton.textContent = t('desk.interaction.view')
      runningLabel.textContent = view.action || t('desk.interaction.running')
      runningLabel.title = runningLabel.textContent
      if (view.startedAt) {
        runningTime.dataset.since = String(view.startedAt)
        runningTime.textContent = formatElapsed(now - view.startedAt)
      } else {
        delete runningTime.dataset.since
        runningTime.textContent = ''
      }
      runningStop.textContent = t('desk.interaction.stop.current')
      const shown = waiting ? notice : view.steering ? running : null
      reconcileChildren(notice, [noticeDot, noticeLabel, noticeButton, ...(shown === notice ? [tools] : [])])
      reconcileChildren(running, [pulse, runningLabel, runningTime, runningStop, ...(shown === running ? [tools] : [])])
      tools.dataset.place = shown ? 'strip' : 'corner'
      return [shown ?? tools]
    },
  }
}

export function createIsland(host: Host, act: IslandAct, { input = null as ReturnType<typeof createIslandInput> | null, shortcut = '' } = {}) {
  return host === 'desk' ? createDesktopIsland(act, input, shortcut) : createBarIsland(act)
}

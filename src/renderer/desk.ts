import { t } from '../shared/i18n/translate.ts'
import { initializeLanguage } from './language.ts'
import { IMAGE_LIMITS } from '../shared/images.ts'
import { insertText, pastedParts } from './paste.ts'
import { createIsland } from './view/island-dom.ts'
import { createIslandInput } from './view/island-input.ts'
import { placeDesktopIsland } from './view/desktop-layout.ts'
import { createComposerDraftActions } from './composer-draft-actions.ts'
import { nextRequest, requestFor, showsCoach } from './island-desk-card.ts'
import type { DraftContent } from '../shared/composer-draft.ts'

/**
 * The page of the desktop island's window (src/shell/desk-island.ts): the same island as in the title bar,
 * fed by the main process with what the window's island shows. Clicks go back as actions; the main process
 * checks them and passes them on to the window. Here too: the input (the shortcut, a click on the resting
 * cat, or files dropped on the island), moving the island, which the main process does while the user holds
 * it, its right-click menu, which the main process shows, and the first-time note on what it can do.
 */
const TICK_MS = 1000
/** Moved this far with the button down, a press on the island is a drag, not a click. */
const DRAG_START_PX = 8
const IDLE_VIEW: IslandShown = Object.freeze({ form: 'idle', tone: 'idle', mood: 'idle', label: '', recent: [] })
const api = window.desk
let languageReady = false
/**
 * The main process sends the view once the page has loaded, which does not wait for the language (asked of the
 * backend, in its own process): a view that comes meanwhile is kept here and handed on below.
 */
let earlyView: unknown = null
const stopEarly = api.onView((next) => { earlyView = next })
await initializeLanguage(api, () => { if (languageReady) show() })

/**
 * From the main process: the window's view, the form to show, where the island sits, whether it is dragged,
 * whether the user has yet to see what it can do (coach).
 */
type Payload = { view?: IslandShown, form?: string, align?: string, dir?: string, dragging?: boolean, hover?: boolean, coach?: boolean, layoutVersion?: number,
  viewport?: { top: number, bottom: number },
  expanded?: boolean, panel?: 'input' | 'request' | 'background' | 'status', anchor?: { x: number, y: number }, side?: 'left' | 'right', panelWidth?: number }
let payload: Payload | null = null
/**
 * The input's own state: files dropped so far, pictures pasted (kept in the pictures folder), the last refusal,
 * files being dragged over (their count).
 */
let files: Array<{ path: string, name: string, size: number }> = []
let images: Array<{ id: string, size: number }> = []
let error: string | null = null
let dropping = 0
let sending = false
let draftActions: ReturnType<typeof createComposerDraftActions> | undefined
let activeRequest: IslandShown | null = null
const saveDraft = () => draftActions?.changed()

const messageOf = (err: unknown) => String((err as Error | null)?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** Pictures pasted into the island's input: kept at once, shown as chips, sent with the words. */
async function addImages(pasted: readonly File[]) {
  const origin = draftActions?.snapshot()?.key
  if (!origin) return
  const ticket = await api.beginImageImport(origin)
  if (!ticket) return
  try {
    const read = await Promise.allSettled(pasted.slice(0, IMAGE_LIMITS.perMessage + 1).map(file => file.arrayBuffer()))
    const bytes: Uint8Array<ArrayBuffer>[] = []
    let readError: string | null = null
    for (const result of read) {
      if (result.status === 'fulfilled') bytes.push(new Uint8Array(result.value))
      else readError ??= messageOf(result.reason)
    }
    await api.keepDraftImages(origin, bytes, ticket, readError)
  } catch (err) {
    api.endImageImport(ticket, messageOf(err))
  } finally {
    api.endImageImport(ticket)
  }
}

const input = createIslandInput({
  send: (text) => ask(text),
  dismiss: () => api.act({ kind: 'dismiss' }),
  configure: () => api.act({ kind: 'settings' }),
  removeFile: (path) => {
    files = files.filter((file) => file.path !== path)
    saveDraft()
    show()
  },
  removeImage: (id) => {
    images = images.filter((image) => image.id !== id)
    saveDraft()
    show()
  },
  // As in the window's input (paste.js): pictures become chips; words that came only as formatted text go in by hand.
  paste: (event) => {
    const parts = pastedParts(event.clipboardData)
    if (parts.text === null) return
    event.preventDefault()
    insertText(input.field, parts.text)
    saveDraft()
    if (parts.images.length) addImages(parts.images)
  },
})
const island = createIsland('desk', (action: Args<'island:act'>[0]) => api.act(action), { input, shortcut: api.shortcut })
const stage = document.getElementById('desk')
if (!stage) throw new Error('desk.html has no #desk')
stage.append(island.el)
input.field.addEventListener('input', saveDraft)
draftActions = createComposerDraftActions({ api, host: 'desk',
  read: (): DraftContent => ({ text: input.field.value, files, images, error }),
  write: draft => {
    if (input.field.value !== draft.text) input.field.value = draft.text
    files = draft.files
    images = draft.images.map(image => ({ ...image, size: image.size ?? 0 }))
    error = draft.error
    input.ready(); show()
  },
})

/** Why the input cannot take a question now, if it cannot. */
function busyOf(view: { form: string }) {
  if (payload?.view?.target?.blocked) return { text: t('session.switching') }
  return view.form === 'pending' ? { text: t("desk.not.connected.yet.open.the.window.to") } : null
}

/** What the island shows now, from what the main process said and what happens on this page. */
function shownView(): IslandShown {
  const view = payload?.view ?? IDLE_VIEW
  const context = { desktopOpen: Boolean(payload?.expanded) || Boolean(dropping), desktopPanel: payload?.panel, targetLabel: view.target?.label }
  if (dropping) return { ...context, desktopOpen: true, form: 'drop', tone: 'done', mood: 'idle', label: t("desk.give.to.viva"), recent: [], count: dropping }
  // While dragged only the portrait remains; the canvas and local anchor may stay fixed on Windows.
  if (payload?.dragging) return { ...view, ...context, desktopOpen: false, form: 'mini', dragging: true, background: null }
  if (payload?.expanded && payload.panel === 'input') {
    return { ...context, form: 'input', tone: 'done', mood: view.mood, label: t("desk.ask.viva"), recent: [], busy: busyOf(view), steering: view.target?.working ?? view.form === 'working',
      action: view.action, startedAt: view.startedAt,
      waitingNotice: view.form === 'waiting' || view.form === 'asking' ? view : null, files, images, error, sending }
  }
  if (payload?.expanded && payload.panel === 'background') return { ...view, ...context, form: 'background' }
  if (payload?.expanded && payload.panel === 'request') {
    const current = activeRequest && requestFor(view, requestId(activeRequest))
    // Answered with none left: the card folds (takeView asked the main process to close it) to a short note.
    return current ? { ...current, ...context } : resolvedNote(view, context)
  }
  const waits = NEEDS_USER.has(view.form)
  if (!waits && Date.now() < resolvedUntil) return resolvedNote(view, context)
  if (!waits && showsCoach({ ...payload, dropping: Boolean(dropping) })) {
    return { ...context, ...IDLE_VIEW, desktopOpen: true, form: 'coach', tone: 'done', mood: view.mood, label: t('desk.viva.is.here') }
  }
  return { ...view, ...context, ...(payload?.form === 'mini' && !waits ? { form: 'mini' } : {}) }
}
const requestId = (view: IslandShown) => view.permission?.requestId ?? view.question?.questionId ?? null
/** Forms in which the island shows what waits on the user. */
const NEEDS_USER = new Set(['waiting', 'asking'])
/** How long the peek says a request was handled, once its card has folded. */
const RESOLVED_NOTE_MS = 2_000
let resolvedUntil = 0
const resolvedNote = (view: IslandShown, context: object) => ({ ...context, ...IDLE_VIEW, desktopOpen: false, form: 'resolved', tone: 'done',
  label: t('desk.interaction.resolved'), background: view.background ?? null })

/**
 * The request card follows what it shows: once answered (here or in the window) it moves to the next request that
 * waits, or, with none left, asks the main process to fold it and says for a moment that it was handled.
 */
function followRequest(next: Payload) {
  if (!next.expanded || next.panel !== 'request' || !activeRequest || !next.view) return
  const following = nextRequest(next.view, requestId(activeRequest))
  if (following === null) return
  if (following) { activeRequest = following; return }
  activeRequest = null
  resolvedUntil = Date.now() + RESOLVED_NOTE_MS
  api.act({ kind: 'dismiss' })
}

/** The 后台 list, opened by a click on the count at the island's tail; it closes when no task is left. */

function show() {
  if (!payload && !dropping) return
  const view = shownView()
  input.field.readOnly = !draftActions?.ready()
  island.update(view, { now: Date.now() })
  if (view.form === 'input' && !view.busy && !island.el.contains(document.activeElement) && document.hasFocus()) input.field.focus()
  placeSurface()
}

async function ask(text: string) {
  if (sending || !draftActions?.ready()) return
  sending = true
  error = null
  saveDraft()
  const draft = draftActions.snapshot()!
  show()
  try {
    const result = await api.ask(text, files.map((file) => file.path), images.map(({ id }) => ({ id })), { key: draft.key, version: draft.version })
    if (!result.ok && draftActions.snapshot()?.key === draft.key) error = result.error ?? t('desk.interaction.draft.not.sent')
  } catch (err) {
    if (draftActions.snapshot()?.key === draft.key) error = messageOf(err)
  } finally { sending = false; if (error) saveDraft(); show() }
}

let layoutFrame = 0
let paintedVersion = -1
let acknowledgingVersion = -1
let readyVersion = -1
const takeView = (next: Payload) => {
  if (next.expanded && next.panel === 'request' && (!payload?.expanded || payload.panel !== 'request')) activeRequest = next.view ?? null
  payload = next
  followRequest(next)
  if (next.view?.target?.key) draftActions?.expect(next.view.target.key)
  Object.assign(stage.dataset, { align: next.align, dir: next.dir, dragging: String(Boolean(next.dragging)) })
  island.el.dataset.dir = next.dir
  island.setPointer(Boolean(next.hover))
  show()
}
api.onView(takeView)
stopEarly()
if (earlyView) takeView(earlyView)
setInterval(show, TICK_MS)

// The main process lets clicks through to what is below except over the island, so it needs to know where
// the island is; that changes with every change of shape and place.
function reportRect(ready = false) {
  if (!payload || paintedVersion !== (payload.layoutVersion ?? 0)) return
  const { x, y, width, height } = island.el.getBoundingClientRect()
  const regions = [...island.el.querySelectorAll<HTMLElement>('.isl-anchor, .isl-peek:not([hidden]), .isl-surface:not([hidden])')].map(el => {
    const { x, y, width, height } = el.getBoundingClientRect(); return { x, y, width, height }
  })
  api.act({ kind: 'rect', x, y, width, height, regions, version: payload?.layoutVersion ?? 0, ready })
}
function placeSurface() {
  if (!payload) return
  const version = payload.layoutVersion ?? 0
  placeDesktopIsland(island.el, stage!, { anchor: payload.anchor ?? { x: 60, y: 50 }, side: payload.side ?? 'right', panelWidth: payload.panelWidth ?? 440, viewport: payload.viewport }, () => {
    if (version !== (payload?.layoutVersion ?? 0)) return
    paintedVersion = version
    reportRect()
    if (readyVersion !== version && acknowledgingVersion !== version) acknowledgeLayout(version)
  })
}
/** Acknowledge only after queued placement commits and its geometry has had time to paint. */
function acknowledgeLayout(version: number) {
  cancelAnimationFrame(layoutFrame)
  acknowledgingVersion = version
  layoutFrame = requestAnimationFrame(() => {
    layoutFrame = requestAnimationFrame(() => {
      if ((payload?.layoutVersion ?? 0) === version && paintedVersion === version) {
        readyVersion = version
        reportRect(true)
      }
    })
  })
}
const observer = new ResizeObserver(() => { placeSurface() })
observer.observe(stage)
island.el.querySelectorAll('.isl-surface, .isl-peek').forEach(element => observer.observe(element))
new MutationObserver(() => reportRect()).observe(stage, { attributes: true, attributeFilter: ['data-align', 'data-dir', 'data-dragging'] })

// Holding the island and moving it drags it; the main process moves the window with the pointer, and the
// island shrinks to its cat meanwhile. It moves at this page's frames, so in step with the screen at any
// refresh rate, and not at all while the pointer rests. The click that ends a drag is not a click on the island.
let press: { x: number, y: number, id: number, canceled?: boolean } | null = null
let dragged = false
let frame = 0
/** What a pointer or click on the island landed on: always an element of the island's page. */
const targetOf = (event: Event) => event.target as Element

function dragFrame() {
  api.act({ kind: 'drag', phase: 'move' })
  frame = requestAnimationFrame(dragFrame)
}
island.el.addEventListener('pointerdown', (event) => {
  const target = targetOf(event).closest<HTMLElement>('.isl-anchor')
  if (event.button !== 0 || !target) return
  press = { x: event.screenX, y: event.screenY, id: event.pointerId }
  target.setPointerCapture(event.pointerId)
  dragged = false
})
island.el.addEventListener('pointermove', (event) => {
  if (!press || press.canceled || dragged || event.pointerId !== press.id) return
  if (Math.hypot(event.screenX - press.x, event.screenY - press.y) < DRAG_START_PX) return
  dragged = true
  api.act({ kind: 'drag', phase: 'start', x: press.x, y: press.y })
  frame = requestAnimationFrame(dragFrame)
})
const endPress = (event: Event) => {
  cancelAnimationFrame(frame)
  if (dragged && !press?.canceled) api.act({ kind: 'drag', phase: event.type === 'pointerup' ? 'end' : 'cancel' })
  if (event.type !== 'pointerup') dragged = false
  press = null
}
island.el.addEventListener('pointerup', endPress)
island.el.addEventListener('pointercancel', endPress)
island.el.addEventListener('lostpointercapture', event => { if (press) endPress(event) })
window.addEventListener('blur', event => { if (press) endPress(event) })
window.addEventListener('focus', () => { if (payload?.expanded && payload.panel === 'input' && !input.field.disabled) input.field.focus() })
island.el.addEventListener('click', (event) => {
  if (!dragged) return
  dragged = false
  event.stopPropagation()
  event.preventDefault()
}, true)

/** Forms in which the island shows what waits on the user: that comes first, and the count opens the window. */

// The count at the tail opens the 后台 list here while tasks go on; otherwise (all ended, or something waits on
// the user) it goes on to the island's own handler, which opens the window on its 后台 page.

// The right-click menu is the main process's: a menu of the system's, not of the page.
island.el.addEventListener('contextmenu', (event) => {
  event.preventDefault()
  api.act({ kind: 'menu' })
})

// Files dragged from any app onto the island: it opens to take them, and dropping opens the input with them.
// While files are over it the page hears dragover again and again; when that stops, they have gone.
const DRAG_GONE_MS = 300
const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files')
let dropTimer: ReturnType<typeof setTimeout> | undefined
const stopDropping = () => {
  clearTimeout(dropTimer)
  if (!dropping) return
  dropping = 0
  show()
}
island.el.addEventListener('dragenter', (event) => {
  if (hasFiles(event)) event.preventDefault()
})
island.el.addEventListener('dragover', (event) => {
  if (!event.dataTransfer || !hasFiles(event)) return
  event.preventDefault()
  event.dataTransfer.dropEffect = 'copy'
  clearTimeout(dropTimer)
  dropTimer = setTimeout(stopDropping, DRAG_GONE_MS)
  if (dropping) return
  dropping = event.dataTransfer.items?.length || 1
  show()
})
island.el.addEventListener('dragleave', (event) => {
  if (!island.el.contains(event.relatedTarget as Node | null)) stopDropping()
})
island.el.addEventListener('drop', async (event) => {
  if (!event.dataTransfer || !hasFiles(event)) return
  event.preventDefault()
  clearTimeout(dropTimer)
  dropping = 0
  const origin = draftActions?.snapshot()?.key
  if (!origin) return
  const appended = api.appendDroppedFiles(origin, [...event.dataTransfer.files])
  api.act({ kind: 'input' })
  await appended
})
// Esc closes the input even while its field cannot be typed in (the agent is busy).
document.addEventListener('keydown', (event) => {
  if (event.isComposing || event.keyCode === 229) return
  if (event.key === 'Escape') {
    event.preventDefault(); event.stopPropagation()
    if (press && dragged) {
      cancelAnimationFrame(frame); press.canceled = true
      api.act({ kind: 'drag', phase: 'cancel' })
    } else api.act({ kind: 'dismiss' })
  }
  if (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey) { event.preventDefault(); api.act({ kind: 'menu' }) }
})

languageReady = true
show()

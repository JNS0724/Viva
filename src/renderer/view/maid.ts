/**
 * Viva's maid (docs/ui-guidelines.md, Her character): one picture per mood in src/assets/maid, drawn on its own cream, so a
 * round crop of it never shows a square edge. `whole` uses the V7 half-body art (home, cards and desktop island);
 * `face` uses the dedicated V2.2 centred portraits in avatars/ at their original framing. Every mood has an
 * animation (`<mood>-motion.webp`); reduced motion selects the matching still.
 *
 * Views are rebuilt often (every second for the clock, every frame while an answer streams), so a picture is
 * kept per slot and reused while its look stays the same: a rebuilt node would restart its animation.
 */
import { h } from './dom.ts'

export const MAID_MOODS = Object.freeze(['greeting', 'idle', 'thinking', 'typing', 'ask', 'listening', 'confirm', 'done', 'error', 'offline', 'sleeping'] as const)
export type MaidMood = typeof MAID_MOODS[number]
/** The moods that have an animation of their own. */
export const MOVING_MOODS: ReadonlySet<MaidMood> = new Set(MAID_MOODS)
/**
 * Moods drawn with another mood's pictures. Files held over the desktop island: she listens, as when she asks,
 * but nothing waits on the user, so the ring is blue and there is no badge.
 */
const PICTURES: Readonly<Partial<Record<MaidMood, MaidMood>>> = Object.freeze({ listening: 'ask' })
export type Framing = 'whole' | 'face'
export type Ring = 'quiet' | 'blue' | 'orange' | 'red' | 'gray'

const RINGS: Readonly<Record<MaidMood, Ring>> = Object.freeze({
  greeting: 'blue', idle: 'quiet', thinking: 'blue', typing: 'blue', ask: 'orange', listening: 'blue',
  confirm: 'orange', done: 'blue', error: 'red', offline: 'gray', sleeping: 'quiet',
})
/** What her props cannot say once the picture is small. */
const BADGES: Readonly<Partial<Record<MaidMood, string>>> = Object.freeze({ confirm: '!', ask: '?', done: '✓' })

const isMood = (mood: string): mood is MaidMood => (MAID_MOODS as readonly string[]).includes(mood)

/** The mood to draw: anything without a picture rests; a quiet island still connecting shows her offline. */
export function maidMood(mood: string, tone?: string): MaidMood {
  const known = isMood(mood) ? mood : 'idle'
  return tone === 'pending' && RINGS[known] !== 'red' ? 'offline' : known
}

/** The half-body or dedicated portrait, using the animation only when motion is enabled. */
export function pictureOf(mood: MaidMood, moving: boolean, framing: Framing = 'whole'): string {
  const name = PICTURES[mood] ?? mood
  return `${framing === 'face' ? 'avatars/' : ''}${name}${moving ? '-motion' : ''}.webp`
}

export const badgeOf = (mood: MaidMood): string | null => BADGES[mood] ?? null

export const ringOf = (mood: MaidMood): Ring => RINGS[mood]

/** Both asset sets already contain their final framing; display the complete canvas. */
export function framingOf(size: number, _framing: Framing): { size: number, offset: number } {
  return { size, offset: 0 }
}

/** How she is drawn: her size, how she is framed, whether she may move, whether a badge says what she holds. */
export interface MaidOptions { size: number, framing?: Framing, moving?: boolean, badge?: boolean }

const urlOf = (file: string) => new URL(`../../assets/maid/${file}`, import.meta.url).href

/**
 * Every still loaded once, the first time she is drawn: a picture drawn later for another mood shows at once
 * instead of an empty disc. The images are kept so they stay in the cache.
 */
let warmed: HTMLImageElement[] | null = null
function warm() {
  if (warmed) return
  const files = new Set(MAID_MOODS.flatMap(mood => (['whole', 'face'] as const).map(framing => pictureOf(mood, false, framing))))
  warmed = [...files].map((file) => {
    const image = new Image()
    image.src = urlOf(file)
    return image
  })
}

function box(className: string, text = '') {
  const el = document.createElement('span')
  el.className = className
  el.textContent = text
  return el
}

/** Native picture sources follow reduced-motion changes without replacing or restarting the portrait node. */
function draw(mood: MaidMood, { size, framing = 'whole', moving = false, badge = false }: Required<MaidOptions>): HTMLElement {
  warm()
  const maid = box('maid')
  Object.assign(maid.style, { width: `${size}px`, height: `${size}px` })
  Object.assign(maid.dataset, { mood, ring: ringOf(mood), framing })
  maid.setAttribute('aria-hidden', 'true')
  const frame = framingOf(size, framing)
  const image = document.createElement('img')
  image.className = 'maid-image'
  image.src = urlOf(pictureOf(mood, moving, framing))
  image.alt = ''
  image.draggable = false
  Object.assign(image.style, { width: `${frame.size}px`, height: `${frame.size}px`, left: `${frame.offset}px`, top: `${frame.offset}px` })
  const art = box('maid-art')
  if (moving) {
    art.append(h('picture', {}, h('source', {
      media: '(prefers-reduced-motion: reduce)', srcset: urlOf(pictureOf(mood, false, framing)),
    }), image))
  } else art.append(image)
  maid.append(art)
  const sign = badge ? badgeOf(mood) : null
  if (sign) maid.append(box('maid-badge', sign))
  return maid
}

export type MaidSlots = Map<string, { key: string, el: HTMLElement }>

/** The maid for `slot`, reused while her look stays the same. */
export function maidFor(cache: MaidSlots, slot: string, mood: MaidMood, options: MaidOptions): HTMLElement {
  const resolved: Required<MaidOptions> = {
    size: options.size, framing: options.framing ?? 'whole', badge: options.badge ?? false,
    moving: Boolean(options.moving) && MOVING_MOODS.has(mood),
  }
  const key = `${mood}|${resolved.size}|${resolved.framing}|${resolved.moving}|${resolved.badge}`
  const kept = cache.get(slot)
  if (kept?.key === key) return kept.el
  const el = draw(mood, resolved)
  cache.set(slot, { key, el })
  return el
}

/** The portrait each slot is to show next, while its picture decodes. */
const coming = new WeakMap<Element, HTMLElement | null>()

/**
 * Puts `next` (or nothing) in `slot`, keeping the portrait already there until the new picture is decoded: a new
 * <img> shows nothing for a frame or two while it decodes, and a mood that changes (thinking, typing, done) would
 * blink her out. An empty slot takes it at once; a later call wins over one still waiting.
 */
export function showMaid(slot: Element, next: HTMLElement | null): void {
  if (slot.firstElementChild === next && slot.childElementCount === (next ? 1 : 0)) { coming.delete(slot); return }
  coming.set(slot, next)
  const image = next?.querySelector('img')
  const place = () => {
    if (coming.get(slot) !== next) return
    coming.delete(slot)
    if (next) slot.replaceChildren(next)
    else slot.replaceChildren()
  }
  if (!next || !slot.firstElementChild || !image || (image.complete && image.naturalWidth > 0)) return place()
  image.decode().then(place, place)
}

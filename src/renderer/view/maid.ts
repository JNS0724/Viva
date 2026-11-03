/**
 * Viva's maid (docs/maid-character.md): one picture per mood in src/assets/maid, drawn on its own cream, so a
 * round crop of it never shows a square edge. `whole` shows the half-body as drawn (the home page, the cards,
 * the desktop island); `face` zooms in on her face for the conversation's 48px. A few moods also have a short
 * animation (`<mood>-motion.webp`), used only where she is large and in front of the user, and never when the
 * system asks for reduced motion.
 *
 * Views are rebuilt often (every second for the clock, every frame while an answer streams), so a picture is
 * kept per slot and reused while its look stays the same: a rebuilt node would restart its animation.
 */
export const MAID_MOODS = Object.freeze(['greeting', 'idle', 'thinking', 'typing', 'ask', 'listening', 'confirm', 'done', 'error', 'offline', 'sleeping'] as const)
export type MaidMood = typeof MAID_MOODS[number]
/** The moods that have an animation of their own. */
export const MOVING_MOODS: ReadonlySet<MaidMood> = new Set(['greeting', 'thinking', 'typing', 'ask', 'listening', 'confirm'])
/**
 * Moods drawn with another mood's pictures. Files held over the desktop island: she listens, as when she asks,
 * but nothing waits on the user, so the ring is blue and there is no badge.
 */
const PICTURES: Readonly<Partial<Record<MaidMood, MaidMood>>> = Object.freeze({ listening: 'ask' })
/** `face` framing: how far in on her face, centred. */
export const FACE_ZOOM = 1.6

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

/** The file in src/assets/maid: the animation only for a mood that has one. */
export function pictureOf(mood: MaidMood, moving: boolean): string {
  const name = PICTURES[mood] ?? mood
  return moving && MOVING_MOODS.has(mood) ? `${name}-motion.webp` : `${name}.webp`
}

export const badgeOf = (mood: MaidMood): string | null => BADGES[mood] ?? null

export const ringOf = (mood: MaidMood): Ring => RINGS[mood]

const tenth = (value: number) => Math.round(value * 10) / 10

/** The picture's square size and its offset inside a `size` circle. */
export function framingOf(size: number, framing: Framing): { size: number, offset: number } {
  if (framing === 'whole') return { size, offset: 0 }
  const zoomed = tenth(size * FACE_ZOOM)
  return { size: zoomed, offset: tenth((size - zoomed) / 2) }
}

/** How she is drawn: her size, how she is framed, whether she may move, whether a badge says what she holds. */
export interface MaidOptions { size: number, framing?: Framing, moving?: boolean, badge?: boolean }

const urlOf = (file: string) => new URL(`../../assets/maid/${file}`, import.meta.url).href

const prefersStill = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * Every still loaded once, the first time she is drawn: a picture drawn later for another mood shows at once
 * instead of an empty disc. The images are kept so they stay in the cache.
 */
let warmed: HTMLImageElement[] | null = null
function warm() {
  warmed ??= MAID_MOODS.map((mood) => {
    const image = new Image()
    image.src = urlOf(pictureOf(mood, false))
    return image
  })
}

function box(className: string, text = '') {
  const el = document.createElement('span')
  el.className = className
  el.textContent = text
  return el
}

/** Drawn with the moving already decided (reduced motion respected), so the cache key says what is on screen. */
function draw(mood: MaidMood, { size, framing = 'whole', moving = false, badge = false }: Required<MaidOptions>): HTMLElement {
  warm()
  const maid = box('maid')
  Object.assign(maid.style, { width: `${size}px`, height: `${size}px` })
  Object.assign(maid.dataset, { mood, ring: ringOf(mood), framing })
  maid.setAttribute('aria-hidden', 'true')
  const frame = framingOf(size, framing)
  const image = document.createElement('img')
  image.className = 'maid-image'
  image.src = urlOf(pictureOf(mood, moving))
  image.alt = ''
  image.draggable = false
  Object.assign(image.style, { width: `${frame.size}px`, height: `${frame.size}px`, left: `${frame.offset}px`, top: `${frame.offset}px` })
  const art = box('maid-art')
  art.append(image)
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
    moving: Boolean(options.moving) && MOVING_MOODS.has(mood) && !prefersStill(),
  }
  const key = `${mood}|${resolved.size}|${resolved.framing}|${resolved.moving}|${resolved.badge}`
  const kept = cache.get(slot)
  if (kept?.key === key) return kept.el
  const el = draw(mood, resolved)
  cache.set(slot, { key, el })
  return el
}

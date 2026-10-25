/**
 * Viva's cat: a black kitten in a captain's cap (docs/cat-character.md). Every mood has two pictures in
 * src/assets/cat/bust: a half-body for the large sizes (the home page) and a head close-up for 48px and below
 * (the conversation, the title bar's and the desktop's islands). `typing` is drawn in layers: the body at its
 * keyboard and two paws that take turns striking it. What the picture cannot say (the thought dots, ! and ?,
 * the sparkles of a finished turn) is laid over it here and moved by CSS (styles.css, .cat-*), still when the
 * system asks for reduced motion.
 *
 * Views are rebuilt often (every frame while an answer streams, every second for the clock), so a cat is kept
 * per slot and reused while its look stays the same: a rebuilt node would restart its animations.
 */
export const CAT_MOODS = Object.freeze(['idle', 'thinking', 'typing', 'confirm', 'ask', 'done', 'error', 'sleeping'])

/** At this size and below the head close-up is drawn instead of the half-body. */
const HEAD_MAX_PX = 48
type Portrait = 'bust' | 'head'

const art = (name: string) => new URL(`../../assets/cat/bust/${name}.png`, import.meta.url).href
/** `typing`'s half-body is its keyboard layer: the paws come on top of it. */
const ART: Readonly<Record<string, Readonly<Record<Portrait, string>>>> = Object.freeze(Object.fromEntries(CAT_MOODS.map((mood) => [
  mood, Object.freeze({ bust: art(mood === 'typing' ? 'typing-base' : mood), head: art(`${mood}-head`) }),
])))
const TYPING_LAYERS = Object.freeze({ base: art('typing-base'), 'paw-left': art('typing-paw-left'), 'paw-right': art('typing-paw-right') })

/**
 * Every picture loaded once, the first time a cat is drawn: a cat drawn later for another mood shows at once
 * instead of an empty disc while its picture loads. The images are kept so they stay in the cache.
 */
let warmed: HTMLImageElement[] | null = null
function warm() {
  warmed ??= [...Object.values(ART).flatMap((portraits) => Object.values(portraits)), ...Object.values(TYPING_LAYERS)].map((src) => {
    const image = new Image()
    image.src = src
    return image
  })
}

function box(className: string, text = '') {
  const el = document.createElement('div')
  el.className = className
  el.textContent = text
  return el
}

function picture(className: string, src: string) {
  const image = document.createElement('img')
  image.className = className
  image.src = src
  image.alt = ''
  image.draggable = false
  return image
}

const NS = 'http://www.w3.org/2000/svg'
/** A four-pointed star: drawn, so it looks the same on every system (a text glyph depends on the fonts). */
function sparkle() {
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('class', 'cat-sparkle')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('aria-hidden', 'true')
  const star = document.createElementNS(NS, 'path')
  star.setAttribute('d', 'M12 0 Q12 12 24 12 Q12 12 12 24 Q12 12 0 12 Q12 12 12 0 Z')
  star.setAttribute('fill', 'currentColor')
  svg.append(star)
  return svg
}

/** What is laid over the picture: the thought dots, ! or ?, the sparkles; error's sweat drop is in its picture. */
function signal(mood: string): Element | null {
  // Asleep while background preparation goes on: the same bubble, dreaming of what it looks through.
  if (mood === 'thinking' || mood === 'sleeping') {
    const bubble = box(mood === 'sleeping' ? 'cat-signal cat-thought cat-dream' : 'cat-signal cat-thought')
    bubble.append(box('cat-dot'), box('cat-dot'), box('cat-dot'))
    return bubble
  }
  if (mood === 'confirm' || mood === 'ask') return box('cat-signal cat-question', mood === 'confirm' ? '!' : '?')
  if (mood === 'done') {
    const sparkles = box('cat-sparkles')
    sparkles.append(sparkle(), sparkle(), sparkle())
    return sparkles
  }
  return null
}

/** The keyboard and the two paws; at the large size over the body, at the small ones under the head. */
function typingLayers(className: string, layerClass: string) {
  const keys = box(className)
  for (const [part, src] of Object.entries(TYPING_LAYERS)) {
    const role = part === 'base' ? 'cat-typing-keyboard' : `cat-typing-paw cat-typing-${part}`
    keys.append(picture(`${layerClass} ${role}`, src))
  }
  return keys
}

/** How a cat is drawn: its size, on its blue disc or not, moving or still, and which picture (auto: by size). */
export interface CatOptions { size?: number, frame?: boolean, still?: boolean, variant?: 'auto' | Portrait }

/**
 * @param mood one of CAT_MOODS (anything else draws `idle`)
 */
export function drawCat(mood: string, { size = 120, frame = false, still = false, variant = 'auto' }: CatOptions = {}): HTMLElement {
  warm()
  const current = (CAT_MOODS as readonly string[]).includes(mood) ? mood : 'idle'
  const portrait: Portrait = variant === 'auto' ? (size <= HEAD_MAX_PX ? 'head' : 'bust') : variant
  const compact = size <= HEAD_MAX_PX
  const cat = box(['cat', frame && 'cat-framed', compact && 'cat-compact', still && 'cat-still'].filter(Boolean).join(' '))
  Object.assign(cat.style, { width: `${size}px`, height: `${size}px` })
  Object.assign(cat.dataset, { mood: current, variant: portrait })
  cat.setAttribute('aria-hidden', 'true')
  if (frame) cat.append(box('cat-disc'))

  const body = box('cat-art')
  body.append(picture('cat-image', ART[current][portrait]))
  if (current === 'typing' && portrait === 'bust') body.append(typingLayers('cat-typing-workstation', 'cat-image'))
  cat.append(body)
  if (current === 'typing' && portrait === 'head') cat.append(typingLayers('cat-typing-mini', 'cat-mini-layer'))
  const prop = signal(current)
  if (prop) cat.append(prop)
  return cat
}

/** The cat for `slot`, reused while its look stays the same. */
export function catFor(cache: Map<string, { key: string, el: HTMLElement }>, slot: string, mood: string, options: CatOptions = {}) {
  const key = `${mood}|${options.size}|${Boolean(options.frame)}|${Boolean(options.still)}|${options.variant ?? 'auto'}`
  const kept = cache.get(slot)
  if (kept?.key === key) return kept.el
  const el = drawCat(mood, options)
  cache.set(slot, { key, el })
  return el
}

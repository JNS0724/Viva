import { h } from './dom.ts'

/**
 * 按轮次跳转: down the left edge of the main area (the right is the dock's, view/task-dock.ts), a line per question of the topic on screen and, above them,
 * a dot per earlier topic read back (folded, view/earlier.ts). The place being read is lit, a mark shows its question
 * (or the topic's day and name) on hover or focus, and a click (or Enter) scrolls to it; ↑/↓ move between marks. It
 * reads the page itself, so it follows whatever the thread and the earlier part draw, and stays away until there
 * is enough to need it.
 */
const MIN_TURNS = 3
const PREVIEW_CHARS = 60
/** Questions only (a reply to the assistant's own question is part of its turn), and the folded earlier topics. */
const PLACES = '.topic-old, .msg-user:not(.msg-answer)'
const FOLDED = '.topic-old'
/** The turn being read is the one whose question has passed this far down the visible part. */
const READING_LINE = 1 / 3
/** Farther than this many screens away, a jump is instant rather than a long smooth scroll. */
const SMOOTH_SCREENS = 3

/**
 * Index of the last of `count` places at or above the reading line; the first turn above them all. Tops are read
 * only as the search needs them (a handful per frame, however long the conversation).
 */
export function activeTurn(count: number, topOf: (index: number) => number, line: number): number {
  if (!count) return -1
  let low = 0
  let high = count - 1
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (topOf(middle) <= line) low = middle
    else high = middle - 1
  }
  return low
}

/** The question on one line, cut to fit a tooltip. */
export function turnPreview(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  if (!line) return '（图片或文件）'
  return line.length > PREVIEW_CHARS ? `${line.slice(0, PREVIEW_CHARS)}…` : line
}

/** What was typed: the bubble's own text, not the names of the pictures and files above it. */
const questionText = (bubble: Element) => [...bubble.childNodes]
  .filter((node) => node.nodeType === Node.TEXT_NODE)
  .map((node) => node.textContent ?? '')
  .join(' ')

const sameList = (a: readonly Element[], b: readonly Element[]) => a.length === b.length && a.every((el, i) => el === b[i])

export function attachTurnRail(scroll: HTMLElement, rail: HTMLElement) {
  let places: HTMLElement[] = []
  let marks: HTMLButtonElement[] = []
  let active = -1
  let frame = 0

  const jump = (index: number) => {
    const place = places[index]
    const target = place?.matches(FOLDED) ? place : place?.closest<HTMLElement>('.msg-user-row') ?? place
    if (!target) return
    const far = Math.abs(target.getBoundingClientRect().top - scroll.getBoundingClientRect().top) > scroll.clientHeight * SMOOTH_SCREENS
    target.scrollIntoView({ block: 'start', behavior: far ? 'instant' : 'smooth' })
  }

  const light = (index: number) => {
    if (index === active) return
    marks[active]?.removeAttribute('aria-current')
    marks[active]?.setAttribute('tabindex', '-1')
    active = index
    marks[active]?.setAttribute('aria-current', 'step')
    marks[active]?.setAttribute('tabindex', '0')
  }

  const updateActive = () => {
    const box = scroll.getBoundingClientRect()
    light(activeTurn(places.length, (index) => places[index].getBoundingClientRect().top, box.top + box.height * READING_LINE))
  }

  const rebuild = () => {
    let turn = 0
    marks = places.map((place, index) => {
      const folded = place.matches(FOLDED)
      const tip = folded ? `话题 · ${place.dataset.title ?? ''}` : `第 ${turn += 1} 轮 · ${turnPreview(questionText(place))}`
      return h('button', {
        class: folded ? 'turn-mark turn-topic' : 'turn-mark', type: 'button', tabindex: '-1', 'aria-label': tip, 'data-tip': tip, onclick: () => jump(index),
      })
    })
    active = -1
    rail.replaceChildren(...marks)
    rail.hidden = places.length < MIN_TURNS
  }

  const refresh = () => {
    frame = 0
    // A question inside a folded topic is that topic's dot, not a line of its own.
    const found = [...scroll.querySelectorAll<HTMLElement>(PLACES)].filter((place) => place.matches(FOLDED) || !place.closest(FOLDED))
    if (!sameList(found, places)) {
      places = found
      rebuild()
    }
    if (!rail.hidden) updateActive()
  }
  const schedule = () => { frame ||= requestAnimationFrame(refresh) }

  rail.addEventListener('keydown', (event) => {
    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0
    const from = marks.indexOf(document.activeElement as HTMLButtonElement)
    if (!step || from < 0) return
    event.preventDefault()
    marks[Math.min(marks.length - 1, Math.max(0, from + step))].focus()
  })
  new MutationObserver(schedule).observe(scroll, { childList: true, subtree: true })
  scroll.addEventListener('scroll', schedule, { passive: true })
  schedule()
}

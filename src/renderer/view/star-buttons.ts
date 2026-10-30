import { t } from '../../shared/i18n/translate.ts'
import { h } from './dom.ts'

/**
 * The star by a message (stars.ts): it shows on hovering the message, and stays once the message is starred. It is
 * put into the message's own element, so it follows the message wherever it is drawn (the conversation, the earlier
 * part, a topic read in 回顾) without the views knowing; `sync` keeps every star in step after a change.
 * @param placeOf where the message of this element is kept, or null when it cannot be starred (not saved yet)
 */
const STARRABLE = '[data-msg].msg-user-row, [data-msg].msg-user, [data-msg].msg-agent'

export function attachStars(container: HTMLElement, { placeOf, isStarred, toggle }: {
  placeOf: (el: HTMLElement) => { segmentId: string, seq: number } | null,
  isStarred: (place: { segmentId: string, seq: number }) => boolean,
  toggle: (place: { segmentId: string, seq: number }, starred: boolean) => void,
}) {
  let frame = 0

  const show = (button: HTMLButtonElement, starred: boolean) => {
    if (button.getAttribute('aria-pressed') === String(starred)) return
    button.setAttribute('aria-pressed', String(starred))
    button.setAttribute('aria-label', starred ? t("merge.remove.bookmark.71") : t("merge.bookmark.this.message.72"))
    button.title = starred ? t("merge.remove.bookmark.71") : t("merge.bookmark.this.message.to.find.it.in.review.73")
    button.textContent = starred ? '★' : '☆'
  }

  const starOf = (el: HTMLElement) => el.querySelector<HTMLButtonElement>(':scope > .star-btn')

  /** The element's star, put in the first time it is needed. */
  function ensure(el: HTMLElement) {
    const place = placeOf(el)
    if (!place) return null
    const button = starOf(el) ?? el.appendChild(h('button', {
      class: 'star-btn', type: 'button',
      onClick: (event: MouseEvent) => {
        event.stopPropagation()
        const now = placeOf(el)
        if (now) toggle(now, !isStarred(now))
      },
    }))
    show(button, isStarred(place))
    return button
  }

  /** After the page changed or a star did: starred messages get theirs, the others are told they are not. */
  function sync() {
    frame = 0
    for (const el of container.querySelectorAll<HTMLElement>(STARRABLE)) {
      const place = placeOf(el)
      const button = starOf(el)
      if (place && isStarred(place)) ensure(el)
      else if (button) show(button, false)
    }
  }
  const schedule = () => { frame ||= requestAnimationFrame(sync) }

  container.addEventListener('mouseover', (event) => {
    const el = (event.target as Element | null)?.closest<HTMLElement>(STARRABLE)
    if (el && container.contains(el)) ensure(el)
  })
  new MutationObserver(schedule).observe(container, { childList: true, subtree: true })
  return { sync: schedule }
}

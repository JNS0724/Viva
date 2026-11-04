import { onLocaleChange } from '../../shared/i18n/locale.ts'
import { t } from '../../shared/i18n/translate.ts'
import { h } from './dom.ts'
import { queueLayout } from './reconcile.ts'

/**
 * Long messages fold (my-agent-workspace#8): a user's message, or an answer no longer the latest, that is clearly tall
 * shows its start and 展开; a message only a little over is left whole, so nothing folds just to save a few lines.
 * How tall it is is read in the layout pass (reconcile.ts queueLayout), before anything is written.
 */

/** Folded only from this height on (CSS px): a message a little over the folded height stays whole. */
export const FOLD_AT_PX = 560

/** Messages the user unfolded, this session: a redraw (another turn, the language) leaves them open. */
const unfolded = new Set<string>()
let EXPAND = t('thread.fold.expand')
let COLLAPSE = t('thread.fold.collapse')

/** What names a message across redraws: the same words from the same side. */
export const foldKey = (message: { role: string, text: string }) => `${message.role}:${message.text.length}:${message.text.slice(0, 64)}`

function setFolded(content: HTMLElement, toggle: HTMLButtonElement, folded: boolean) {
  content.dataset.folded = String(folded)
  toggle.setAttribute('aria-expanded', String(!folded))
  toggle.textContent = folded ? EXPAND : COLLAPSE
}

/**
 * `content` folds once laid out, if it is at least FOLD_AT_PX tall and the user has not unfolded it: its start shows,
 * and a toggle after it unfolds and folds it again.
 */
export function foldTall(content: HTMLElement, key: string): HTMLElement {
  content.classList.add('msg-fold')
  queueLayout(content, () => {
    if (!content.isConnected || unfolded.has(key) || content.dataset.folded) return undefined
    if (content.scrollHeight < FOLD_AT_PX) return undefined
    return () => {
      const toggle = h('button', {
        class: 'btn btn-text btn-small msg-fold-toggle', type: 'button',
        onClick: () => {
          const fold = content.dataset.folded !== 'true'
          if (fold) unfolded.delete(key)
          else unfolded.add(key)
          setFolded(content, toggle, fold)
        },
      }) as HTMLButtonElement
      setFolded(content, toggle, true)
      content.after(toggle)
    }
  })
  return content
}

onLocaleChange(() => {
  EXPAND = t('thread.fold.expand')
  COLLAPSE = t('thread.fold.collapse')
  for (const toggle of document.querySelectorAll<HTMLButtonElement>('.msg-fold-toggle')) {
    toggle.textContent = toggle.getAttribute('aria-expanded') === 'true' ? COLLAPSE : EXPAND
  }
})

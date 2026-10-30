import { t } from '../shared/i18n/translate.ts'
/** Keep search controls out of the large conversation's AX serialization domain. */
export async function mountHistorySearchFrame(input: HTMLInputElement): Promise<Document | null> {
  const host = input.parentElement
  if (!host) return null
  // This also applies to the fallback field if the child document cannot load.
  host.addEventListener('click', () => input.focus())
  const frame = document.createElement('iframe')
  frame.id = 'history-search-frame'
  frame.className = 'history-search-frame'
  frame.title = t("shell.search.conversations")
  // The parent owns all event handlers. The child needs neither scripts nor preload APIs.
  frame.sandbox.add('allow-same-origin')
  const next = input.nextSibling
  let composing = false
  let finished: (() => void) | undefined
  const startComposition = () => { composing = true }
  const endComposition = () => { composing = false; finished?.() }
  input.addEventListener('compositionstart', startComposition)
  input.addEventListener('compositionend', endComposition)
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error('Search frame load timed out')), 5000)
      frame.addEventListener('load', () => { window.clearTimeout(timer); resolve() }, { once: true })
      frame.addEventListener('error', () => { window.clearTimeout(timer); reject(new Error('Search frame failed to load')) }, { once: true })
      frame.src = new URL('./history-search-frame.html', import.meta.url).href
      host.insertBefore(frame, input)
    })
    const child = frame.contentDocument
    if (!child?.body || child.documentElement.dataset.historySearchFrame !== 'true') {
      throw new Error('Search frame document unavailable')
    }
    // Moving a live IME field into another document can cancel its candidate text.
    if (composing) await new Promise<void>(resolve => { finished = resolve })
    const focused = input.ownerDocument.activeElement === input
    const selection = [input.selectionStart, input.selectionEnd] as const
    child.body.append(input)
    // :focus-within does not cross the iframe document boundary.
    input.addEventListener('focus', () => host.classList.add('search-focused'))
    input.addEventListener('blur', () => host.classList.remove('search-focused'))
    if (focused) {
      input.focus()
      input.setSelectionRange(selection[0], selection[1])
    }
    // Optional web fonts must not hold up the frame's load event or its AX isolation.
    const fonts = child.querySelector<HTMLLinkElement>('link[data-font-href]')
    if (fonts?.dataset.fontHref) fonts.href = fonts.dataset.fontHref
    return child
  } catch (error) {
    // A failed load normally leaves the original field in place. Reinserting it
    // would blur an already focused field even though its position is unchanged.
    if (input.parentElement !== host) host.insertBefore(input, next)
    frame.remove()
    console.warn('[history] Search frame unavailable; keeping the search field in the main document', error)
    return null
  } finally {
    input.removeEventListener('compositionstart', startComposition)
    input.removeEventListener('compositionend', endComposition)
  }
}

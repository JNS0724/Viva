import { t } from '../../shared/i18n/translate.ts'
import { localeRevision } from '../../shared/i18n/locale.ts'
import type { Token, Tokens } from 'marked'
import { lexMarkdown } from './markdown-lexer.ts'
import { h } from './dom.ts'
import { takeReaderControl } from './scroll-follow.ts'

/** Where a link goes, and how a host shows a picture (or null to leave it as a link). */
type Context = { openLink: (url: string) => void, image: ((src: string, alt: string) => HTMLElement | null) | null }

/**
 * Markdown in the agent's answers. marked only parses (its lexer, GitHub flavour); every element is built
 * here with `h`, so text stays text: raw HTML in an answer shows as written, images are not fetched, and a
 * link is a link only to http(s) or mailto, opened outside the app through `openLink`, or to viva:, a place in
 * the app itself (viva://timeline/<segment>/<seq>, from search_conversations), which `openLink` goes to.
 */
const LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'viva:'])
const HEADING_TAGS: Array<'h3' | 'h4' | 'h5'> = ['h3', 'h3', 'h4', 'h5', 'h5', 'h5']

/** The address if it is one the app may open in the browser or mail app, else null. */
export function safeHref(href: unknown): string | null {
  try {
    const url = new URL(String(href ?? ''))
    return LINK_PROTOCOLS.has(url.protocol) ? url.href : null
  } catch {
    return null
  }
}

function link(href: unknown, openLink: Context['openLink']) {
  const target = safeHref(href)
  if (!target) return h('span', { class: 'md-link-off' })
  return h('a', {
    class: 'md-link', href: target, title: target,
    onClick: (event: MouseEvent) => {
      event.preventDefault()
      openLink(target)
    },
  })
}

// Yield child nodes lazily so the same rendering rules can also draw a long answer across frames.
type MarkdownPart = { node: ChildNode, sourceLength?: number }
  | { node: HTMLElement, sourceLength?: number, children: Iterable<MarkdownPart> }

function* inlineParts(tokens: readonly Token[] | undefined, ctx: Context): IterableIterator<MarkdownPart> {
  for (const token of tokens ?? []) {
    const sourceLength = token.raw?.length ?? 0
    switch (token.type) {
      case 'strong':
      case 'em':
      case 'del': yield { node: h(token.type), sourceLength, children: inlineParts(token.tokens, ctx) }; break
      case 'codespan': yield { node: h('code', { class: 'md-code-inline', text: token.text }), sourceLength }; break
      case 'br': yield { node: h('br'), sourceLength }; break
      case 'link': yield { node: link(token.href, ctx.openLink), sourceLength, children: inlineParts(token.tokens, ctx) }; break
      // In answers images are never loaded: the alt text, linked to where the image is. A host that may
      // show them (the 文件 preview, for pictures in the workspace) passes `image`.
      case 'image': {
        const shown = ctx.image?.(token.href, token.text)
        if (shown) yield { node: shown, sourceLength }
        else {
          const label = token.text || token.href
          const fallback = link(token.href, ctx.openLink)
          fallback.textContent = t('files-panel.image', { value1: label })
          fallback.dataset.mdImageLabel = label
          yield { node: fallback, sourceLength }
        }
        break
      }
      case 'text':
        if (token.tokens) yield* inlineParts(token.tokens, ctx)
        else yield { node: document.createTextNode(token.text), sourceLength }
        break
      // escape, html and anything newer: what was written, as text
      default: if (token.raw !== undefined) yield { node: document.createTextNode(token.raw), sourceLength }
    }
  }
}

function* listContents(item: Tokens.ListItem, ctx: Context): IterableIterator<MarkdownPart> {
  if (item.task) yield { node: h('input', { type: 'checkbox', checked: item.checked, disabled: true, 'aria-label': item.checked ? t('island-view.completed') : t('markdown.incomplete') }) }
  for (const token of item.tokens) if (token.type !== 'checkbox') yield* blockParts(token, ctx, !item.loose)
}

function* tableRows(rows: readonly Tokens.TableCell[][], tag: 'th' | 'td', align: Tokens.Table['align'], ctx: Context): IterableIterator<MarkdownPart> {
  function* cells(row: readonly Tokens.TableCell[]): IterableIterator<MarkdownPart> {
    for (const [index, content] of row.entries()) {
      yield { node: h(tag, { class: align[index] ? `md-align-${align[index]}` : null }), children: inlineParts(content.tokens, ctx) }
    }
  }
  for (const row of rows) yield { node: h('tr'), children: cells(row) }
}

function* blockParts(token: Token, ctx: Context, tight = false): IterableIterator<MarkdownPart> {
  switch (token.type) {
    case 'heading': yield { node: h(HEADING_TAGS[token.depth - 1] ?? 'h5', { class: `md-heading md-h${token.depth}` }), children: inlineParts(token.tokens, ctx) }; break
    case 'paragraph': yield { node: h('p'), children: inlineParts(token.tokens, ctx) }; break
    // Inside a tight list item the text is not a paragraph of its own.
    case 'text': {
      const children = inlineParts(token.tokens ?? [token], ctx)
      if (tight) yield* children
      else yield { node: h('p'), children }
      break
    }
    case 'code': yield { node: h('pre', { class: 'md-code' },
      token.lang ? h('span', { class: 'md-code-lang', text: token.lang }) : null,
      h('code', { text: token.text })) }; break
    case 'blockquote': yield { node: h('blockquote'), children: blocks(token.tokens, ctx) }; break
    case 'list': {
      const list = token as Tokens.List
      function* items(): IterableIterator<MarkdownPart> {
        for (const item of list.items) yield { node: h('li', { class: item.task ? 'md-task' : null }), children: listContents(item, ctx) }
      }
      yield { node: h(list.ordered ? 'ol' : 'ul', { start: list.ordered && list.start !== 1 ? list.start : null }), children: items() }
      break
    }
    case 'table': {
      const { header, rows, align } = token as Tokens.Table
      yield { node: h('div', { class: 'md-table-wrap' }), children: [{ node: h('table', { class: 'md-table' }), children: [
        { node: h('thead'), children: tableRows([header], 'th', align, ctx) },
        { node: h('tbody'), children: tableRows(rows, 'td', align, ctx) },
      ] }] }
      break
    }
    case 'hr': yield { node: h('hr') }; break
    case 'space': break
    default: if (token.raw) yield { node: h('p', { text: token.raw }) }
  }
}

function* blocks(tokens: readonly Token[] | undefined, ctx: Context): IterableIterator<MarkdownPart> {
  for (const token of tokens ?? []) yield* blockParts(token, ctx)
}

function buildPart(part: MarkdownPart): ChildNode {
  if ('children' in part) for (const child of part.children) part.node.append(buildPart(child))
  return part.node
}

/**
 * @param text the answer so far (it may stop in the middle of a block while it streams)
 * @param handlers image: shows a picture, or returns null to leave it as a link
 * @returns a `.msg-text.markdown` element
 */
export function renderMarkdown(text: string, { openLink, image = null }: { openLink: Context['openLink'], image?: Context['image'] }): HTMLElement {
  return h('div', { class: 'msg-text markdown' }, [...blocks(lexMarkdown(text), { openLink, image })].map(buildPart))
}

/** A top-level block of an answer: the token marked made of it, and the nodes built for it. */
type BuiltInline = Readonly<{ token: Token, nodes: readonly ChildNode[] }>
type BuiltBlock = BuiltInline & Readonly<{ inline?: readonly BuiltInline[] }>
/**
 * An answer still being typed out, kept between frames (renderer/view/thread.ts): its element, the text drawn, its
 * blocks, and the links it defines (`[x]: url`, which change how any block refers to them).
 */
export type MarkdownStream = Readonly<{ el: HTMLElement, text: string, blocks: readonly BuiltBlock[], links: string }>

/** marked reads `\r\n` as `\n`; the stream does too, so the text compared frame to frame is what marked reads. */
const lineEnds = (text: string) => text.replace(/\r\n?/g, '\n')

/** marked's top-level tokens of `text` and the links they define, or null when their sources do not add up to it. */
function lexed(text: string): { tokens: Token[], links: string } | null {
  const tokens = lexMarkdown(text) as Token[] & { links?: Record<string, unknown> }
  if (tokens.reduce((length, token) => length + token.raw.length, 0) !== text.length) return null
  return { tokens, links: JSON.stringify(tokens.links ?? {}) }
}

/** Whether two tokens are the same in every field, nested tokens, list and table fields included. */
function sameToken(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every((key) => sameToken(left[key], right[key]))
}

/** A fenced or indented code block (marked's token union has a generic member, so the type alone does not narrow it). */
const isCode = (token: Token): token is Tokens.Code => token.type === 'code'
const isParagraph = (token: Token): token is Tokens.Paragraph => token.type === 'paragraph'

/** Keep a growing plain-text run attached, including any selection within its existing characters. */
function grownText(before: BuiltInline | undefined, token: Token | undefined): BuiltInline | null {
  const old = before?.token
  const node = before?.nodes[0]
  if (!before || !old || !token || old.type !== 'text' || token.type !== 'text' || old.tokens || token.tokens
    || before.nodes.length !== 1 || node?.nodeType !== Node.TEXT_NODE || !token.text.startsWith(old.text)) return null
  const text = node as Text
  text.appendData(token.text.slice(old.text.length))
  return { token, nodes: before.nodes }
}

/** Full lexing decides the inline tokens; only the changed suffix of a paragraph needs new nodes. */
function paragraph(token: Tokens.Paragraph, ctx: Context, before?: BuiltBlock): BuiltBlock {
  const el = before ? before.nodes[0] as HTMLElement : h('p')
  const previous = before?.inline ?? []
  const tokens = token.tokens ?? []
  let same = 0
  while (same < previous.length && same < tokens.length && sameToken(previous[same].token, tokens[same])) same++
  const parts = previous.slice(0, same)
  const grown = grownText(previous[same], tokens[same])
  if (grown) {
    parts.push(grown)
    same++
  }
  for (const part of previous.slice(same)) {
    for (const node of part.nodes) node.remove()
  }
  // The streaming caret is owned by thread.ts and stays after the paragraph's text.
  const caret = el.querySelector('.caret')
  for (const next of tokens.slice(same)) {
    const nodes = [...inlineParts([next], ctx)].map(buildPart)
    for (const node of nodes) el.insertBefore(node, caret)
    parts.push({ token: next, nodes })
  }
  return { token, nodes: before?.nodes ?? [el], inline: parts }
}

function built(token: Token, ctx: Context): BuiltBlock {
  if (isParagraph(token)) return paragraph(token, ctx)
  return { token, nodes: [...blockParts(token, ctx)].map(buildPart) }
}

/**
 * Reuse a changing final paragraph's inline prefix, or append to a growing code block before its caret. A long
 * listing keeps its prior nodes during streaming, then is rendered as one text node when the answer ends.
 */
function grown(before: BuiltBlock | undefined, token: Token, ctx: Context): BuiltBlock | null {
  const old = before?.token
  if (before?.inline && old && isParagraph(old) && isParagraph(token)) return paragraph(token, ctx, before)
  if (!before || !old || !isCode(old) || !isCode(token) || (old.lang ?? '') !== (token.lang ?? '') || !token.text.startsWith(old.text)) return null
  const code = (before.nodes[0] as Element | undefined)?.querySelector('code')
  if (!code) return null
  const added = token.text.slice(old.text.length)
  if (added) code.insertBefore(document.createTextNode(added), code.querySelector('.caret'))
  return { token, nodes: before.nodes }
}

/**
 * The answer so far, drawn from where it was last frame. marked lexes the whole text each frame, so what is drawn is
 * what drawing the whole text draws; the frames only share nodes: from the start, a block whose token is the same in
 * every field keeps its nodes. At the changing tail, paragraphs keep equal inline prefixes and code blocks append
 * their added text (grown). Other changed blocks are built again. When the links the answer defines change, nothing
 * is kept. If marked's blocks do not add up to the text, it is drawn whole.
 * @param previous last frame's, of the same answer in the same view
 */
export function streamMarkdown(previous: MarkdownStream | null, input: string, ctx: Context): MarkdownStream {
  const text = lineEnds(input)
  // The same text twice in a frame (thread.ts typeOn, then the view built again) is drawn once.
  if (previous && text === previous.text) return previous
  const el = previous?.el ?? h('div', { class: 'msg-text markdown' })
  const read = lexed(text)
  if (!read) {
    el.replaceChildren(...renderMarkdown(text, ctx).childNodes)
    return { el, text, blocks: [], links: '' }
  }
  const before = previous && previous.links === read.links ? previous.blocks : []
  let same = 0
  while (same < before.length && same < read.tokens.length && sameToken(before[same].token, read.tokens[same])) same += 1
  const blocks = read.tokens.map((token, i) => {
    if (i < same) return before[i]
    return (i === read.tokens.length - 1 && i === same ? grown(before[i], token, ctx) : null) ?? built(token, ctx)
  })
  const wanted = new Set(blocks.flatMap((block) => block.nodes))
  for (const node of [...el.childNodes]) if (!wanted.has(node)) node.remove()
  // In order, moving none that is already in place (a moved node is laid out again).
  let cursor: ChildNode | null = el.firstChild
  for (const node of wanted) {
    if (node === cursor) cursor = cursor.nextSibling
    else el.insertBefore(node, cursor)
  }
  return { el, text, blocks, links: read.links }
}

function lexOffThread(text: string, target: HTMLElement, active: () => boolean): Promise<readonly Token[] | null> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./markdown-worker.js', import.meta.url), { type: 'module' })
    const watcher = new MutationObserver(() => {
      if (!active()) { stop(); resolve(null) }
    })
    const stop = () => { clearTimeout(timer); watcher.disconnect(); worker.terminate() }
    const fail = () => { stop(); reject(new Error('Markdown parsing failed')) }
    const timer = setTimeout(fail, 10_000)
    worker.onmessage = (event: MessageEvent<Token[]>) => { stop(); resolve(event.data) }
    worker.onerror = event => { event.preventDefault(); fail() }
    worker.onmessageerror = fail
    watcher.observe(target.ownerDocument, { childList: true, subtree: true })
    try { worker.postMessage(text) } catch { fail() }
  })
}

/** Same shape and link handler. The renderer always handles the same href with the same answer's openLink. */
function sameElement(previous: ChildNode | null, next: HTMLElement): previous is HTMLElement {
  return previous instanceof HTMLElement && previous.tagName === next.tagName && previous.attributes.length === next.attributes.length
    && [...next.attributes].every(({ name, value }) => previous.getAttribute(name) === value)
}

/** Keep preview slots in place. A different subtree gets built before its old slot is replaced. */
function* revealParts(parent: HTMLElement, parts: Iterable<MarkdownPart>, before: ChildNode | null = null,
  onAdded?: (node: HTMLElement) => void): IterableIterator<void> {
  const last = before ? before.previousSibling : parent.lastChild
  let cursor = parent.firstChild
  let staged: { previous: Text, content: DocumentFragment, sourceLeft: number } | undefined
  function commitStaged() {
    if (staged) staged.previous.replaceWith(staged.content)
    staged = undefined
  }
  for (const part of parts) {
    const { node, sourceLength } = part
    if (staged && sourceLength === undefined) commitStaged()
    // Leave the next preview sibling where it is while accumulating an inline replacement.
    const previous = staged || cursor === before ? null : cursor
    if (previous) cursor = previous.nextSibling
    // A reference defined near the end can turn a preview's plain text node into many inline parts.
    // Hold the old node until the replacement covers the same source span. The rest can still grow in view.
    if (sourceLength !== undefined && previous instanceof Text && sourceLength < previous.length) {
      staged = { previous, content: document.createDocumentFragment(), sourceLeft: previous.length }
    }
    if (staged && sourceLength !== undefined) {
      staged.content.append(node)
      yield
      if ('children' in part) yield* revealParts(part.node, part.children)
      staged.sourceLeft -= sourceLength
      if (staged.sourceLeft <= 0) commitStaged()
      continue
    }
    if (!('children' in part)) {
      if (previous && !previous.isEqualNode(node)) previous.replaceWith(node)
      else if (!previous) {
        parent.insertBefore(node, before)
        if (node instanceof HTMLElement) onAdded?.(node)
      }
      yield
    } else if (sameElement(previous, part.node)) {
      yield* revealParts(previous, part.children, null, previous === last ? onAdded : undefined)
    } else {
      // A new container can grow right where it belongs. Keep a mismatched preview slot until its substitute is ready.
      if (!previous) { parent.insertBefore(part.node, before); onAdded?.(part.node) }
      yield
      yield* revealParts(part.node, part.children)
      if (previous) { previous.replaceWith(part.node); yield }
    }
  }
  if (staged) { commitStaged(); yield }
  while (cursor && cursor !== before) {
    const next = cursor.nextSibling
    cursor.remove()
    cursor = next
    yield
  }
}

export function refreshExpansionLabel(button: HTMLElement, remaining: number) {
  button.textContent = button.getAttribute('aria-disabled') === 'true' ? t('thread.expanding')
    : button.dataset.expandFailed === 'true' ? t('thread.expand.retry')
      : t('thread.expand.remaining', { p0: remaining })
}

const REVEAL_SLICE_MS = 5
// DOM changes also cost layout and accessibility work after this script yields, especially table rows.
const REVEAL_SLICE_NODES = 300

/** Parse the full source together so later reference definitions still affect the opening. */
export async function revealMarkdown(target: HTMLElement, button: HTMLButtonElement, text: string,
  openLink: Context['openLink'], remaining: number) {
  const active = () => target.isConnected && button.parentNode === target
  if (target.getAttribute('aria-busy') === 'true' || !active()) return
  takeReaderControl(target)
  delete button.dataset.expandFailed
  target.setAttribute('aria-busy', 'true')
  button.setAttribute('aria-disabled', 'true')
  refreshExpansionLabel(button, remaining)
  try {
    const tokens = await lexOffThread(text, target, active)
    if (!tokens || !active()) return
    const language = localeRevision()
    let firstAdded: HTMLElement | null = null
    const draw = revealParts(target, blocks(tokens, { openLink, image: null }), button, node => { firstAdded ??= node })
    for (let done = false; !done;) {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
      if (!active()) return
      const until = performance.now() + REVEAL_SLICE_MS
      let remainingNodes = REVEAL_SLICE_NODES
      do { done = draw.next().done === true } while (!done && --remainingNodes > 0 && performance.now() < until)
    }
    if (language !== localeRevision()) refreshMarkdownLanguage(target)
    if (target.ownerDocument.activeElement === button && button.matches(':focus-visible')) {
      const nextFocus = firstAdded ?? button.previousElementSibling ?? target
      if (nextFocus instanceof HTMLElement) {
        const temporaryTabIndex = nextFocus.tabIndex < 0 && !nextFocus.hasAttribute('tabindex')
        if (temporaryTabIndex) nextFocus.tabIndex = -1
        nextFocus.focus({ preventScroll: true })
        if (temporaryTabIndex) {
          const clearTabIndex = () => nextFocus.removeAttribute('tabindex')
          if (target.ownerDocument.activeElement === nextFocus) nextFocus.addEventListener('blur', clearTabIndex, { once: true })
          else clearTabIndex()
        }
      }
    }
    button.remove()
  } catch {
    if (active()) button.dataset.expandFailed = 'true'
  } finally {
    target.removeAttribute('aria-busy')
    button.removeAttribute('aria-disabled')
    if (button.parentNode === target) refreshExpansionLabel(button, remaining)
  }
}

/** Where a typing caret goes: after the last text in the answer, not below it. */
export function caretHost(root: HTMLElement): Element {
  const candidates = root.querySelectorAll('p, li, h3, h4, h5, pre code, td, th')
  return candidates[candidates.length - 1] ?? root
}

/** Localize generated labels without detaching source text, selection ranges or accessibility identities. */
export function refreshMarkdownLanguage(root: HTMLElement): void {
  for (const checkbox of root.querySelectorAll<HTMLInputElement>('input[type="checkbox"][disabled]')) {
    checkbox.setAttribute('aria-label', checkbox.checked ? t("island-view.completed") : t("markdown.incomplete"))
  }
  for (const image of root.querySelectorAll<HTMLElement>('[data-md-image-label]')) {
    image.textContent = t("files-panel.image", { value1: image.dataset.mdImageLabel ?? '' })
  }
}

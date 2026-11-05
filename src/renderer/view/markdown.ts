import { t } from '../../shared/i18n/translate.ts'
// The page imports marked by its file (it has no bundler, and the build copies what is imported this way,
// scripts/build.mjs); marked's types are those of its package, so they are taken from there.
// @ts-expect-error the file has no types of its own beside it
import { Lexer as UntypedLexer } from '../../../node_modules/marked/lib/marked.esm.js'
import type { Lexer as MarkedLexer, Token, Tokens } from 'marked'

const Lexer: typeof MarkedLexer = UntypedLexer
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

function link(href: unknown, children: View, openLink: Context['openLink']) {
  const target = safeHref(href)
  if (!target) return h('span', { class: 'md-link-off' }, children)
  return h('a', {
    class: 'md-link', href: target, title: target,
    onClick: (event: MouseEvent) => {
      event.preventDefault()
      openLink(target)
    },
  }, children)
}

function inline(tokens: readonly Token[] | undefined, ctx: Context): View[] {
  return (tokens ?? []).map((token): View => {
    switch (token.type) {
      case 'strong': return h('strong', null, inline(token.tokens, ctx))
      case 'em': return h('em', null, inline(token.tokens, ctx))
      case 'del': return h('del', null, inline(token.tokens, ctx))
      case 'codespan': return h('code', { class: 'md-code-inline', text: token.text })
      case 'br': return h('br')
      case 'link': return link(token.href, inline(token.tokens, ctx), ctx.openLink)
      // In answers images are never loaded: the alt text, linked to where the image is. A host that may
      // show them (the 文件 preview, for pictures in the workspace) passes `image`.
      case 'image': {
        const shown = ctx.image?.(token.href, token.text)
        if (shown) return shown
        const label = token.text || token.href
        const fallback = link(token.href, t("files-panel.image", { value1: label }), ctx.openLink)
        fallback.dataset.mdImageLabel = label
        return fallback
      }
      case 'text': return token.tokens ? inline(token.tokens, ctx) : token.text
      // escape, html and anything newer: what was written, as text
      default: return token.raw
    }
  })
}

function listItem(item: Tokens.ListItem, ctx: Context) {
  return h('li', { class: item.task ? 'md-task' : null },
    item.task ? h('input', { type: 'checkbox', checked: item.checked, disabled: true, 'aria-label': item.checked ? t("island-view.completed") : t("markdown.incomplete") }) : null,
    ...blocks(item.tokens.filter((token) => token.type !== 'checkbox'), ctx, { tight: !item.loose }).flat())
}

function table(token: Tokens.Table, ctx: Context) {
  const cell = (tag: 'th' | 'td', content: Tokens.TableCell, index: number) => h(tag, { class: token.align[index] ? `md-align-${token.align[index]}` : null }, inline(content.tokens, ctx))
  return h('div', { class: 'md-table-wrap' },
    h('table', { class: 'md-table' },
      h('thead', null, h('tr', null, token.header.map((content, i) => cell('th', content, i)))),
      h('tbody', null, token.rows.map((row) => h('tr', null, row.map((content, i) => cell('td', content, i)))))))
}

function block(token: Token, ctx: Context, { tight }: { tight: boolean }): View {
  switch (token.type) {
    case 'heading': return h(HEADING_TAGS[token.depth - 1] ?? 'h5', { class: `md-heading md-h${token.depth}` }, inline(token.tokens, ctx))
    case 'paragraph': return h('p', null, inline(token.tokens, ctx))
    // Inside a tight list item the text is not a paragraph of its own.
    case 'text': return tight ? inline(token.tokens ?? [token], ctx) : h('p', null, inline(token.tokens ?? [token], ctx))
    case 'code': return h('pre', { class: 'md-code' },
      token.lang ? h('span', { class: 'md-code-lang', text: token.lang }) : null,
      h('code', { text: token.text }))
    case 'blockquote': return h('blockquote', null, blocks(token.tokens, ctx))
    case 'list': return h(token.ordered ? 'ol' : 'ul', { start: token.ordered && token.start !== 1 ? token.start : null },
      (token as Tokens.List).items.map((item) => listItem(item, ctx)))
    // marked's own table token (a generic one could only share its type by name).
    case 'table': return table(token as Tokens.Table, ctx)
    case 'hr': return h('hr')
    case 'space': return null
    default: return token.raw ? h('p', { text: token.raw }) : null
  }
}

function blocks(tokens: readonly Token[] | undefined, ctx: Context, options = { tight: false }): View[] {
  return (tokens ?? []).map((token) => block(token, ctx, options))
}

/**
 * @param text the answer so far (it may stop in the middle of a block while it streams)
 * @param handlers image: shows a picture, or returns null to leave it as a link
 * @returns a `.msg-text.markdown` element
 */
export function renderMarkdown(text: string, { openLink, image = null }: { openLink: Context['openLink'], image?: Context['image'] }): HTMLElement {
  return h('div', { class: 'msg-text markdown' }, blocks(new Lexer({ gfm: true }).lex(text), { openLink, image }))
}

/** A top-level block of an answer: the token marked made of it, and the nodes built for it. */
type BuiltBlock = Readonly<{ token: Token, nodes: readonly ChildNode[] }>
/**
 * An answer still being typed out, kept between frames (renderer/view/thread.ts): its element, the text drawn, its
 * blocks, and the links it defines (`[x]: url`, which change how any block refers to them).
 */
export type MarkdownStream = Readonly<{ el: HTMLElement, text: string, blocks: readonly BuiltBlock[], links: string }>

/** marked reads `\r\n` as `\n`; the stream does too, so the text compared frame to frame is what marked reads. */
const lineEnds = (text: string) => text.replace(/\r\n?/g, '\n')

/** marked's top-level tokens of `text` and the links they define, or null when their sources do not add up to it. */
function lexed(text: string): { tokens: Token[], links: string } | null {
  const tokens = new Lexer({ gfm: true }).lex(text) as Token[] & { links?: Record<string, unknown> }
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

function built(token: Token, ctx: Context): BuiltBlock {
  const holder = h('div', null, block(token, ctx, { tight: false }))
  return { token, nodes: [...holder.childNodes] }
}

/**
 * The last block, when it is the code block drawn there last frame grown longer: its new text goes in as a text node
 * of its own, before the caret (a long listing is neither built nor laid out again; drawn whole once the answer ends,
 * it is one text node again). Null for anything else.
 */
function grown(before: BuiltBlock | undefined, token: Token): BuiltBlock | null {
  const old = before?.token
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
 * every field keeps its nodes, and everything from the first one that differs is built again, except a code block at
 * the end that only grew (grown). When the links the answer defines change, nothing is kept. If marked's blocks do not
 * add up to the text, it is drawn whole.
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
    return (i === read.tokens.length - 1 && i === same ? grown(before[i], token) : null) ?? built(token, ctx)
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

/**
 * Expand a finished answer without detaching its unchanged opening blocks. Parse the whole source first:
 * reference definitions later in the answer can change an earlier block. Only exactly equal blocks keep
 * their nodes, links and accessibility identities; everything from the first difference is replaced.
 * Both renders must use the same handlers (the answer's own openLink closure).
 */
export function expandMarkdown(target: HTMLElement, complete: HTMLElement): void {
  takeReaderControl(target)
  const previous = [...target.childNodes]
  const next = [...complete.childNodes]
  let keep = 0
  while (keep < previous.length && keep < next.length && previous[keep].isEqualNode(next[keep])) keep++
  while (target.childNodes.length > keep) target.lastChild?.remove()
  target.append(...next.slice(keep))
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

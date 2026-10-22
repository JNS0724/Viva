import { Lexer } from '../../../node_modules/marked/lib/marked.esm.js'
import { h } from './dom.ts'

/**
 * Markdown in the agent's answers. marked only parses (its lexer, GitHub flavour); every element is built
 * here with `h`, so text stays text: raw HTML in an answer shows as written, images are not fetched, and a
 * link is a link only to http(s) or mailto, opened outside the app through `openLink`.
 */
const LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])
const HEADING_TAGS: Array<'h3' | 'h4' | 'h5'> = ['h3', 'h3', 'h4', 'h5', 'h5', 'h5']

/** The address if it is one the app may open in the browser or mail app, else null. */
export function safeHref(href) {
  try {
    const url = new URL(String(href ?? ''))
    return LINK_PROTOCOLS.has(url.protocol) ? url.href : null
  } catch {
    return null
  }
}

function link(href, children, openLink) {
  const target = safeHref(href)
  if (!target) return h('span', { class: 'md-link-off' }, children)
  return h('a', {
    class: 'md-link', href: target, title: target,
    onClick: (event) => {
      event.preventDefault()
      openLink(target)
    },
  }, children)
}

function inline(tokens, ctx) {
  return (tokens ?? []).map((token) => {
    switch (token.type) {
      case 'strong': return h('strong', null, inline(token.tokens, ctx))
      case 'em': return h('em', null, inline(token.tokens, ctx))
      case 'del': return h('del', null, inline(token.tokens, ctx))
      case 'codespan': return h('code', { class: 'md-code-inline', text: token.text })
      case 'br': return h('br')
      case 'link': return link(token.href, inline(token.tokens, ctx), ctx.openLink)
      // In answers images are never loaded: the alt text, linked to where the image is. A host that may
      // show them (the 文件 preview, for pictures in the workspace) passes `image`.
      case 'image': return ctx.image?.(token.href, token.text) ?? link(token.href, `[图片：${token.text || token.href}]`, ctx.openLink)
      case 'text': return token.tokens ? inline(token.tokens, ctx) : token.text
      // escape, html and anything newer: what was written, as text
      default: return token.raw ?? token.text ?? ''
    }
  })
}

function listItem(item, ctx) {
  return h('li', { class: item.task ? 'md-task' : null },
    item.task ? h('input', { type: 'checkbox', checked: item.checked, disabled: true, 'aria-label': item.checked ? '已完成' : '未完成' }) : null,
    blocks(item.tokens.filter((token) => token.type !== 'checkbox'), ctx, { tight: !item.loose }))
}

function table(token, ctx) {
  const cell = (tag, content, index) => h(tag, { class: token.align[index] ? `md-align-${token.align[index]}` : null }, inline(content.tokens, ctx))
  return h('div', { class: 'md-table-wrap' },
    h('table', { class: 'md-table' },
      h('thead', null, h('tr', null, token.header.map((content, i) => cell('th', content, i)))),
      h('tbody', null, token.rows.map((row) => h('tr', null, row.map((content, i) => cell('td', content, i)))))))
}

function block(token, ctx, { tight }) {
  switch (token.type) {
    case 'heading': return h(HEADING_TAGS[token.depth - 1] ?? 'h5', { class: `md-heading md-h${token.depth}` }, inline(token.tokens, ctx))
    case 'paragraph': return h('p', null, inline(token.tokens, ctx))
    // Inside a tight list item the text is not a paragraph of its own.
    case 'text': return h(tight ? 'span' : 'p', null, inline(token.tokens ?? [token], ctx))
    case 'code': return h('pre', { class: 'md-code' },
      token.lang ? h('span', { class: 'md-code-lang', text: token.lang }) : null,
      h('code', { text: token.text }))
    case 'blockquote': return h('blockquote', null, blocks(token.tokens, ctx))
    case 'list': return h(token.ordered ? 'ol' : 'ul', { start: token.ordered && token.start !== 1 ? token.start : null },
      token.items.map((item) => listItem(item, ctx)))
    case 'table': return table(token, ctx)
    case 'hr': return h('hr')
    case 'space': return null
    default: return token.raw ? h('p', { text: token.raw }) : null
  }
}

function blocks(tokens, ctx, options = { tight: false }) {
  return (tokens ?? []).map((token) => block(token, ctx, options))
}

/**
 * @param {string} text the answer so far (it may stop in the middle of a block while it streams)
 * @param {{ openLink: (url: string) => void, image?: (src: string, alt: string) => HTMLElement | null }} handlers
 *   image: shows a picture, or returns null to leave it as a link
 * @returns {HTMLElement} a `.msg-text.markdown` element
 */
export function renderMarkdown(text, { openLink, image = null }) {
  return h('div', { class: 'msg-text markdown' }, blocks(new Lexer({ gfm: true }).lex(text), { openLink, image }))
}

/** Where a typing caret goes: after the last text in the answer, not below it. */
export function caretHost(root) {
  const candidates = root.querySelectorAll('p, li > span, h3, h4, h5, pre code, td, th')
  return candidates[candidates.length - 1] ?? root
}

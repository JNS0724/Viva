import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** The renderer's style sheets keep to docs/ui-guidelines.md: colors come from :root, words from the resources. */
const RENDERER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/renderer')
const SHEETS = fs.readdirSync(RENDERER).filter(name => name.endsWith('.css'))
/** The accent, orange and red, which are tokens: alpha variants are color-mix of the token. */
const PALETTE_RGB = /rgba?\(\s*(90,\s*169,\s*255|255,\s*138,\s*61|255,\s*77,\s*94|16,\s*80,\s*181|171,\s*63,\s*3|212,\s*35,\s*54)\b/
const HEX = /#[0-9a-f]{3,8}\b/i
/** Syntax highlighting keeps its own palette (ui-guidelines.md, Color). */
const isHighlightRule = (selector: string) => selector.includes('.hljs')
/** Theme token roots (:root and :root[data-theme="..."]) are the only places raw hex palette definitions belong. */
const isThemeRoot = (selector: string) => /^:root(?:\[data-theme="(?:dark|light)"\])?$/.test(selector)

interface Declaration { sheet: string; selector: string; text: string }

const withoutComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '')

/** Every declaration outside theme token roots, with the selector of the rule it is in. */
function declarations(sheet: string): Declaration[] {
  const css = withoutComments(fs.readFileSync(path.join(RENDERER, sheet), 'utf8'))
  const found: Declaration[] = []
  for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = rule[1].trim()
    if (isThemeRoot(selector)) continue
    for (const text of rule[2].split(';').map(part => part.trim()).filter(Boolean)) found.push({ sheet, selector, text })
  }
  return found
}

function rootTokenValues(selectorTarget: string): Map<string, string> {
  const css = withoutComments(fs.readFileSync(path.join(RENDERER, 'styles.css'), 'utf8'))
  const tokens = new Map<string, string>()
  for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (rule[1].trim() !== selectorTarget) continue
    for (const text of rule[2].split(';').map(part => part.trim()).filter(Boolean)) {
      const colon = text.indexOf(':')
      if (colon <= 0) continue
      const name = text.slice(0, colon).trim()
      const value = text.slice(colon + 1).trim()
      if (name.startsWith('--')) tokens.set(name, value)
    }
  }
  return tokens
}

/** Alpha-only mask-image gradients whose #000 stops supply opacity rather than visible colour. */
const SHARED_MASK_TOKENS = new Set(['--msg-fold-fade', '--scroll-top-fade'])
const THEME_VALUE = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|color-mix)\(|\btransparent\b/i
const THEME_NAME = /(?:^--shadow-|-(?:bg|ink|line|rim|opacity|color)$)/
const VAR_REF = /var\(\s*(--[\w-]+)/g

function themeTokensFrom(base: Map<string, string>): string[] {
  const required = new Set<string>()
  for (const [name, value] of base) {
    if (SHARED_MASK_TOKENS.has(name)) continue
    if (THEME_VALUE.test(value) || THEME_NAME.test(name)) required.add(name)
  }
  let added = true
  while (added) {
    added = false
    for (const [name, value] of base) {
      if (SHARED_MASK_TOKENS.has(name) || required.has(name)) continue
      for (const [, ref] of value.matchAll(VAR_REF)) {
        if (required.has(ref)) {
          required.add(name)
          added = true
          break
        }
      }
    }
  }
  return [...required]
}

const all = SHEETS.flatMap(declarations)
const describe = ({ sheet, selector, text }: Declaration) => `${sheet}: ${selector} { ${text} }`
const valueOf = (text: string) => text.replace(/^[\w-]+\s*:/, '')

test('the renderer has style sheets to check', () => {
  assert.ok(SHEETS.includes('styles.css') && SHEETS.includes('island.css'), SHEETS.join(', '))
  assert.ok(all.length > 500, `only ${all.length} declarations were read`)
})

test('no style sheet writes words into content, so every word on screen can be translated', () => {
  const worded = all.filter(({ text }) => /^content\s*:/.test(text) && /(['"])[^'"]*\p{L}[^'"]*\1/u.test(text))
  assert.deepEqual(worded.map(describe), [])
})

test('colors outside :root are tokens, not raw hex values', () => {
  const raw = all.filter(({ selector, text }) => !isHighlightRule(selector) && /^[\w-]+\s*:/.test(text) && HEX.test(valueOf(text)))
  assert.deepEqual(raw.map(describe), [])
})

test('alpha variants of the accent, orange and red are mixed from their tokens', () => {
  const raw = all.filter(({ text }) => PALETTE_RGB.test(text))
  assert.deepEqual(raw.map(describe), [])
})

test('light theme overrides every theme-dependent token defined on :root', () => {
  const base = rootTokenValues(':root')
  const light = rootTokenValues(':root[data-theme="light"]')
  const required = themeTokensFrom(base)
  assert.ok(required.length >= 30, `expected at least 30 theme tokens on :root, found ${required.length}`)
  const missing = required.filter((token) => !light.has(token))
  const unknown = [...light.keys()].filter((token) => !base.has(token))
  assert.deepEqual(missing, [])
  assert.deepEqual(unknown, [])

  const synthetic = new Map(base)
  synthetic.set('--layout-alias', 'var(--desk-gap)')
  synthetic.set('--palette-alias', 'var(--panel)')
  const syntheticRequired = new Set(themeTokensFrom(synthetic))
  assert.equal(syntheticRequired.has('--layout-alias'), false)
  assert.equal(syntheticRequired.has('--palette-alias'), true)
})

test('every bundled @font-face asset and OFL license exists locally, and HTML CSPs forbid external font hosts', () => {
  const fontsCss = fs.readFileSync(path.join(RENDERER, 'fonts.css'), 'utf8')
  const urls = [...fontsCss.matchAll(/url\('(\.\/fonts\/[^']+\.woff2)'\)/g)].map(match => match[1]!)
  assert.ok(urls.length >= 100, `expected bundled variable font slices in fonts.css, found ${urls.length}`)
  for (const rel of urls) {
    const file = path.resolve(RENDERER, rel)
    assert.ok(fs.existsSync(file) && fs.statSync(file).size > 0, `missing or empty bundled font: ${rel}`)
  }
  const ofl = path.join(RENDERER, 'fonts', 'OFL.txt')
  assert.ok(fs.existsSync(ofl) && fs.readFileSync(ofl, 'utf8').includes('SIL OPEN FONT LICENSE'), 'missing OFL.txt license bundle')

  for (const page of ['index.html', 'desk.html', 'history-search-frame.html']) {
    const html = fs.readFileSync(path.join(RENDERER, page), 'utf8')
    assert.ok(html.includes('href="./fonts.css"'), `${page} must load ./fonts.css`)
    assert.ok(html.includes("style-src 'self';") && html.includes("font-src 'self'"), `${page} CSP must restrict style-src and font-src to 'self'`)
    assert.ok(!/fonts\.googleapis\.com|fonts\.gstatic\.com/.test(html), `${page} must not reference external Google Fonts hosts`)
  }
})

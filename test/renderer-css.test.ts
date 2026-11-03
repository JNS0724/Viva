import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** The renderer's style sheets keep to docs/ui-guidelines.md: colors come from :root, words from the resources. */
const RENDERER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/renderer')
const SHEETS = fs.readdirSync(RENDERER).filter(name => name.endsWith('.css'))
/** The accent, orange and red, which are tokens: alpha variants are color-mix of the token. */
const PALETTE_RGB = /rgba?\(\s*(90,\s*169,\s*255|255,\s*138,\s*61|255,\s*77,\s*94)\b/
const HEX = /#[0-9a-f]{3,8}\b/i
/** Syntax highlighting keeps its own palette (ui-guidelines.md, Color). */
const isHighlightRule = (selector: string) => selector.includes('.hljs')

interface Declaration { sheet: string; selector: string; text: string }

const withoutComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '')

/** Every declaration outside :root, with the selector of the rule it is in. */
function declarations(sheet: string): Declaration[] {
  const css = withoutComments(fs.readFileSync(path.join(RENDERER, sheet), 'utf8'))
  const found: Declaration[] = []
  for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = rule[1].trim()
    if (selector === ':root') continue
    for (const text of rule[2].split(';').map(part => part.trim()).filter(Boolean)) found.push({ sheet, selector, text })
  }
  return found
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

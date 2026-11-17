import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { scratch } from './fixtures/scratch.js'

test('Windows Git checkout preserves the frozen validation source bytes', t => {
  const { dir } = scratch(t, 'viva-validation-checkout-')
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' })
  git('init', '--quiet')
  const attributes = new URL('../.gitattributes', import.meta.url)
  if (existsSync(attributes)) copyFileSync(attributes, path.join(dir, '.gitattributes'))
  mkdirSync(path.join(dir, 'test/fixtures'), { recursive: true })
  const file = 'test/fixtures/memory-file-validation.ts'
  const original = readFileSync(new URL('./fixtures/memory-file-validation.ts', import.meta.url))
  writeFileSync(path.join(dir, file), original)
  writeFileSync(path.join(dir, 'control.ts'), 'export const value = 1\n')
  git('-c', 'core.autocrlf=false', 'add', '.')
  git('-c', 'core.autocrlf=true', '-c', 'core.eol=crlf', 'checkout-index', '--all', '--prefix=checkout/')
  assert.equal(readFileSync(path.join(dir, 'checkout/control.ts'), 'utf8'), 'export const value = 1\r\n')
  assert.equal(readFileSync(path.join(dir, 'checkout', file)).equals(original), true,
    'Git checkout must retain the original frozen bytes even when other source files use CRLF')
})

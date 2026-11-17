import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { copyPageLibraryPackages } from '../scripts/build.ts'

for (const name of ['shared-parser', '@example/shared-parser']) test(`built renderer file import and Node bare import both resolve ${name}`, t => {
  const root = mkdtempSync(path.join(tmpdir(), 'viva-build-package-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const output = path.join(root, 'out'), relative = path.join('node_modules', ...name.split('/'))
  const put = (file: string, value: string) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, value) }
  put(path.join(root, relative, 'package.json'), JSON.stringify({ name, type: 'module', exports: './node.mjs' }))
  put(path.join(root, relative, 'browser.mjs'), 'export const value = "renderer"')
  put(path.join(root, relative, 'node.mjs'), 'import { suffix } from "./support/suffix.mjs"; export const value = "node" + suffix')
  put(path.join(root, relative, 'support/suffix.mjs'), 'export const suffix = "-complete"')
  put(path.join(root, relative, 'LICENSE'), 'fixture license')
  const packages = copyPageLibraryPackages(root, output, [path.join(relative, 'browser.mjs'), path.join(relative, 'browser.mjs')])
  assert.deepEqual(packages, [relative])
  assert.equal(readFileSync(path.join(output, relative, 'LICENSE'), 'utf8'), 'fixture license')
  const entry = path.join(output, 'verify.mjs')
  put(entry, `import { value as renderer } from './node_modules/${name}/browser.mjs';\nimport { value as backend } from '${name}';\nconsole.log(JSON.stringify({ renderer, backend }));`)
  assert.deepEqual(JSON.parse(execFileSync(process.execPath, [entry], { encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })),
    { renderer: 'renderer', backend: 'node-complete' })
})

test('page library copying rejects paths outside an installed package', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'viva-build-package-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const invalid of ['elsewhere/file.js', '../node_modules/library/file.js', 'node_modules/../file.js', 'node_modules/@scope/file.js']) {
    assert.throws(() => copyPageLibraryPackages(root, path.join(root, 'out'), [invalid.split('/').join(path.sep)]))
  }
})

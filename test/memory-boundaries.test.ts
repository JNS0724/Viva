import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cpSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import ts from 'typescript'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const memory = join(root, 'src/memory')
const require = createRequire(import.meta.url)

test('memory contracts/core/node obey the declared dependency direction, including type imports', () => {
  const files = readdirSync(memory, { recursive: true }).filter((file): file is string => typeof file === 'string' && file.endsWith('.ts'))
  for (const file of files) {
    const full = join(memory, file)
    const source = ts.createSourceFile(file, readFileSync(full, 'utf8'), ts.ScriptTarget.Latest, true)
    const imports: string[] = []
    const visit = (node: ts.Node): void => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text)
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) imports.push(node.arguments[0].text)
      ts.forEachChild(node, visit)
    }
    visit(source)
    const layer = file.split(/[\\/]/u)[0]
    for (const imported of imports) {
      if (!imported.startsWith('.')) {
        assert.ok(imported === 'zod' || imported === 'yaml' || imported === 'marked' && file.replaceAll('\\', '/') === 'core/memory-markdown.ts' || layer === 'node' && imported.startsWith('node:'), `${file}: forbidden dependency ${imported}`)
        continue
      }
      const target = relative(memory, resolve(dirname(full), imported)).replaceAll('\\', '/')
      // Shared diagnostics is below the domain and has no product or runtime-framework imports.
      // Keep this exception file-specific: Core must never acquire the Node logger or Pino.
      if (['../diagnostics/contracts.ts', '../diagnostics/operation.ts'].includes(target) || layer === 'node' && target === '../diagnostics/node/context.ts') continue
      assert.ok(!target.startsWith('../'), `${file}: dependency escapes memory module: ${imported}`)
      if (layer === 'contracts') assert.ok(target.startsWith('contracts/'), `${file}: contracts depend on ${target}`)
      if (layer === 'core') assert.ok(!target.startsWith('node/'), `${file}: core depends on storage implementation ${target}`)
    }
  }
})

test('shared diagnostic contracts are portable and diagnostic infrastructure never depends on product code', () => {
  const dir = join(root, 'src/diagnostics')
  for (const file of readdirSync(dir, { recursive: true }).filter((file): file is string => typeof file === 'string' && file.endsWith('.ts'))) {
    const full = join(dir, file)
    const source = ts.createSourceFile(file, readFileSync(full, 'utf8'), ts.ScriptTarget.Latest, true)
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const dependency = node.moduleSpecifier.text
        if (file === 'contracts.ts') assert.fail(`portable diagnostic port imports ${dependency}`)
        if (!file.replaceAll('\\', '/').startsWith('node/')) {
          assert.ok(dependency.startsWith('.') && !relative(dir, resolve(dirname(full), dependency)).replaceAll('\\', '/').startsWith('node/'), `${file} imports a runtime adapter`)
        }
        if (dependency.startsWith('.')) assert.ok(!relative(dir, resolve(dirname(full), dependency)).startsWith('..'), `${file} depends on product code`)
        else assert.ok(dependency.startsWith('node:') || ['pino', 'sonic-boom', 'yazl'].includes(dependency), `${file} imports ${dependency}`)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
})

test('copied Node memory runs in a clean project without Viva, DSH or Electron installed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'viva-memory-standalone-'))
  try {
    cpSync(memory, join(dir, 'src/memory'), { recursive: true })
    mkdirSync(join(dir, 'src/diagnostics/node'), { recursive: true })
    for (const file of ['contracts.ts', 'operation.ts', 'node/context.ts']) cpSync(join(root, 'src/diagnostics', file), join(dir, 'src/diagnostics', file))
    mkdirSync(join(dir, 'test/fixtures'), { recursive: true })
    cpSync(join(root, 'test/fixtures/memory-standalone.ts'), join(dir, 'test/fixtures/memory-standalone.ts'))
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
    for (const dependency of ['zod', 'yaml', 'marked']) {
      const packageRoot = dirname(require.resolve(`${dependency}/package.json`))
      cpSync(realpathSync(packageRoot), join(dir, 'node_modules', dependency), { recursive: true })
    }
    const output = execFileSync(process.env.npm_node_execpath ?? 'node', ['test/fixtures/memory-standalone.ts'], {
      cwd: dir, encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, NODE_PATH: '', ELECTRON_RUN_AS_NODE: '1' },
    })
    assert.match(output, /"standalone":true/u)
    assert.match(output, /"durableErasure":true/u)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ts from 'typescript'

const root = path.resolve(import.meta.dirname, '..')
const source = path.join(root, 'src')
const nameOf = (file: string) => path.relative(root, file).split(path.sep).join('/')

/** Include type dependencies: a view's contract must not pull in the executable application entry. */
function imports(file: string): string[] {
  const ast = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const specs: string[] = []
  const visit = (node: ts.Node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) specs.push(node.moduleSpecifier.text)
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) specs.push(node.arguments[0].text)
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) specs.push(node.argument.literal.text)
    ts.forEachChild(node, visit)
  }
  visit(ast)
  return specs.filter(s => s.startsWith('.')).map(s => path.resolve(path.dirname(file), s))
}

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(file)
    return entry.isFile() && /\.(ts|js)$/.test(file) && !file.endsWith('.d.ts') ? [file] : []
  })
}

const graphOf = (dirs: string[]) => new Map(dirs.flatMap(sourceFiles).map(file => [file, imports(file)]))
const graph = graphOf([source, path.join(root, 'plugins')])

function entryImports(graph: Map<string, string[]>, source: string): string[] {
  const entry = path.join(source, 'renderer', 'app.ts')
  const compose = path.join(source, 'backend', 'compose.ts')
  const server = path.join(source, 'backend', 'server.ts')
  return [...graph].flatMap(([file, deps]) => deps.filter(dep => dep === entry || (dep === compose && file !== server)).map(dep => `${nameOf(file)} -> ${nameOf(dep)}`))
}

test('features and bundled plugins never import the application composition roots, even for types', () => {
  const offenders = entryImports(graph, source)
  assert.deepEqual(offenders, [], 'pass a capability or move the shared contract out of the entry module')
})

function cyclesIn(graph: Map<string, string[]>): string[] {
  const visited = new Set<string>(), active = new Set<string>(), stack: string[] = []
  const cycles: string[] = []
  function visit(file: string) {
    if (active.has(file)) { cycles.push([...stack.slice(stack.indexOf(file)), file].map(nameOf).join(' -> ')); return }
    if (visited.has(file)) return
    visited.add(file); active.add(file); stack.push(file)
    for (const dep of graph.get(file) ?? []) if (graph.has(dep)) visit(dep)
    stack.pop(); active.delete(file)
  }
  for (const file of graph.keys()) visit(file)
  return cycles
}

test('application and bundled plugin modules form an acyclic graph, including type imports and re-exports', () => {
  const cycles = cyclesIn(graph)
  assert.deepEqual(cycles, [], 'give shared contracts a dependency-neutral module instead of adding a back-reference')
})

test('the guard follows a plugin back into the app instead of stopping at the src boundary', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viva-module-boundaries-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const src = path.join(dir, 'src'), plugins = path.join(dir, 'plugins')
  fs.mkdirSync(path.join(src, 'backend'), { recursive: true }); fs.mkdirSync(plugins)
  fs.writeFileSync(path.join(src, 'backend', 'compose.ts'), "import { value } from '../../plugins/x.ts'\nexport type Config = object\nvoid value\n")
  fs.writeFileSync(path.join(plugins, 'x.ts'), "import type { Config } from '../src/backend/compose.ts'\nexport const value: Config = {}\n")
  const complete = graphOf([src, plugins])
  assert.equal(cyclesIn(complete).length, 1, 'the app -> plugin -> app cycle must be found')
  assert.equal(entryImports(complete, src).length, 1, 'a plugin may not import the composition root, even for a type')
})

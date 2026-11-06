import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
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

const files = fs.readdirSync(source, { recursive: true }).filter((f): f is string => typeof f === 'string' && /\.(ts|js)$/.test(f) && !f.endsWith('.d.ts')).map(f => path.join(source, f))
const graph = new Map(files.map(file => [file, imports(file)]))

test('feature modules never import the application composition roots, even for types', () => {
  const entry = path.join(source, 'renderer', 'app.ts')
  const compose = path.join(source, 'backend', 'compose.ts')
  const server = path.join(source, 'backend', 'server.ts')
  const offenders = [...graph].flatMap(([file, deps]) => deps.filter(dep => dep === entry || (dep === compose && file !== server)).map(dep => `${nameOf(file)} -> ${nameOf(dep)}`))
  assert.deepEqual(offenders, [], 'pass a capability or move the shared contract out of the entry module')
})

test('source modules form an acyclic dependency graph, including type imports and re-exports', () => {
  const visited = new Set<string>(), active = new Set<string>(), stack: string[] = []
  const cycles: string[] = []
  function visit(file: string) {
    if (active.has(file)) { cycles.push([...stack.slice(stack.indexOf(file)), file].map(nameOf).join(' -> ')); return }
    if (visited.has(file)) return
    visited.add(file); active.add(file); stack.push(file)
    for (const dep of graph.get(file) ?? []) if (graph.has(dep)) visit(dep)
    stack.pop(); active.delete(file)
  }
  for (const file of files) visit(file)
  assert.deepEqual(cycles, [], 'give shared contracts a dependency-neutral module instead of adding a back-reference')
})

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { buildRevision, writeBuildRevision } from './build-revision.ts'

const project = path.resolve(import.meta.dirname, '..')
const require = createRequire(import.meta.url)
type Manifest = { name: string, version: string, dependencies?: Record<string, string>, peerDependencies?: Record<string, string>, [key: string]: unknown }

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name)
    return entry.isDirectory() ? files(file) : entry.isFile() ? [file] : []
  })
}
const within = (root: string, file: string) => { const rel = path.relative(root, file); return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel) }
const packageName = (specifier: string) => specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]!

/** Copy compiled plugin/core code into one installable payload, rejecting repo-only dependencies. */
export function assembleMemoryPlugin({ compiledRoot, destination, manifestFile = path.join(project, 'plugins/memory/package.json') }: {
  compiledRoot: string, destination: string, manifestFile?: string,
}) {
  compiledRoot = path.resolve(compiledRoot)
  destination = path.resolve(destination)
  if (within(destination, compiledRoot) || within(compiledRoot, destination) || destination === path.join(project, 'build') || (within(project, destination) && !within(path.join(project, 'build'), destination))) {
    throw new Error('Memory artifact must be outside source and compilation directories')
  }
  const plugin = path.join(compiledRoot, 'plugins/memory')
  const memory = path.join(compiledRoot, 'src/memory')
  const diagnostics = path.join(compiledRoot, 'src/diagnostics')
  const shared = path.join(compiledRoot, 'src/shared')
  const sharedFiles = ['request-budget.js', 'node/tool-call-budget.js', 'node/native-output-receipts.js'].map(file => path.join(shared, file))
  if (!existsSync(path.join(plugin, 'index.js')) || !existsSync(path.join(memory, 'node/index.js'))) throw new Error('Compile memory and its plugin before assembly')
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as Manifest
  const declared = new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})])
  const targetOf = (file: string): string => {
    if (within(plugin, file)) return path.join(destination, path.relative(plugin, file))
    if (within(memory, file)) return path.join(destination, 'memory', path.relative(memory, file))
    if (within(diagnostics, file)) return path.join(destination, 'diagnostics', path.relative(diagnostics, file))
    if (sharedFiles.includes(file)) return path.join(destination, 'shared', path.relative(shared, file))
    throw new Error(`Memory plugin depends on a repository-only module: ${path.relative(compiledRoot, file)}`)
  }
  const sources = [...files(plugin), ...files(memory), ...sharedFiles.filter(file => existsSync(file)), ...(existsSync(diagnostics) ? files(diagnostics) : [])].filter(file => file.endsWith('.js'))
  const sourceSet = new Set(sources.map(file => path.resolve(file)))
  const output = sources.map(file => {
    const target = targetOf(file)
    const text = readFileSync(file, 'utf8')
    const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
    const edits: { start: number, end: number, value: string }[] = []
    const inspect = (literal: ts.StringLiteral) => {
      const specifier = literal.text
      if (!specifier.startsWith('.')) {
        if (!specifier.startsWith('node:') && !declared.has(packageName(specifier))) throw new Error(`Undeclared dependency ${specifier} in ${file}`)
        return
      }
      const sourceTarget = path.resolve(path.dirname(file), specifier)
      if (!sourceSet.has(sourceTarget)) throw new Error(`Missing compiled dependency ${specifier} in ${file}`)
      const rewritten = path.relative(path.dirname(target), targetOf(sourceTarget)).split(path.sep).join('/')
      edits.push({ start: literal.getStart(ast), end: literal.end, value: JSON.stringify(rewritten.startsWith('.') ? rewritten : './' + rewritten) })
    }
    const visit = (node: ts.Node): void => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) inspect(node.moduleSpecifier)
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const argument = node.arguments[0]
        if (argument && ts.isStringLiteral(argument)) inspect(argument)
        else if (path.relative(memory, file).split(path.sep).join('/') !== 'node/memory-embedder-worker.js'
          || !['pathToFileURL(entry).href', '__rewriteRelativeImportExtension(pathToFileURL(entry).href)'].includes(argument?.getText(ast) ?? '')) {
          throw new Error(`Nonliteral dynamic import in ${file}`)
        }
        // The one configured-resource boundary resolves Transformers from trusted runtimeRoot.
        // It is intentionally not a repository-relative module or a startup model download.
      }
      ts.forEachChild(node, visit)
    }
    visit(ast)
    let rewritten = text
    for (const edit of edits.sort((a, b) => b.start - a.start)) rewritten = rewritten.slice(0, edit.start) + edit.value + rewritten.slice(edit.end)
    return { target, text: rewritten }
  })
  // Validate the whole graph before replacing a previous artifact.
  rmSync(destination, { recursive: true, force: true })
  for (const item of output) { mkdirSync(path.dirname(item.target), { recursive: true }); writeFileSync(item.target, item.text) }
  writeFileSync(path.join(destination, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
  const license = path.join(project, 'LICENSE')
  if (existsSync(license)) cpSync(license, path.join(destination, 'LICENSE'))
  writeFileSync(path.join(destination, 'README.md'), [
    '# Viva memory for DSH', '',
    'Install this package into a DSH 0.2.2-rc.2 server. A supervised owner process stores memory in ordinary Node. The dsh plugin handles native sessions and model calls.',
    'Keep the memory, native sessions and projection storage in private absolute directories. Every process that uses these sessions must use the same persistence entry. The entry takes the session root lease, finishes pending cold erasure, and starts the owner before publishing DSH persistence.',
    'The host must disable session-log-deepseek (config.enabled: false). Unsupported model transports fail closed.',
    '', 'Example DSH profile patch (substitute the existing absolute session and storage roots for your private profile):', '',
    '```yaml', '- id: session-log-deepseek', '  config:', '    enabled: false',
    '- id: session-persistence-jsonl', '  disabled: true', '- insert:',
    '    - id: viva-memory-session-persistence', '      name: viva-memory/persistence', '      config:',
    '        root: /absolute/private/dsh/sessions', '        memoryRoot: /absolute/private/memory',
    '    - id: portable-memory', '      name: viva-memory', '      inject: [sessionPersistence]', '      config:',
    '        dataRoot: /absolute/private/memory', '        dailyNotes: true', '```', '',
    'Use `/memory-remember <text>` to save an entry and `/memory-forget <id>` to forget an entry by its saved or recalled ID.',
    'DSH Web 0.2.2-rc.2 shows command receipts once a conversation has a normal turn. The receipt reports when copy cleanup is still pending.',
    '',
    'Local embedding assets are optional external resources supplied by modelRoot/runtimeRoot configuration; this package never downloads models on startup.',
    'Dedicated Web management pages are a separate later phase.', '',
  ].join('\n'))
  return { destination, modules: output.length }
}

export function buildMemoryPlugin({ destination = path.join(project, 'build/memory-plugin'), compiledRoot = path.join(project, 'build/memory-plugin-code') }: { destination?: string, compiledRoot?: string } = {}) {
  compiledRoot = path.resolve(compiledRoot)
  destination = path.resolve(destination)
  if (within(compiledRoot, project) || compiledRoot === path.join(project, 'build') || (within(project, compiledRoot) && !within(path.join(project, 'build'), compiledRoot)) || within(destination, compiledRoot) || within(compiledRoot, destination)) {
    throw new Error('Memory compilation must use a separate temporary or build directory')
  }
  rmSync(compiledRoot, { recursive: true, force: true })
  const tsc = require.resolve('typescript/bin/tsc')
  execFileSync(process.execPath, [tsc, '-p', path.join(project, 'tsconfig.memory-plugin.json'), '--outDir', compiledRoot], { cwd: project, stdio: 'inherit' })
  writeBuildRevision(compiledRoot, buildRevision(project))
  return assembleMemoryPlugin({ compiledRoot, destination })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 3) throw new Error('Usage: node scripts/build-memory-plugin.ts [destination]')
  console.log(JSON.stringify(buildMemoryPlugin({ destination: process.argv[2] ? path.resolve(process.argv[2]) : undefined })))
}

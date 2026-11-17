// npm run build: the app as it runs (package.json `main`), in out/, laid out like the repository (out/src, out/plugins),
// so the code's relative imports between src/ and plugins/ hold in both places.
//
// 1. tsc writes the code out (tsconfig.build.json); `npm run typecheck` is what checks it.
// 2. What tsc leaves alone goes as it is: pages, styles, pictures, the plugins' package.json (dsh reads them).
// 3. A library the pages import straight from node_modules (they have no bundler) is copied to out/node_modules at
//    the same place, including its complete package. Node bare imports must resolve there too;
//    a file-only shadow package would prevent lookup in the project node_modules beside out/.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(import.meta.dirname, '..')
const OUT = path.join(ROOT, 'out')
const SOURCES = ['src', 'plugins']
const PAGES = path.join(ROOT, 'src', 'renderer')
/** What tsc writes out; everything else is copied. */
const CODE = /\.[cm]?[jt]s$/
const PAGE_LIBRARY = /from '((?:\.\.\/)+node_modules\/[^']+)'/g
const ENTRY = path.join(OUT, 'src', 'shell', 'main.js')

/** Files under `dir`, relative to ROOT; a plugin's own node_modules is not the app's. */
function filesIn(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : filesIn(full)
    return entry.isFile() ? [path.relative(ROOT, full)] : []
  })
}

function copy(rel: string) {
  const target = path.join(OUT, rel)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.copyFileSync(path.join(ROOT, rel), target)
}

function emitCode() {
  const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc')
  execFileSync(process.execPath, [tsc, '-p', 'tsconfig.build.json'], { cwd: ROOT, stdio: 'inherit' })
}

/** The node_modules files the pages import, relative to ROOT. */
function pageLibraries(): string[] {
  const found = filesIn(PAGES).filter((rel) => /\.[jt]s$/.test(rel)).flatMap((rel) => {
    const source = fs.readFileSync(path.join(ROOT, rel), 'utf8')
    return [...source.matchAll(PAGE_LIBRARY)].map((match) => path.relative(ROOT, path.resolve(ROOT, path.dirname(rel), match[1]!)))
  })
  const outside = found.filter((rel) => !rel.startsWith(`node_modules${path.sep}`))
  if (outside.length) throw new Error(`a page imports from outside the project's node_modules: ${outside.join(', ')}`)
  return [...new Set(found)]
}

/** Copy only installed packages explicitly used by a renderer file import, preserving exports and assets. */
export function copyPageLibraryPackages(root: string, output: string, libraries: readonly string[]): string[] {
  const packages = new Set<string>()
  for (const library of libraries) {
    const parts = library.split(path.sep)
    if (parts[0] !== 'node_modules' || !parts[1] || parts.some(part => !part || part === '.' || part === '..')) {
      throw new Error(`invalid page library path: ${library}`)
    }
    const count = parts[1].startsWith('@') ? 3 : 2
    if (parts.length <= count || !parts[count - 1]) throw new Error(`invalid page library package: ${library}`)
    packages.add(path.join(...parts.slice(0, count)))
  }
  for (const relative of packages) {
    const source = path.join(root, relative)
    // A package manifest is essential: an incomplete shadow directory breaks Node resolution.
    if (!fs.statSync(path.join(source, 'package.json')).isFile()) throw new Error(`missing package manifest: ${relative}`)
    fs.cpSync(source, path.join(output, relative), { recursive: true, dereference: true })
  }
  return [...packages]
}

function build() {
  fs.rmSync(OUT, { recursive: true, force: true })
  emitCode()
  const assets = SOURCES.flatMap((dir) => filesIn(path.join(ROOT, dir))).filter((rel) => !CODE.test(rel))
  assets.forEach(copy)
  const libraries = pageLibraries()
  const packages = copyPageLibraryPackages(ROOT, OUT, libraries)
  if (!fs.existsSync(ENTRY)) throw new Error(`the build has no ${path.relative(ROOT, ENTRY)}`)
  console.log(`[build] out/: code from tsc, ${assets.length} other files, ${packages.length} page library packages (${packages.join(', ')})`)
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) build()

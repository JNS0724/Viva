// npm run build: the app as it runs (package.json `main`), in out/, laid out like the repository (out/src, out/plugins),
// so the code's relative imports between src/ and plugins/ hold in both places.
//
// 1. tsc writes the code out (tsconfig.build.json); `npm run typecheck` is what checks it.
// 2. What tsc leaves alone goes as it is: pages, styles, pictures, the plugins' package.json (dsh reads them).
// 3. A library the pages import straight from node_modules (they have no bundler) is copied to out/node_modules at
//    the same place, so one relative path works from src/ and from out/. The project's node_modules (beside out/)
//    serves everything else, by Node's own lookup.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const OUT = path.join(ROOT, 'out')
const SOURCES = ['src', 'plugins']
const PAGES = path.join(ROOT, 'src', 'renderer')
/** What tsc writes out; everything else is copied. */
const CODE = /\.[cm]?[jt]s$/
const PAGE_LIBRARY = /from '((?:\.\.\/)+node_modules\/[^']+)'/g
const ENTRY = path.join(OUT, 'src', 'main', 'main.js')

/** Files under `dir`, relative to ROOT; a plugin's own node_modules is not the app's. */
function filesIn(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : filesIn(full)
    return entry.isFile() ? [path.relative(ROOT, full)] : []
  })
}

function copy(rel) {
  const target = path.join(OUT, rel)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.copyFileSync(path.join(ROOT, rel), target)
}

function emitCode() {
  const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc')
  execFileSync(process.execPath, [tsc, '-p', 'tsconfig.build.json'], { cwd: ROOT, stdio: 'inherit' })
}

/** The node_modules files the pages import, relative to ROOT. */
function pageLibraries() {
  const found = filesIn(PAGES).filter((rel) => /\.[jt]s$/.test(rel)).flatMap((rel) => {
    const source = fs.readFileSync(path.join(ROOT, rel), 'utf8')
    return [...source.matchAll(PAGE_LIBRARY)].map((match) => path.relative(ROOT, path.resolve(ROOT, path.dirname(rel), match[1])))
  })
  const outside = found.filter((rel) => !rel.startsWith(`node_modules${path.sep}`))
  if (outside.length) throw new Error(`a page imports from outside the project's node_modules: ${outside.join(', ')}`)
  return [...new Set(found)]
}

fs.rmSync(OUT, { recursive: true, force: true })
emitCode()
const assets = SOURCES.flatMap((dir) => filesIn(path.join(ROOT, dir))).filter((rel) => !CODE.test(rel))
assets.forEach(copy)
const libraries = pageLibraries()
libraries.forEach(copy)
if (!fs.existsSync(ENTRY)) throw new Error(`the build has no ${path.relative(ROOT, ENTRY)}`)
console.log(`[build] out/: code from tsc, ${assets.length} other files, ${libraries.length} page libraries (${libraries.join(', ')})`)

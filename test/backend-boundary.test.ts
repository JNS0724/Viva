import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

/**
 * The backend reaches Electron only through HostCapabilities (src/backend/host.ts): no module it loads imports
 * `electron` at run time (docs/backend-split-design.md D1, D2). `import type` is erased and does not count.
 */
const ROOT = path.join(import.meta.dirname, '..')
/** The backend process's entry (server.ts), which loads compose.ts and everything it does. */
const ENTRY = path.join(ROOT, 'src', 'backend', 'server.ts')

/** The specifiers a module imports at run time: static imports and re-exports that are not type-only. */
function runtimeImports(file: string): string[] {
  const text = fs.readFileSync(file, 'utf8')
  const statements = [...text.matchAll(/^\s*(import|export)\s+(?!type\s)([^'";]*?)\s*from\s*['"]([^'"]+)['"]/gm)]
  const bare = [...text.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)].map((match) => match[1])
  const dynamic = [...text.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1])
  return [...statements.filter((match) => !/^\{\s*type\s[^}]*\}$/.test(match[2].trim()) || match[2].includes(',')).map((match) => match[3]), ...bare, ...dynamic]
}

/** Every source file the backend loads, from its entry, following relative imports. */
function backendTree(entry: string): Map<string, string[]> {
  const seen = new Map<string, string[]>()
  const queue = [entry]
  while (queue.length) {
    const file = queue.pop()!
    if (seen.has(file)) continue
    const imports = runtimeImports(file)
    seen.set(file, imports)
    for (const spec of imports.filter((item) => item.startsWith('.'))) {
      const target = path.resolve(path.dirname(file), spec)
      if (fs.existsSync(target)) queue.push(target)
    }
  }
  return seen
}

test('nothing the backend loads imports electron at run time', () => {
  const tree = backendTree(ENTRY)
  assert.ok(tree.size > 40, `the backend's tree should be walked whole (${tree.size} files)`)
  const offenders = [...tree].filter(([, imports]) => imports.includes('electron')).map(([file]) => path.relative(ROOT, file))
  assert.deepEqual(offenders, [], 'these modules import electron; give the backend what it needs through HostCapabilities instead')
  const shellOnly = ['src/main/main.ts', 'src/main/tray.ts', 'src/main/desk-island.ts', 'src/main/island-main.ts', 'src/main/window-options.ts']
  assert.deepEqual([...tree.keys()].map((file) => path.relative(ROOT, file)).filter((file) => shellOnly.includes(file.split(path.sep).join('/'))), [], 'the shell\'s own modules stay out of the backend')
})

test('the boundary check sees through type-only imports and catches value imports', (t) => {
  const dir = fs.mkdtempSync(path.join(ROOT, 'test', '.boundary-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.writeFileSync(path.join(dir, 'a.ts'), "import type { App } from 'electron'\nimport { b } from './b.ts'\nexport const a = b\n")
  fs.writeFileSync(path.join(dir, 'b.ts'), "import { app } from 'electron'\nexport const b = app\n")
  const tree = backendTree(path.join(dir, 'a.ts'))
  assert.deepEqual(tree.get(path.join(dir, 'a.ts')), ['./b.ts'])
  assert.deepEqual(tree.get(path.join(dir, 'b.ts')), ['electron'])
})

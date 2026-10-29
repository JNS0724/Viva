// The checker the kit ships (packages/viva-source-kit/dist): tsc writes the app's source-check.ts and what it
// imports as JavaScript there (tsconfig.kit.json). Run before packing the kit, and by its test.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const DIST = path.join(ROOT, 'packages', 'viva-source-kit', 'dist')

fs.rmSync(DIST, { recursive: true, force: true })
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc')
execFileSync(process.execPath, [tsc, '-p', 'tsconfig.kit.json'], { cwd: ROOT, stdio: 'inherit' })
if (!fs.existsSync(path.join(DIST, 'main', 'source-check.js'))) throw new Error('the kit build has no dist/main/source-check.js')
console.log(`[build-source-kit] ${path.relative(ROOT, DIST)}: ${fs.readdirSync(DIST).join(', ')}`)

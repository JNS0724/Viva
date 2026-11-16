import assert from 'node:assert/strict'
import { openMemoryFileStore } from '../../src/memory/node/memory-file-store.ts'

const root = process.argv[2]
assert.ok(root)
const store = openMemoryFileStore(root)
const file = store.write('digest/wiki/first.md', 'Fresh memory directory.', null)
assert.deepEqual(openMemoryFileStore(root).read(file.path), file)
process.stdout.write(JSON.stringify({ path: file.path, markdown: file.markdown }))

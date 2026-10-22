import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeTree } from '../../src/main/remove-tree.ts'

/**
 * A temporary directory for one test, removed after it. `t.after` hooks run in the order they were added,
 * and Windows will not remove a database that is still open or a directory a process still runs in, so
 * whatever holds the directory is closed through `defer`: last added first, all before the directory goes.
 *
 * @param {import('node:test').TestContext} t
 * @param {string} prefix
 * @returns {{ dir: string, defer: (close: () => unknown) => void }}
 */
export function scratch(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const closers = []
  t.after(async () => {
    try {
      for (const close of [...closers].reverse()) await close()
    } finally {
      removeTree(dir)
    }
  })
  return { dir, defer: (close) => { closers.push(close) } }
}

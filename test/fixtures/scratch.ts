import fs from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { after as afterFile } from 'node:test'
import type { TestContext } from 'node:test'
import { removeTree } from '../../src/backend/remove-tree.ts'

const REMOVE_PATIENCE_MS = 15_000
const REMOVE_PAUSE_MS = 500

async function removeEventually(dir: string) {
  const deadline = Date.now() + REMOVE_PATIENCE_MS
  for (;;) {
    try {
      removeTree(dir)
      return
    } catch (error) {
      const code = (error as { code?: string }).code
      if ((code !== 'EPERM' && code !== 'EBUSY') || Date.now() > deadline) throw error
      await new Promise(resolve => setTimeout(resolve, REMOVE_PAUSE_MS))
    }
  }
}

export function createScratchRegistry() {
  const containers = new Map<string, string>()
  return {
    scratch(t: TestContext, prefix: string) {
      const identity = createHash('sha256').update(t.filePath ?? 'unknown').digest('hex').slice(0, 16)
      let container = containers.get(identity)
      if (!container) {
        container = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
        containers.set(identity, container)
      }
      const dir = fs.mkdtempSync(path.join(container, 'case-'))
      const closers: Array<() => unknown> = []
      t.after(async () => {
        const errors: unknown[] = []
        for (const close of [...closers].reverse()) {
          try { await close() } catch (error) { errors.push(error) }
        }
        try { await removeEventually(dir) } catch (error) { errors.push(error) }
        if (errors.length) throw new AggregateError(errors, 'Scratch cleanup failed')
      })
      return { dir, defer: (close: () => unknown) => { closers.push(close) } }
    },
    close() {
      for (const [identity, container] of [...containers].reverse()) {
        try {
          fs.rmdirSync(container)
          containers.delete(identity)
        } catch (error) {
          const code = (error as { code?: string }).code
          if (code === 'ENOENT') containers.delete(identity)
          else if (code !== 'ENOTEMPTY' && code !== 'EPERM' && code !== 'EBUSY') throw error
        }
      }
    },
  }
}

const registry = createScratchRegistry()
let registered = false

/** Case directories are removed after their resources close; their empty per-file container follows the file. */
export function scratch(t: TestContext, prefix: string): { dir: string, defer: (close: () => unknown) => void } {
  if (!registered) {
    afterFile(() => registry.close())
    registered = true
  }
  return registry.scratch(t, prefix)
}

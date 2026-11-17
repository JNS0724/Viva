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
  const roots = new Map<string, string>()
  return {
    scratch(t: TestContext, prefix: string) {
      const identity = createHash('sha256').update(t.filePath ?? 'unknown').digest('hex').slice(0, 16)
      let root = roots.get(identity)
      if (!root) {
        root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), prefix)), identity)
        roots.set(identity, root)
        fs.mkdirSync(root, { recursive: true })
      }
      const dir = fs.mkdtempSync(path.join(root, 'case-'))
      const closers: Array<() => unknown> = []
      t.after(async () => {
        const errors: unknown[] = []
        for (const close of [...closers].reverse()) {
          try { await close() } catch (error) { errors.push(error) }
        }
        if (errors.length) throw new AggregateError(errors, 'Scratch resource cleanup failed')
      })
      return { dir, defer: (close: () => unknown) => { closers.push(close) } }
    },
    async close() {
      const errors: unknown[] = []
      for (const [identity, root] of [...roots].reverse()) {
        try {
          await removeEventually(root)
          roots.delete(identity)
        } catch (error) { errors.push(error) }
      }
      if (errors.length) throw new AggregateError(errors, 'Scratch directory cleanup failed')
    },
  }
}

const registry = createScratchRegistry()
let registered = false

/** Independent case directories share one root per test file, removed after the file finishes. */
export function scratch(t: TestContext, prefix: string): { dir: string, defer: (close: () => unknown) => void } {
  if (!registered) {
    afterFile(() => registry.close())
    registered = true
  }
  return registry.scratch(t, prefix)
}

export const closeScratchRoots = () => registry.close()

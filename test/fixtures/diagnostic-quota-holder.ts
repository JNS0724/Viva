import fs from 'node:fs/promises'
import path from 'node:path'
import { syncBuiltinESMExports } from 'node:module'
import { DiagnosticQuota } from '../../src/diagnostics/node/quota.ts'

// Block the inventory read after the real transaction has acquired inventory.lock.
const directory = process.argv[2]!
const release = new Promise<void>(resolve => process.once('message', () => resolve()))
const original = fs.lstat
fs.lstat = (async (...args: Parameters<typeof original>) => {
  if (args[0] === path.join(directory, 'inventory.json')) {
    fs.lstat = original
    syncBuiltinESMExports()
    process.send?.('locked')
    await release
  }
  return original(...args)
}) as typeof original
syncBuiltinESMExports()
const quota = new DiagnosticQuota(directory)
await quota.close(await quota.reserve('backend'))

import fs from 'node:fs'
import promises from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { mock } from 'node:test'

// A filesystem stall on this one path cannot be released by the parent during
// verification. A synchronous regression would also prevent unrelated RPCs.
const blocked = fs.realpathSync(process.argv[3]!)
let stall = false
const wait = new Promise<void>(() => {})
const stat = promises.lstat
promises.lstat = (async (...args: Parameters<typeof stat>) => {
  if (stall && args[0] === blocked) {
    process.send?.('verification-stalled')
    await wait
  }
  return stat(...args)
}) as typeof stat
const sync = fs.lstatSync
mock.method(fs, 'lstatSync', (...args: Parameters<typeof sync>) => {
  if (stall && args[0] === blocked) {
    process.send?.('verification-stalled')
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
  }
  return sync(...args)
})
syncBuiltinESMExports()
process.on('message', message => {
  if (message === 'block-file') { stall = true; process.send?.('file-blocked') }
})
await import('../../src/memory/node/owner-worker.ts')

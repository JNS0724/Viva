import { ChildProcess } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { ownerRpcFrame } from '../../src/memory/contracts/owner-rpc.ts'

// Preloaded only by the standalone Web smoke. Observe the real fork without exposing a production pid endpoint.
const log = process.env.VIVA_TEST_MEMORY_OWNER_PID_FILE
if (!log) throw new Error('Missing memory owner process probe path')
const emit = ChildProcess.prototype.emit
ChildProcess.prototype.emit = function (this: ChildProcess, event: string | symbol, ...args: unknown[]) {
  if (this.pid && this.spawnargs.includes('--memory-owner-ipc')) {
    if (event === 'spawn') appendFileSync(log, `spawn ${this.pid}\n`)
    const frame = event === 'message' && ownerRpcFrame(args[0])
    if (frame && frame.kind === 'event' && frame.event && typeof frame.event === 'object' && 'type' in frame.event
      && frame.event.type === 'memory_owner_state' && 'state' in frame.event && frame.event.state === 'ready') {
      appendFileSync(log, `ready ${this.pid}\n`)
    }
  }
  return Reflect.apply(emit, this, [event, ...args]) as boolean
}

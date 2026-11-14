import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { writeSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const runChild = promisify(execFile)

export function crashAt(checkpoint: string): never {
  writeSync(1, `${checkpoint}\n`)
  process.kill(process.pid, 'SIGKILL')
  throw new Error('The crash fixture did not stop immediately')
}

export async function runToCrash(fixture: URL, checkpoint: string, ...args: string[]) {
  let output: string[] = []
  await assert.rejects(runChild(process.execPath, [fileURLToPath(fixture), checkpoint, ...args], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 10_000, windowsHide: true,
  }), (error: Error & { code?: number | string, signal?: string, killed?: boolean, stdout?: string }) => {
    output = error.stdout?.trimEnd().split(/\r?\n/) ?? []
    return !error.killed && output.pop() === checkpoint
      && (error.signal === 'SIGKILL' || (process.platform === 'win32' && typeof error.code === 'number'))
  })
  return output
}

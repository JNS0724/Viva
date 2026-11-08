import { LAUNCH_WAIT_MS, packageManagerOf, type PnpmInvocation } from './dsh-launch.ts'

/**
 * dsh as the app starts it (config.ts): dsh's own command line (runCli of @deepseek-ai/dsh/lib/bin.js, which dsh
 * exports for "the installation" to call), given first what the app hands it over IPC (dsh-launch.ts): the pnpm its
 * plugin manager installs with, and the variables only that pnpm gets. Started without the app (no IPC channel), or
 * with no launch in time, dsh boots as it would on its own.
 */
/** dsh's own entry, typed by its declarations (lib/types), which its exports map does not point at. */
const DSH_BIN = '@deepseek-ai/dsh/lib/bin.js'
type DshBin = typeof import('@deepseek-ai/dsh/lib/types/bin.d.ts')

function launched(): Promise<PnpmInvocation | undefined> {
  if (!process.send) return Promise.resolve(undefined)
  return new Promise((resolve) => {
    const done = (value: PnpmInvocation | undefined) => {
      clearTimeout(timer)
      process.off('message', receive)
      resolve(value)
    }
    const receive = (message: unknown) => {
      const found = packageManagerOf(message)
      if (found) done(found)
    }
    const timer = setTimeout(() => done(undefined), LAUNCH_WAIT_MS)
    process.on('message', receive)
  })
}

const packageManager = await launched()
const { runCli }: DshBin = await import(DSH_BIN)
await runCli(packageManager ? { packageManager } : {})

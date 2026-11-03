import fs from 'node:fs'
import path from 'node:path'
import type { DshRuntime } from './dsh-runtime.ts'

/**
 * The pnpm dsh's plugin manager installs the user's plugins with: the one shipped with the app (node_modules/pnpm),
 * run by the app's own runtime (Electron as Node, or DSH_NODE), so the user needs no pnpm and no Node of their own.
 * The manager starts one executable by path, so the app writes a small launcher for it: a shell script, or a .cmd
 * file on Windows. Null when the app ships no pnpm; the manager then looks for one on PATH.
 */
const LAUNCHER_MODE = 0o755

/** pnpm's entry script, outside app.asar when the package was unpacked (after-pack.cjs): a child process reads it. */
export function pnpmEntry(appRoot: string, exists: (file: string) => boolean = fs.existsSync): string | null {
  const dir = path.join(appRoot, 'node_modules', 'pnpm')
  let bin: unknown
  try {
    bin = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).bin
  } catch {
    return null
  }
  const relative = typeof bin === 'string' ? bin : (bin as Record<string, string> | undefined)?.pnpm
  if (typeof relative !== 'string') return null
  const entry = path.join(dir, relative)
  const unpacked = entry.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`)
  if (unpacked !== entry && exists(unpacked)) return unpacked
  return exists(entry) ? entry : null
}

const quoteSh = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`

/** What the launcher says, for the platform. */
export function launcherText({ runtime, entry, platform }: { runtime: DshRuntime, entry: string, platform: string }): string {
  if (platform === 'win32') {
    return ['@echo off', ...(runtime.electron ? ['set ELECTRON_RUN_AS_NODE=1'] : []), `"${runtime.nodeBin}" "${entry}" %*`, ''].join('\r\n')
  }
  const env = runtime.electron ? 'ELECTRON_RUN_AS_NODE=1 ' : ''
  return `#!/bin/sh\n${env}exec ${quoteSh(runtime.nodeBin)} ${quoteSh(entry)} "$@"\n`
}

/** Writes the launcher into `dir` when it changed; returns its path, or null without a shipped pnpm. */
export function pnpmLauncher({ dir, appRoot, runtime, platform = process.platform }: {
  dir: string, appRoot: string, runtime: DshRuntime, platform?: string,
}): string | null {
  const entry = pnpmEntry(appRoot)
  if (!entry) return null
  const file = path.join(dir, platform === 'win32' ? 'pnpm.cmd' : 'pnpm')
  const text = launcherText({ runtime, entry, platform })
  fs.mkdirSync(dir, { recursive: true })
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
  if (current !== text) fs.writeFileSync(file, text)
  if (platform !== 'win32') fs.chmodSync(file, LAUNCHER_MODE)
  return file
}

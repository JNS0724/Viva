import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { EXTRA_COMMAND_DIRS, resolveCommand } from './mcp-config.ts'
import { checkCheckResult, checkPollResult, SOURCE_CONTRACT, type CheckResult, type ConfigValues, type PollResult } from './source-contract.ts'
import type { SourceFolder } from './source-folders.ts'

/**
 * Runs one action of a message source as a short-lived process: the request as one JSON line on stdin, the
 * answer as the last JSON line on stdout. Each run has a time limit and an output limit; the source gets the
 * system basics (PATH, home, language, temp folder) and its own data folder, none of the app's other variables
 * (the model's key, dsh's settings). Whatever goes wrong stays with this one run: it comes back as a problem.
 */
export const RUN_TIMEOUT_MS = 60_000
export const MAX_OUTPUT_BYTES = 1024 * 1024
const STDERR_TAIL_CHARS = 300
/** The variables a source may see from the app's environment (Windows needs its own few to run anything); anything else is left out. */
const PASSED_ENV = Object.freeze([
  'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TEMP', 'TMP',
  'USERPROFILE', 'USERNAME', 'HOMEDRIVE', 'HOMEPATH', 'SYSTEMDRIVE', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT',
  'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432',
  // Behind a company proxy a CLI needs these to reach anything; they name a proxy or a certificate, not the user's keys.
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'REQUESTS_CA_BUNDLE',
])
/** Arguments a .cmd or .bat may be given: cmd.exe reads its line itself, so only plain words pass, nothing it would act on. */
const PLAIN_ARG = /^[\w./\\:=@+,-]+$/

export type SourceRequest =
  | { action: 'check', config: ConfigValues }
  | { action: 'poll', config: ConfigValues, cursor: string | null }

export type Ran<T> = { ok: true, value: T } | { ok: false, problem: string }

type Spawn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess

export interface RunOptions {
  /** Where this source may keep its own files; made if missing. */
  dataDir: string
  timeoutMs?: number
  maxOutputBytes?: number
  spawn?: Spawn
  env?: Readonly<Record<string, string | undefined>>
  platform?: string
  /** The app's own runtime, which runs sources written for Node (`"run": ["node", …]`), so users need no Node. */
  execPath?: string
}

/** A variable of `env` by name whatever its case: Windows writes Path, SystemRoot, ComSpec. */
function envLookup(env: Readonly<Record<string, string | undefined>>) {
  const byName = new Map(Object.entries(env).map(([name, value]) => [name.toUpperCase(), value]))
  return (name: string): string | undefined => byName.get(name.toUpperCase()) || undefined
}

/** The command and environment to start `run` with, or why it cannot start. */
export function commandFor(folder: SourceFolder, options: RunOptions): Ran<{ command: string, args: string[], env: Record<string, string>, verbatim?: boolean }> {
  const { env = process.env, platform = process.platform, execPath = process.execPath } = options
  const [first, ...args] = folder.manifest.runOn?.[platform as 'win32' | 'darwin' | 'linux'] ?? folder.manifest.run
  const lookup = envLookup(env)
  const base: Record<string, string> = Object.fromEntries(PASSED_ENV.flatMap((name) => {
    const value = lookup(name)
    return value ? [[name, value]] : []
  }))
  const delimiter = platform === 'win32' ? ';' : ':'
  // Apps opened from the Dock get a short PATH; the usual Homebrew folders are added there only.
  base.PATH = [lookup('PATH') ?? '', ...(platform === 'darwin' ? EXTRA_COMMAND_DIRS : [])].filter(Boolean).join(delimiter)
  base.VIVA_SOURCE_DATA = options.dataDir
  base.VIVA_SOURCE_CONTRACT = String(SOURCE_CONTRACT)
  if (first === 'node') return { ok: true, value: { command: execPath, args, env: { ...base, ELECTRON_RUN_AS_NODE: '1' } } }
  const command = findProgram(first, folder.dir, base, platform)
  if (!command) return { ok: false, problem: `找不到要运行的程序：${first}` }
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(command)) return viaCmd(command, args, base)
  return { ok: true, value: { command, args, env: base } }
}

/** Extensions Windows runs, in its order; none elsewhere. */
const runnableExtensions = (base: Record<string, string>, platform: string) =>
  (platform === 'win32' ? String(base.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((ext) => ext.toLowerCase()) : [])

/**
 * Where `name` is: in the source's folder when it is a path, else on PATH. On Windows a name without an extension
 * is looked for with each runnable extension first: npm puts a sh script `tool` beside the `tool.cmd` that runs.
 */
function findProgram(name: string, dir: string, base: Record<string, string>, platform: string): string | null {
  const extensions = path.extname(name) ? [] : runnableExtensions(base, platform)
  if (/[\\/]/.test(name)) {
    const local = path.resolve(dir, name)
    return [...extensions.map((ext) => local + ext), local].find((file) => fs.existsSync(file)) ?? null
  }
  for (const ext of extensions) {
    // An empty PATHEXT: only the name as given, with this extension.
    const found = resolveCommand(name + ext, { env: { PATH: base.PATH, PATHEXT: '' }, platform })
    if (found) return found
  }
  return resolveCommand(name, { env: { PATH: base.PATH, PATHEXT: base.PATHEXT }, platform })
}

/**
 * A .cmd or .bat (what npm installs a CLI as on Windows) can only start through cmd.exe, which parses the line
 * itself; so it runs only with plain-word arguments, quoted as cmd.exe expects (the config goes on stdin anyway).
 */
function viaCmd(command: string, args: readonly string[], base: Record<string, string>): Ran<{ command: string, args: string[], env: Record<string, string>, verbatim?: boolean }> {
  const odd = args.find((arg) => !PLAIN_ARG.test(arg))
  if (odd !== undefined || /["%^&|<>]/.test(command)) return { ok: false, problem: `${path.basename(command)} 的参数只能是简单的词：${(odd ?? command).slice(0, 40)}` }
  const line = [`"${command}"`, ...args].join(' ')
  return { ok: true, value: { command: base.COMSPEC ?? 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], env: base, verbatim: true } }
}

/** Ends the source and everything it started: its process group, or the tree on Windows. */
function endTree(child: ChildProcess, platform: string, spawn: Spawn) {
  if (!child.pid) return
  try {
    if (platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on?.('error', () => child.kill())
    else process.kill(-child.pid, 'SIGKILL')
  } catch {
    child.kill('SIGKILL')
  }
}

/** The last line of `out` that is JSON, parsed; sources may log other lines before it. */
function lastJsonLine(out: string): { value: unknown } | null {
  const lines = out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return { value: JSON.parse(lines[i]) }
    } catch {
      // a log line; keep looking
    }
  }
  return null
}

const tail = (text: string) => text.trim().slice(-STDERR_TAIL_CHARS)

/** The raw answer of one run: the parsed last JSON line, or why there is none. */
export function runSource(folder: SourceFolder, request: SourceRequest, options: RunOptions): Promise<Ran<unknown>> {
  const { timeoutMs = RUN_TIMEOUT_MS, maxOutputBytes = MAX_OUTPUT_BYTES, spawn = nodeSpawn as Spawn, platform = process.platform } = options
  const prepared = commandFor(folder, options)
  if (!prepared.ok) return Promise.resolve(prepared)
  try {
    fs.mkdirSync(options.dataDir, { recursive: true })
  } catch {
    return Promise.resolve({ ok: false, problem: '建不了消息源的数据文件夹' })
  }
  const { command, args, env, verbatim = false } = prepared.value
  return new Promise((resolve) => {
    let settled = false
    let ended = false
    let out = ''
    let outBytes = 0
    let err = ''
    const child = spawn(command, args, {
      cwd: folder.dir, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, windowsVerbatimArguments: verbatim, detached: platform !== 'win32',
    })
    const finish = (result: Ran<unknown>) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const stop = () => {
      if (ended) return
      ended = true
      endTree(child, platform, spawn)
    }
    const timer = setTimeout(() => {
      stop()
      finish({ ok: false, problem: `超过 ${Math.round(timeoutMs / 1000)} 秒没有结果，已停止` })
    }, timeoutMs)
    child.on('error', (error) => finish({ ok: false, problem: `启动失败：${error.message}` }))
    // Decoded as a stream, so a character split between two chunks stays whole.
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      if (settled) return
      outBytes += Buffer.byteLength(chunk)
      if (outBytes > maxOutputBytes) {
        stop()
        finish({ ok: false, problem: `输出超过 ${Math.round(maxOutputBytes / 1024)} KB，已停止` })
        return
      }
      out += chunk
    })
    child.stderr?.on('data', (chunk: string) => {
      err = (err + chunk).slice(-STDERR_TAIL_CHARS * 4)
    })
    child.on('close', (code, signal) => {
      if (code !== 0) return finish({ ok: false, problem: tail(err) || (code === null ? `程序被结束了（${signal}）` : `程序退出，代码 ${code}`) })
      const parsed = lastJsonLine(out)
      finish(parsed ? { ok: true, value: parsed.value } : { ok: false, problem: '没有输出 JSON 结果' })
    })
    child.stdin?.on('error', () => {})
    child.stdin?.end(`${JSON.stringify({ contract: SOURCE_CONTRACT, ...request })}\n`)
  })
}

/** Asks for messages after `cursor`, the answer checked. */
export async function pollSource(folder: SourceFolder, config: ConfigValues, cursor: string | null, options: RunOptions): Promise<Ran<PollResult>> {
  const ran = await runSource(folder, { action: 'poll', config, cursor }, options)
  if (!ran.ok) return ran
  const checked = checkPollResult(ran.value)
  return checked.problem === undefined ? { ok: true, value: checked.result } : { ok: false, problem: checked.problem }
}

/** Asks whether `config` works (设置页「测试连接」), the answer checked. */
export async function checkSource(folder: SourceFolder, config: ConfigValues, options: RunOptions): Promise<Ran<CheckResult>> {
  const ran = await runSource(folder, { action: 'check', config }, options)
  if (!ran.ok) return ran
  const checked = checkCheckResult(ran.value)
  return checked.problem === undefined ? { ok: true, value: checked.result } : { ok: false, problem: checked.problem }
}

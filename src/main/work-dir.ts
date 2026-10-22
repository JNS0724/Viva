import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * The working directory the user picks for the agent (single-conversation design): which folders may be one,
 * and the folders used lately. The agent reads and writes there (writes after the user allowed them), so a
 * whole disk, the home folder itself and the system's folders are refused.
 */
export const MAX_RECENT = 8

/** Folders of the system, by platform; anything inside them is refused too. */
const SYSTEM_DIRS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  darwin: ['/System', '/Library', '/usr', '/bin', '/sbin', '/etc', '/private/etc', '/cores', '/dev', '/Applications'],
  linux: ['/usr', '/etc', '/bin', '/sbin', '/boot', '/proc', '/sys', '/dev', '/lib', '/lib64'],
})
const WINDOWS_SYSTEM_VARS = Object.freeze([
  ['SystemRoot', 'C:\\Windows'], ['ProgramFiles', 'C:\\Program Files'], ['ProgramFiles(x86)', 'C:\\Program Files (x86)'], ['ProgramData', 'C:\\ProgramData'],
])

const pathFor = (platform: string) => (platform === 'win32' ? path.win32 : path.posix)
/** Windows and (by default) macOS ignore case in file names. */
const foldsCase = (platform: string) => platform === 'win32' || platform === 'darwin'

function keyOf(dir: string, platform: string): string {
  const p = pathFor(platform)
  const normal = p.normalize(dir)
  const trimmed = normal.length > p.parse(normal).root.length ? normal.replace(/[\\/]+$/, '') : normal
  return foldsCase(platform) ? trimmed.toLowerCase() : trimmed
}

/**
 * Whether `a` and `b` name the same folder, whatever the trailing separator (and case, where the system ignores it).
 * @param platform process.platform's values
 */
export const sameDir = (a: string, b: string, platform: string = process.platform): boolean => keyOf(a, platform) === keyOf(b, platform)

/** `dir` is `parent` or inside it. */
function within(dir: string, parent: string, platform: string): boolean {
  const child = keyOf(dir, platform)
  const base = keyOf(parent, platform)
  return child === base || child.startsWith(`${base}${pathFor(platform).sep}`)
}

function systemDirs(platform: string, env: Record<string, string | undefined>): readonly string[] {
  if (platform === 'win32') return WINDOWS_SYSTEM_VARS.map(([name, fallback]) => env[name] || fallback)
  return SYSTEM_DIRS[platform] ?? SYSTEM_DIRS.linux
}

const isFolder = (dir: string) => {
  try {
    return fs.statSync(dir).isDirectory()
  } catch {
    return false
  }
}

/**
 * @param dir the folder picked
 * @returns why it cannot be the working directory, or null when it can
 */
export function workDirProblem(dir: unknown, { platform = process.platform, home = os.homedir(), env = process.env, isDirectory = isFolder }: {
  platform?: string, home?: string, env?: Record<string, string | undefined>, isDirectory?: (dir: string) => boolean,
} = {}): string | null {
  const p = pathFor(platform)
  if (platform === 'win32' && /^(\\\\|\/\/)/.test(typeof dir === 'string' ? dir : '')) return '不支持网络路径（\\\\服务器\\共享），可以先映射成本地盘符，或者复制到本机'
  if (typeof dir !== 'string' || !dir || !p.isAbsolute(dir)) return '需要选一个文件夹的完整路径'
  // A file dragged onto the window lands here too.
  if (!isDirectory(dir)) return '这不是一个文件夹，或者它已经不在了'
  if (keyOf(dir, platform) === keyOf(p.parse(p.normalize(dir)).root, platform)) return '不能把整个磁盘作为工作目录，请选其中的某个文件夹'
  if (sameDir(dir, home, platform)) return '不能直接用用户主目录，请选它里面的某个文件夹'
  if (systemDirs(platform, env).some((system) => within(dir, system, platform))) return '这是系统的文件夹，不能作为工作目录'
  return null
}

/** The folders used lately with `dir` first, each once, at most MAX_RECENT; `list` is left as it was. */
export function withRecent(list: readonly string[], dir: string, platform: string = process.platform): string[] {
  return [dir, ...list.filter((item) => !sameDir(item, dir, platform))].slice(0, MAX_RECENT)
}

/** `list` without `dir`. */
export const forgetDir = (list: readonly string[], dir: string, platform: string = process.platform): string[] => list.filter((item) => !sameDir(item, dir, platform))

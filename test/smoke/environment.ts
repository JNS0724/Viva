import path from 'node:path'

const STANDARD = new Set(['PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'USER', 'USERNAME', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'DISPLAY', 'XAUTHORITY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'CI', 'TERM', 'COLORTERM', 'OS', 'PROCESSOR_ARCHITECTURE', '__CF_USER_TEXT_ENCODING'])

/** Start from a small OS environment, never the developer's credentials or runtime hooks. */
export function applicationEnvironment(base: NodeJS.ProcessEnv, options: { workspace: string, projectRoot: string, bridge: 'real' | 'fake', apiKey?: string, importHome: string }): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) if (typeof value === 'string' && STANDARD.has(key.toUpperCase())) result[key] = value
  if (options.apiKey) {
    for (const key of ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS']) if (base[key]) result[key] = base[key]
  } else result.NO_PROXY = '127.0.0.1,localhost'
  result.DEEPSEEK_API_KEY = options.apiKey || ''
  result.AGENT_CWD = options.workspace
  result.DSH_HOME = options.importHome
  if (options.bridge === 'fake') result.DSH_BIN = path.join(options.projectRoot, 'test', 'fixtures', 'fake-dsh.js')
  return result
}

// The packages the built app needs: dsh as the app runs it (the ACP composition), not dsh as installed.
//
// @deepseek-ai/dsh depends on everything any profile might boot (the web app, the TUI, Office conversion
// with LibreOffice, voice input, ...). Viva only boots the ACP composition, so the closure starts from what
// that composition enables (asked of dsh itself, `--dump-config`), what dsh's entry imports, the app's own
// dependencies and the plugins' peers, and follows dependencies, peers and optional dependencies from
// there. Everything else stays out of the build.
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const DSH = '@deepseek-ai/dsh'
/** The bundles the ACP template composes; see the acp entry of PROFILE_TEMPLATES in dsh-app-boot. */
const ACP_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app']

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))
const packageName = (spec) => /^(@[^/]+\/[^/]+|[^@/.][^/]*)/.exec(spec)?.[1] ?? null

/** Plugin packages the ACP composition loads (entries that may be enabled; per-platform ones included). */
function composedPackages(projectDir) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'viva-closure-'))
  try {
    const electron = require(path.join(projectDir, 'node_modules', 'electron'))
    const dump = execFileSync(electron, [path.join(projectDir, 'node_modules', DSH, 'lib', 'bin.js'), '--profile', 'acp', '--dump-config'], {
      cwd: home, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: home },
    })
    const entries = []
    for (const line of dump.split(/\r?\n/)) {
      if (/^\s*- id: /.test(line)) entries.push({ name: null, disabled: false })
      const name = /^\s+name: '?([^'\s]+)'?\s*$/.exec(line)
      if (name && entries.length && entries.at(-1).name === null) entries.at(-1).name = name[1]
      if (/^\s+disabled: true\s*$/.test(line) && entries.length) entries.at(-1).disabled = true
    }
    if (entries.length < 10) throw new Error(`dsh --dump-config listed only ${entries.length} entries`)
    return entries.filter((entry) => entry.name && !entry.disabled).map((entry) => packageName(entry.name)).filter(Boolean)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
}

/** What dsh's own entry files import. */
function entryImports(projectDir) {
  const lib = path.join(projectDir, 'node_modules', DSH, 'lib')
  const specs = fs.readdirSync(lib).filter((file) => file.endsWith('.js')).flatMap((file) => {
    const text = fs.readFileSync(path.join(lib, file), 'utf8')
    return [...text.matchAll(/(?:from\s*|import\s*\(\s*)['"]([^'"]+)['"]/g)].map((match) => match[1])
  })
  return specs.filter((spec) => !spec.startsWith('.') && !spec.startsWith('node:')).map(packageName).filter(Boolean)
}

function pluginPeers(projectDir) {
  const plugins = path.join(projectDir, 'plugins')
  return fs.readdirSync(plugins).flatMap((name) => {
    const manifest = path.join(plugins, name, 'package.json')
    return fs.existsSync(manifest) ? Object.keys(readJson(manifest).peerDependencies ?? {}) : []
  })
}

/** Node's lookup of `name` from a package folder, up to the project. */
function resolveFrom(projectDir, fromDir, name) {
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', name)
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate
    if (dir === projectDir || path.dirname(dir) === dir) return null
  }
}

/**
 * @param {string} projectDir
 * @returns {{ keep: string[], roots: number }} package folders to ship, relative to the project
 */
function shippedPackages(projectDir) {
  const app = readJson(path.join(projectDir, 'package.json'))
  const roots = [...new Set([
    ...composedPackages(projectDir), ...ACP_BUNDLES, ...entryImports(projectDir), ...pluginPeers(projectDir),
    ...Object.keys(app.dependencies ?? {}).filter((name) => name !== DSH),
  ])]
  const unresolved = roots.filter((name) => !resolveFrom(projectDir, projectDir, name))
  if (unresolved.length) throw new Error(`packages the app needs are not installed: ${unresolved.join(', ')}`)
  // dsh itself ships, but not what its manifest lists for other profiles.
  const keep = new Set([path.join(projectDir, 'node_modules', DSH)])
  const queue = roots.map((name) => resolveFrom(projectDir, projectDir, name))
  while (queue.length) {
    const dir = queue.pop()
    if (keep.has(dir)) continue
    keep.add(dir)
    const manifest = readJson(path.join(dir, 'package.json'))
    for (const name of Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies, ...manifest.optionalDependencies })) {
      const found = resolveFrom(projectDir, dir, name)
      if (found && !keep.has(found)) queue.push(found)
    }
  }
  return { keep: [...keep].map((dir) => path.relative(projectDir, dir)).sort((a, b) => a.length - b.length), roots: roots.length }
}

module.exports = { shippedPackages }

// electron-builder afterPack hook: turns the copied app folder into what Viva ships.
//
// 1. Packages: exactly the ones the app runs (dsh-closure.cjs). electron-builder's own collection both
//    misses dsh's peer dependencies and takes all of @deepseek-ai/dsh's (web app, LibreOffice, voice
//    input, ...). Inside the repository a built app still found missing packages in the repo's own
//    node_modules, so the result is checked here, and built apps are tested outside the repository.
// 2. Files nothing loads at run time: source maps, type declarations, TypeScript sources, READMEs and
//    changelogs, test and example folders. Licenses and skill files stay.
// 3. LICENSE and THIRD_PARTY_NOTICES.txt (third-party-notices.cjs) beside app.asar, as plain files anyone
//    can open (like Electron's own license files); a copy of the notices goes to dist/.
// 4. One app.asar instead of tens of thousands of small files, which on Windows is what made installing
//    slow (each file written and scanned on its own). Packages with native code or programs are unpacked
//    beside it, where the OS can load and run them.
const fs = require('node:fs')
const path = require('node:path')
const asar = require('@electron/asar')
const { shippedPackages } = require('./dsh-closure.cjs')
const { noticesText } = require('./third-party-notices.cjs')

const UNUSED_FILE = /(\.map|\.d\.[mc]?ts|(?<!\.d)\.[mc]?ts|\.tsbuildinfo)$/i
const UNUSED_DOC = /^(readme|changelog|history|contributing|code_of_conduct)(\.(md|markdown|txt))?$/i
const UNUSED_DIRS = new Set(['test', 'tests', '__tests__', '.github', 'example', 'examples'])
const NATIVE_EXT = /\.(node|dylib|so|dll|exe)$|\.so\.\d/i
/** Mach-O (thin and fat), ELF, PE: a program or library, whatever its name. */
const NATIVE_MAGIC = ['cffaedfe', 'cefaedfe', 'cafebabe', '7f454c46']

function resourcesDir({ appOutDir, electronPlatformName, packager }) {
  return electronPlatformName === 'darwin'
    ? path.join(appOutDir, `${packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : path.join(appOutDir, 'resources')
}

/** Package folders under node_modules (scoped and nested), relative to `root`. */
function installedPackages(root, modules = path.join(root, 'node_modules')) {
  if (!fs.existsSync(modules)) return []
  return fs.readdirSync(modules).flatMap((name) => {
    const full = path.join(modules, name)
    if (name.startsWith('.')) return []
    if (name.startsWith('@')) return fs.readdirSync(full).flatMap((inner) => [path.join(full, inner), ...installedPackages(root, path.join(full, inner, 'node_modules'))])
    return [full, ...installedPackages(root, path.join(full, 'node_modules'))]
  }).map((full) => (path.isAbsolute(full) ? path.relative(root, full) : full))
}

/** The app folder gets the shipped packages and loses the rest. */
function syncPackages(projectDir, target, keep) {
  const wanted = new Set(keep)
  const removed = installedPackages(target).filter((dir) => !wanted.has(dir) && fs.existsSync(path.join(target, dir)))
  removed.forEach((dir) => fs.rmSync(path.join(target, dir), { recursive: true, force: true }))
  const added = keep.filter((dir) => !fs.existsSync(path.join(target, dir)))
  added.forEach((dir) => fs.cpSync(path.join(projectDir, dir), path.join(target, dir), { recursive: true }))
  const missing = keep.filter((dir) => !fs.existsSync(path.join(target, dir, 'package.json')))
  if (missing.length) throw new Error(`the built app lacks packages it needs: ${missing.slice(0, 10).join(', ')}`)
  return { added: added.length, removed: removed.length }
}

function pruneFiles(dir) {
  let removed = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (UNUSED_DIRS.has(entry.name) && !fs.existsSync(path.join(full, 'package.json'))) {
        fs.rmSync(full, { recursive: true, force: true })
        removed += 1
      } else removed += pruneFiles(full)
    } else if (UNUSED_FILE.test(entry.name) || UNUSED_DOC.test(entry.name)) {
      fs.rmSync(full)
      removed += 1
    }
  }
  return removed
}

function hasNative(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).some((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return entry.name !== 'node_modules' && hasNative(full)
    if (!entry.isFile()) return false
    if (NATIVE_EXT.test(entry.name)) return true
    const fd = fs.openSync(full, 'r')
    const head = Buffer.alloc(4)
    fs.readSync(fd, head, 0, 4, 0)
    fs.closeSync(fd)
    return NATIVE_MAGIC.includes(head.toString('hex')) || head.subarray(0, 2).toString('latin1') === 'MZ'
  })
}

const countFiles = (dir) => fs.readdirSync(dir, { withFileTypes: true })
  .reduce((n, entry) => n + (entry.isDirectory() ? countFiles(path.join(dir, entry.name)) : 1), 0)

exports.default = async function afterPack(context) {
  const projectDir = context.packager.projectDir
  const resources = resourcesDir(context)
  const target = path.join(resources, 'app')
  // electron-builder packs its own app.asar (and checks the entry file in it after this hook): unpack it,
  // rework the folder, pack it again with this build's packages and unpack rules.
  const archive = path.join(resources, 'app.asar')
  if (fs.existsSync(archive)) {
    asar.extractAll(archive, target)
    fs.rmSync(archive)
    fs.rmSync(`${archive}.unpacked`, { recursive: true, force: true })
  }
  const { keep } = shippedPackages(projectDir)
  const synced = syncPackages(projectDir, target, keep)
  const pruned = pruneFiles(path.join(target, 'node_modules'))
  console.log(`  • after-pack       packages: ${keep.length} shipped (${synced.added} added, ${synced.removed} left out); ${pruned} unused files removed`)

  const platform = `${context.electronPlatformName}-${context.arch === 1 ? 'x64' : context.arch === 3 ? 'arm64' : context.arch}`
  const notices = noticesText({ projectDir, platform, packages: keep })
  fs.writeFileSync(path.join(resources, 'THIRD_PARTY_NOTICES.txt'), notices)
  fs.copyFileSync(path.join(projectDir, 'LICENSE'), path.join(resources, 'LICENSE'))
  fs.writeFileSync(path.join(context.outDir, `THIRD_PARTY_NOTICES-${context.electronPlatformName}.txt`), notices)

  const unpacked = keep.filter((dir) => hasNative(path.join(target, dir))).map((dir) => dir.split(path.sep).join('/'))
  const files = countFiles(target)
  await asar.createPackageWithOptions(target, archive, { unpackDir: `{${unpacked.join(',')}}` })
  fs.rmSync(target, { recursive: true, force: true })
  const left = fs.existsSync(path.join(resources, 'app.asar.unpacked')) ? countFiles(path.join(resources, 'app.asar.unpacked')) : 0
  console.log(`  • after-pack       app.asar holds ${files - left} files; ${left} unpacked beside it (${unpacked.join(', ')})`)
}

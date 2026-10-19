// electron-builder afterPack hook: the built app gets every production package npm installed.
//
// dsh's packages name each other as peer dependencies, which electron-builder does not collect. Inside the
// repository a built app still found them (Node looks up the folders, into the repo's own node_modules),
// so this only shows once the app runs elsewhere: from the dmg, or installed. Every package npm counts as
// production (peers included) is copied in where missing, then checked; a package still missing fails the
// build.
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

function appDir(context) {
  const { appOutDir, electronPlatformName, packager } = context
  return electronPlatformName === 'darwin'
    ? path.join(appOutDir, `${packager.appInfo.productFilename}.app`, 'Contents', 'Resources', 'app')
    : path.join(appOutDir, 'resources', 'app')
}

/** Folders of the production packages, relative to the project, parents before what they contain. */
function productionPackages(projectDir) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const out = execFileSync(npm, ['ls', '--omit=dev', '--all', '--parseable'], { cwd: projectDir, encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 64 * 1024 * 1024 })
  return [...new Set(out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    .map((dir) => path.relative(projectDir, dir))
    .filter((dir) => dir.split(path.sep)[0] === 'node_modules'))]
    .sort((a, b) => a.length - b.length)
}

exports.default = async function afterPack(context) {
  const projectDir = context.packager.projectDir
  const target = appDir(context)
  const packages = productionPackages(projectDir)
  const added = packages.filter((dir) => !fs.existsSync(path.join(target, dir))).map((dir) => {
    fs.cpSync(path.join(projectDir, dir), path.join(target, dir), { recursive: true })
    return dir
  })
  const missing = packages.filter((dir) => !fs.existsSync(path.join(target, dir, 'package.json')))
  if (missing.length) throw new Error(`the built app lacks production packages: ${missing.slice(0, 10).join(', ')}`)
  console.log(`  • after-pack       added=${added.length} packages electron-builder left out; all ${packages.length} present`)
}

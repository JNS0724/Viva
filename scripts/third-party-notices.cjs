// The third-party notices shipped with the built app (THIRD_PARTY_NOTICES.txt), made from the packages the
// build ships (dsh-closure.cjs) on the machine that builds it, so each platform lists what it actually has.
//
// MIT, BSD, ISC and Apache packages ask for their copyright and license text (and NOTICE files) to travel
// with copies; MPL-2.0 (LibreOffice, in dsh's libreoffice-kit) and LGPL-3.0 (libvips, in sharp) also ask
// that recipients be told where the source is. Both are covered here.
const fs = require('node:fs')
const path = require('node:path')

const PROJECT_URL = 'https://github.com/JNS0724/Viva'
const LICENSE_FILE = /^(licen[sc]e|copying|notice)([.-].*)?$/i
const COPYLEFT = /MPL|LGPL|GPL/
const MAX_INLINE_BYTES = 256 * 1024
const RULE = '='.repeat(78)
/** Official texts of the long licenses some packages name without shipping (gnu.org, apache.org). */
const FULL_TEXTS = Object.freeze({ 'Apache-2.0': 'Apache-2.0.txt', 'LGPL-3.0': 'LGPL-3.0.txt', 'GPL-3.0': 'GPL-3.0.txt' })

const MIT_TEXT = (holder) => `MIT License

Copyright (c) ${holder}

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
associated documentation files (the "Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the
following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial
portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT
LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO
EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR
THE USE OR OTHER DEALINGS IN THE SOFTWARE.`

const ISC_TEXT = (holder) => `ISC License

Copyright (c) ${holder}

Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is
hereby granted, provided that the above copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE
INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF
USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.`

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

const licenseOf = (manifest) => (typeof manifest.license === 'string' ? manifest.license
  : manifest.license?.type ?? manifest.licenses?.map((entry) => entry.type).join(' OR ') ?? 'UNKNOWN')

const repositoryOf = (manifest) => {
  const repo = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url
  return (repo ?? manifest.homepage ?? '').replace(/^git\+/, '').replace(/\.git$/, '')
}

/** One entry per package name and version, with what the notices need. */
function describe(projectDir, dirs) {
  const lock = readJson(path.join(projectDir, 'package-lock.json'))?.packages ?? {}
  const seen = new Set()
  return dirs.flatMap((dir) => {
    const full = path.join(projectDir, dir)
    const manifest = readJson(path.join(full, 'package.json'))
    if (!manifest?.name || seen.has(`${manifest.name}@${manifest.version}`)) return []
    seen.add(`${manifest.name}@${manifest.version}`)
    return [{
      dir: full,
      name: manifest.name,
      version: manifest.version,
      license: licenseOf(manifest),
      repository: repositoryOf(manifest),
      author: (typeof manifest.author === 'string' ? manifest.author : manifest.author?.name) || `the authors of ${manifest.name}`,
      tarball: lock[dir.split(path.sep).join('/')]?.resolved ?? '',
    }]
  }).sort((a, b) => a.name.localeCompare(b.name))
}

/** Where the source of a copyleft package is, from what the package itself records. */
function sourceLines(entry) {
  const lines = [`${entry.name}@${entry.version} (${entry.license})`]
  if (entry.repository) lines.push(`  Package source: ${entry.repository}`)
  if (entry.tarball) lines.push(`  Package as installed: ${entry.tarball}`)
  const core = readJson(path.join(entry.dir, 'sources', 'core-source.json'))
  if (core?.repository) {
    lines.push(`  LibreOffice source: ${core.repository} at revision ${core.revision}`)
    if (fs.existsSync(path.join(entry.dir, 'sources', 'core-changes.patch'))) lines.push('  Changes made to it: sources/core-changes.patch inside this package')
  }
  const vips = readJson(path.join(entry.dir, 'versions.json'))?.vips
  if (vips) {
    lines.push(`  libvips ${vips} source: https://github.com/libvips/libvips/releases/tag/v${vips}`)
    lines.push('  libvips is a separate shared library in this package\'s lib folder and can be replaced with a compatible build.')
  }
  return lines
}

function licenseTexts(entry) {
  const files = fs.readdirSync(entry.dir).filter((name) => LICENSE_FILE.test(name))
  const extra = fs.existsSync(path.join(entry.dir, 'licenses')) ? fs.readdirSync(path.join(entry.dir, 'licenses')).map((name) => path.join('licenses', name)) : []
  const texts = [...files, ...extra].map((name) => {
    const file = path.join(entry.dir, name)
    if (!fs.statSync(file).isFile()) return null
    if (fs.statSync(file).size > MAX_INLINE_BYTES || /\.html?$/i.test(name)) return `[${name}: shipped in the package folder, node_modules/${entry.name}/${name.split(path.sep).join('/')}]`
    return `--- ${name} ---\n${fs.readFileSync(file, 'utf8').trim()}`
  }).filter(Boolean)
  return texts.length ? texts : [declaredText(entry)]
}

/** A package that names its license without shipping the file: the license text, with its author. */
function declaredText(entry) {
  if (/^MIT\b/.test(entry.license)) return MIT_TEXT(entry.author)
  if (/^ISC\b/.test(entry.license)) return ISC_TEXT(entry.author)
  const full = Object.keys(FULL_TEXTS).find((id) => entry.license.includes(id))
  if (full) return `[${entry.license}, copyright ${entry.author}. Full text of ${full} at the end of this file.]`
  return `[No license file in the package; its manifest declares ${entry.license}, copyright ${entry.author}.]`
}

/**
 * @param {{ projectDir: string, platform: string, packages: string[] }} options packages: folders shipped, relative to the project
 * @returns {string} the notices text
 */
function noticesText({ projectDir, platform, packages }) {
  const entries = describe(projectDir, packages)
  const copyleft = entries.filter((entry) => COPYLEFT.test(entry.license))
  return [
    'Viva third-party notices',
    RULE,
    `Viva (${PROJECT_URL}) is released under the MIT License; see LICENSE.`,
    `This build for ${platform} includes the software listed below, each under its own license.`,
    '',
    'Electron and Chromium',
    RULE,
    'Viva runs on Electron. Its license and the licenses of Chromium and its components ship with the',
    'app as LICENSE.electron.txt and LICENSES.chromium.html (macOS: Viva.app/Contents/Resources;',
    'Windows: the installation folder).',
    '',
    'Source code of the MPL-2.0 and LGPL-3.0 components',
    RULE,
    ...copyleft.flatMap((entry) => [...sourceLines(entry), '']),
    `On request the maintainer provides these sources as well: ${PROJECT_URL}/issues`,
    '',
    `Licenses (${entries.length} packages)`,
    RULE,
    ...entries.flatMap((entry) => [
      '',
      `${entry.name}@${entry.version} -- ${entry.license}${entry.repository ? ` -- ${entry.repository}` : ''}`,
      '-'.repeat(78),
      ...licenseTexts(entry),
    ]),
    '',
    'Full license texts',
    RULE,
    ...Object.entries(FULL_TEXTS).flatMap(([id, file]) => ['', `--- ${id} ---`, fs.readFileSync(path.join(__dirname, 'licenses', file), 'utf8').trim()]),
    '',
  ].join('\n')
}

module.exports = { noticesText }

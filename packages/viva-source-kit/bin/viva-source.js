#!/usr/bin/env node
// viva-source: the developer's side of Viva message sources.
//   viva-source test <folder> [--config <file.json>] [--set name=value]...   runs it as Viva would, with Viva's checks
//   viva-source new <folder> [--template js|python|command]                  starts one from a template
// `test` uses the app's own code (built into dist/ from the Viva sources), so what passes here installs there.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TEMPLATES = ['js', 'python', 'command']
let language = 'en'
const copy = (en, zh) => language === 'zh-CN' ? zh : en
const USAGE = `Usage / 用法：
  viva-source test <folder> [--language en|zh-CN] [--config config.json] [--set NAME=VALUE]...
  viva-source new <folder> [--language en|zh-CN] [--template ${TEMPLATES.join('|')}]`

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(2)
}

/** Positional arguments and the --name value pairs after them; --set may repeat. */
function parse(args) {
  const positional = []
  const options = { set: [] }
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    const value = args[i + 1]
    if (value === undefined) fail(copy(`${arg} requires a value`, `${arg} 后面要跟一个值`))
    i += 1
    if (arg === '--set') options.set.push(value)
    else options[arg.slice(2)] = value
  }
  return { positional, options }
}

/** A --set value as its field takes it: numbers and switches typed, the rest as text. */
function typed(field, raw) {
  if (field?.type === 'number') return Number(raw)
  if (field?.type === 'boolean') return raw === 'true' || raw === '1' || raw === 'yes'
  return raw
}

async function test(folder, options) {
  const { setLocale } = await import('../dist/shared/i18n/locale.js')
  setLocale(language)
  const { checkFolder, reportLines } = await import('../dist/main/source-check.js')
  const { readManifest } = await import('../dist/main/source-folders.js')
  const read = readManifest(path.resolve(folder))
  const fields = 'manifest' in read ? read.manifest.config : {}
  const fromFile = options.config ? JSON.parse(fs.readFileSync(options.config, 'utf8')) : {}
  const fromSet = Object.fromEntries(options.set.map((pair) => {
    const at = pair.indexOf('=')
    if (at <= 0) fail(copy(`--set must use NAME=VALUE: ${pair}`, `--set 要写成 名称=值：${pair}`))
    const name = pair.slice(0, at)
    return [name, typed(fields[name], pair.slice(at + 1))]
  }))
  const report = await checkFolder(folder, { values: { ...fromFile, ...fromSet } })
  process.stdout.write(`${reportLines(report).join('\n')}\n`)
  process.exitCode = report.ok ? 0 : 1
}

/** An id from the folder's name: lowercase letters, digits and hyphens. */
const idFrom = (name) => name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'my-source'

function create(folder, options) {
  const template = options.template ?? 'js'
  if (!TEMPLATES.includes(template)) fail(copy(`Unknown template: ${template} (choose ${TEMPLATES.join(', ')})`, `没有这个模板：${template}（可选 ${TEMPLATES.join('、')}）`))
  const target = path.resolve(folder)
  if (fs.existsSync(target) && fs.readdirSync(target).length) fail(copy(`${target} is not empty. Choose an empty folder.`, `${target} 已经有东西了，换一个空文件夹`))
  fs.cpSync(path.join(KIT, 'templates', ...(language === 'zh-CN' ? ['zh-CN'] : []), template), target, { recursive: true })
  const manifestFile = path.join(target, 'viva-source.json')
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  const id = idFrom(path.basename(target))
  fs.writeFileSync(manifestFile, `${JSON.stringify({ ...manifest, id }, null, 2)}\n`)
  const usesKit = template !== 'python'
  if (usesKit) {
    const { version } = JSON.parse(fs.readFileSync(path.join(KIT, 'package.json'), 'utf8'))
    fs.writeFileSync(path.join(target, 'package.json'), `${JSON.stringify({ name: id, private: true, dependencies: { 'viva-source-kit': `^${version}` } }, null, 2)}\n`)
  }
  process.stdout.write([
    copy(`Created source “${id}” at ${target} (${template} template).`, `已在 ${target} 建好消息源「${id}」（${template} 模板）。`),
    usesKit ? `  cd ${folder} && npm install` : null,
    copy('  Edit viva-source.json and the TODOs in the program, then:', '  改好 viva-source.json 和程序里标着 TODO 的地方，然后：'),
    `  npx viva-source test ${folder}`,
    copy('  After it passes, choose this folder using Settings → Sources → Install source… in Viva.', '  通过后在 Viva 的设置「消息源」里点「安装消息源…」选这个文件夹。'),
  ].filter(Boolean).join('\n') + '\n')
}

const [command, ...rest] = process.argv.slice(2)
const { positional, options } = parse(rest)
language = options.language ?? 'en'
if (!['en', 'zh-CN'].includes(language)) fail('Unsupported language. Use en or zh-CN.')
if (command === 'test' && positional.length === 1) await test(positional[0], options)
else if (command === 'new' && positional.length === 1) create(positional[0], options)
else fail(USAGE)

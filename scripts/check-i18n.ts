import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

export interface TranslationPair { en: string; zh: string; enHash: string; zhHash: string }
export interface SourceReport { path: string; locale: 'en' | 'zh-CN'; sha256: string }
export interface TranslationManifest { sourceReports?: SourceReport[]; version: 1; reviewedOn: string; pairs: TranslationPair[]; bilingual: string[] }
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const digest = (text: string): string => createHash('sha256').update(text.replaceAll('\r\n', '\n')).digest('hex')
const slug = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-')
function anchors(text: string): Set<string> {
  const ids = new Set([...text.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]))
  const counts = new Map<string, number>()
  for (const match of text.matchAll(/^#{1,6}\s+(.+)$/gm)) {
    const id = slug(match[1].trim())
    const count = counts.get(id) ?? 0
    ids.add(count ? `${id}-${count}` : id)
    counts.set(id, count + 1)
  }
  return ids
}

/** Checks file freshness and local navigation, not semantic translation quality. */
export function checkDocumentation(base = root): string[] {
  const manifest = JSON.parse(fs.readFileSync(path.join(base, 'docs/i18n-manifest.json'), 'utf8')) as TranslationManifest
  const failures: string[] = []
  const registered = new Set(manifest.bilingual)
  for (const report of manifest.sourceReports ?? []) {
    if (!/^docs\/(?:qa-|(?:project|performance)-handoff-)[a-zA-Z0-9._-]+\.md$/.test(report.path) || !['en', 'zh-CN'].includes(report.locale)) {
      failures.push('Invalid source report registration: ' + report.path); continue
    }
    registered.add(report.path)
    const full = path.join(base, report.path)
    if (!fs.existsSync(full)) failures.push('Missing source report: ' + report.path)
    else if (digest(fs.readFileSync(full, 'utf8')) !== report.sha256) failures.push('Source report review required: ' + report.path)
  }
  for (const pair of manifest.pairs) {
    for (const [file, other, expected] of [[pair.en, pair.zh, pair.enHash], [pair.zh, pair.en, pair.zhHash]]) {
      registered.add(file)
      const full = path.join(base, file)
      if (!fs.existsSync(full)) { failures.push(`Missing translation: ${file}`); continue }
      const text = fs.readFileSync(full, 'utf8')
      if (digest(text) !== expected) failures.push(`Translation review required: ${file}`)
      if (!text.includes(`](${path.basename(other)})`)) failures.push(`Missing language navigation: ${file}`)
      // Ignore fenced examples; check Markdown and HTML image references without fetching remote URLs.
      const prose = text.replace(/```[^\n]*\n[\s\S]*?```/g, '')
      const targets = [...prose.matchAll(/\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g), ...prose.matchAll(/\bsrc="([^"]+)"/g)]
      for (const match of targets) {
        const [target, anchor] = match[1].replace(/^<|>$/g, '').split('#')
        if (/^[a-z][a-z\d+.-]*:/i.test(target)) continue
        const destination = target ? path.resolve(path.dirname(full), decodeURIComponent(target)) : full
        if (!fs.existsSync(destination)) failures.push(`Broken local link: ${file} -> ${target}`)
        else if (anchor && destination.endsWith('.md') && !anchors(fs.readFileSync(destination, 'utf8')).has(decodeURIComponent(anchor))) failures.push(`Broken anchor: ${file} -> ${target}#${anchor}`)
      }
    }
  }
  const docs = fs.readdirSync(path.join(base, 'docs'), { recursive: true }).filter((p): p is string => typeof p === 'string' && p.endsWith('.md')).map(p => `docs/${p.replaceAll('\\', '/')}`)
  for (const file of ['README.md', 'README.zh-CN.md', 'AGENTS.md', 'packages/viva-source-kit/README.md', ...docs]) {
    if (!registered.has(file)) failures.push(`Unregistered document: ${file}`)
  }
  return failures
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const failures = checkDocumentation()
  if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1 }
  else console.log('Documentation pairs, review hashes, and local file links are current.')
}

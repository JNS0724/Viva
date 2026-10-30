import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkDocumentation, digest, type TranslationManifest } from '../scripts/check-i18n.ts'

test('original-language QA report registration stays hash checked and cannot exempt a product guide', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'viva-source-report-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'docs'))
  const manifest: TranslationManifest = { version: 1, reviewedOn: '2026-10-30', pairs: [],
    bilingual: ['README.md', 'README.zh-CN.md', 'AGENTS.md', 'packages/viva-source-kit/README.md'],
    sourceReports: [{ path: 'docs/qa-evidence.md', locale: 'zh-CN', sha256: digest('原始证据') }] }
  const save = () => fs.writeFileSync(path.join(root, 'docs/i18n-manifest.json'), JSON.stringify(manifest))
  fs.writeFileSync(path.join(root, 'docs/qa-evidence.md'), '原始证据'); save()
  assert.deepEqual(checkDocumentation(root), [])
  fs.writeFileSync(path.join(root, 'docs/qa-evidence.md'), '已改变的证据')
  assert.deepEqual(checkDocumentation(root), ['Source report review required: docs/qa-evidence.md'])
  manifest.sourceReports![0].sha256 = digest('已改变的证据')
  fs.writeFileSync(path.join(root, 'docs/user-guide.md'), '产品指南')
  manifest.sourceReports!.push({ path: 'docs/user-guide.md', locale: 'zh-CN', sha256: digest('产品指南') }); save()
  assert.deepEqual(checkDocumentation(root), ['Invalid source report registration: docs/user-guide.md', 'Unregistered document: docs/user-guide.md'])
})

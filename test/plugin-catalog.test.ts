import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CATALOG_LIMIT, DEFAULT_QUERY, searchCatalog, specFit, type PnpmCall } from '../src/backend/plugin-catalog.ts'

/**
 * The company source's plugins (plugin-catalog.ts): what its search finds, kept to dsh plugins, each with whether it
 * works in Viva from its own package.json; and the same said of a spec before it is installed.
 */
const PNPM: PnpmCall = { command: '/bin/pnpm', cwd: '/profile', args: ['--config.@co:registry=https://npm.example.com/', '--registry=https://npm.example.com/'], env: { TOKEN: 'set' } }

const plugin = (name: string, extra: object = {}) => ({ name, version: '1.0.0', description: `${name} does things`, dsh: { bundle: { patch: 'patch.yml' } }, ...extra })
const MANIFESTS: Record<string, object> = {
  'dsh-notes@1.0.0': plugin('dsh-notes'),
  'dsh-web-panel@1.0.0': plugin('dsh-web-panel', { dependencies: { '@deepseek-ai/dsh-web-app': '^1' } }),
  'left-pad@1.0.0': { name: 'left-pad', version: '1.0.0', description: 'not a plugin' },
}

/** pnpm as the tests have it: `search` answers `found`, `view` the manifests above; every call written down. */
function fakePnpm(found: Array<{ name: string, version: string, description?: string }>) {
  const calls: Array<readonly string[]> = []
  const run = async (call: PnpmCall, args: readonly string[]) => {
    assert.equal(call, PNPM, 'every run is the pnpm the plugin manager installs with')
    calls.push(args)
    if (args[0] === 'search') return JSON.stringify(found)
    const manifest = MANIFESTS[args[1]]
    if (!manifest) throw Object.assign(new Error('Command failed'), { stderr: 'ERR_PNPM_FETCH_404 Not Found' })
    return JSON.stringify(manifest)
  }
  return { run, calls }
}

test('the source\'s dsh plugins are listed, each with whether it works in Viva; packages that are not plugins are left out', async () => {
  const { run, calls } = fakePnpm(['dsh-notes', 'left-pad', 'dsh-web-panel'].map((name) => ({ name, version: '1.0.0', description: `${name} does things` })))
  const answer = await searchCatalog({ query: 'notes', pnpm: PNPM, run })
  assert.deepEqual(answer, {
    ok: true,
    entries: [
      { name: 'dsh-notes', version: '1.0.0', description: 'dsh-notes does things', fit: { kind: 'no-conflict' } },
      { name: 'dsh-web-panel', version: '1.0.0', description: 'dsh-web-panel does things', fit: { kind: 'needs-web', needs: ['@deepseek-ai/dsh-web-app'] } },
    ],
  })
  assert.deepEqual(calls[0], ['search', 'notes', '--json', '--search-limit', String(CATALOG_LIMIT), ...PNPM.args], 'searched on the company source, its scopes pinned')
  assert.deepEqual(calls.slice(1).map((args) => args.slice(0, 3)).sort(), [['view', 'dsh-notes@1.0.0', '--json'], ['view', 'dsh-web-panel@1.0.0', '--json'], ['view', 'left-pad@1.0.0', '--json']])
})

test('nothing typed lists by the default word; words become separate keywords; what a shell would read is refused before pnpm runs', async () => {
  const quiet = fakePnpm([])
  assert.deepEqual(await searchCatalog({ query: '  ', pnpm: PNPM, run: quiet.run }), { ok: true, entries: [] })
  assert.deepEqual(quiet.calls[0].slice(0, 2), ['search', DEFAULT_QUERY])
  await searchCatalog({ query: ' 周报  notes ', pnpm: PNPM, run: quiet.run })
  assert.deepEqual(quiet.calls[1].slice(0, 3), ['search', '周报', 'notes'])

  for (const query of ['a&calc', 'x|y', '"quoted"', '%PATH%', 'a^b', 'x'.repeat(101)]) {
    const refused = fakePnpm([])
    assert.deepEqual(await searchCatalog({ query, pnpm: PNPM, run: refused.run }), { ok: false, problem: 'query', detail: null }, query)
    assert.deepEqual(refused.calls, [], `${query} never reaches pnpm`)
  }
})

test('without a company source nothing is searched; a search the source cannot do says why', async () => {
  const { run, calls } = fakePnpm([])
  assert.deepEqual(await searchCatalog({ query: 'notes', pnpm: null, run }), { ok: false, problem: 'no-source', detail: null })
  assert.deepEqual(calls, [])

  const failing = async () => { throw Object.assign(new Error('Command failed: pnpm search'), { stderr: 'ERR_PNPM_FETCH_404  GET /-/v1/search: Not Found - 404\n' }) }
  const answer = await searchCatalog({ query: 'notes', pnpm: PNPM, run: failing })
  assert.equal(answer.ok, false)
  assert.deepEqual(answer.ok ? null : [answer.problem, answer.detail], ['search', 'ERR_PNPM_FETCH_404  GET /-/v1/search: Not Found - 404'])
})

test('what the source answers is not trusted: names that are not package names are skipped, a manifest that cannot be read is unknown', async () => {
  const { run, calls } = fakePnpm([
    { name: 'evil&calc', version: '1.0.0' }, { name: 'dsh-notes', version: '1.0.0 || calc' }, { name: 'dsh-gone', version: '2.0.0', description: 'x' },
    { name: 'dsh-notes', version: '1.0.0', description: 'dsh-notes does things' },
  ])
  const answer = await searchCatalog({ query: 'notes', pnpm: PNPM, run })
  assert.deepEqual(answer, {
    ok: true,
    entries: [
      { name: 'dsh-gone', version: '2.0.0', description: 'x', fit: { kind: 'unknown' } },
      { name: 'dsh-notes', version: '1.0.0', description: 'dsh-notes does things', fit: { kind: 'no-conflict' } },
    ],
  })
  assert.ok(calls.every((args) => !args.some((arg) => arg.includes('calc'))), 'no name or version the source made up reaches pnpm')
})

test('before an install: a registry name is looked up, a folder read, anything else not told', async () => {
  const { run, calls } = fakePnpm([])
  assert.deepEqual(await specFit({ spec: 'dsh-web-panel@1.0.0', pnpm: PNPM, run }), { kind: 'needs-web', needs: ['@deepseek-ai/dsh-web-app'] })
  assert.deepEqual(calls[0], ['view', 'dsh-web-panel@1.0.0', '--json', ...PNPM.args])
  assert.deepEqual(await specFit({ spec: 'dsh-missing', pnpm: PNPM, run }), { kind: 'unknown' }, 'a lookup that fails tells nothing')

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viva-plugin-fit-'))
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(plugin('dsh-local', { viva: { supports: true } })))
    assert.deepEqual(await specFit({ spec: dir, pnpm: PNPM, run }), { kind: 'declared' })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }

  const before = calls.length
  for (const spec of ['github:me/dsh-x', 'https://example.com/x.tgz', 'dsh-x@^1.0.0', 'dsh-x@>1 <2', 'a&calc', '']) {
    assert.deepEqual(await specFit({ spec, pnpm: PNPM, run }), { kind: 'unknown' }, spec)
  }
  assert.equal(calls.length, before, 'none of them asks pnpm')
})

import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { registerMcpImportIpc } from '../src/backend/mcp-import-ipc.ts'
import type { ServerConfig } from '../src/backend/mcp-config.ts'

/** Bringing MCP servers in over IPC (mcp-import-ipc.ts): clients and scans by id, no secret to the window. */

const SECRET = 'ghp_example_secret'

function setup(t: TestContext, { shell = async () => ({ lookup: () => undefined, findCommand: (command: string) => (command === 'npx' || command === 'node' ? `/usr/bin/${command}` : null) }) } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-import-ipc-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'mcp.json')
  const write = (servers: Record<string, unknown>) => fs.writeFileSync(file, JSON.stringify({ mcpServers: servers }))
  let saved: ServerConfig[] = []
  let applied = 0
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  let ids = 0
  registerMcpImportIpc({ handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn) } as never, {
    store: { list: () => saved, addMany: (configs) => { saved = [...saved, ...configs] } },
    sources: () => [{ id: 'cursor', label: 'Cursor', file, count: 1 }],
    shell,
    applyMcp: async () => { applied++; return { mode: 'live' } },
    newId: () => `scan-${++ids}`,
  })
  const call = async (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args) as Promise<Record<string, any>>
  return { write, call, saved: () => saved, applied: () => applied, setSaved: (servers: ServerConfig[]) => { saved = servers } }
}

test('a client scanned by its id; the window sees names, how each connects and why, never a key or a path', async (t) => {
  const { write, call } = setup(t)
  write({ github: { command: 'npx', args: ['-y', 'server-github'], env: { GITHUB_TOKEN: SECRET } }, old: { type: 'sse', url: 'https://x/sse' } })
  const sources = await call('ext:mcp-sources')
  assert.deepEqual(sources.map((source: Record<string, unknown>) => [source.id, 'file' in source]), [['cursor', false]])
  const scan = await call('ext:scan-mcp', 'cursor')
  assert.deepEqual(scan.candidates.map((candidate: { entry: string, why: string, type: string | null }) => [candidate.entry, candidate.why, candidate.type]), [['github', 'ready', 'stdio'], ['old', 'sse', null]])
  assert.equal(JSON.stringify(scan).includes(SECRET), false, 'no key reaches the window')
  await assert.rejects(call('ext:scan-mcp', 'elsewhere'))
})

test('those ticked saved in one write, the servers attached once; what was done and what is left to fill in said', async (t) => {
  const { write, call, saved, applied } = setup(t)
  write({ github: { command: 'npx', env: { GITHUB_TOKEN: SECRET } }, sentry: { command: 'npx', env: { SENTRY_TOKEN: '${SENTRY_TOKEN}' } } })
  const scan = await call('ext:scan-mcp', 'cursor')
  const done = await call('ext:import-mcp', scan.scanId, ['github', 'sentry'])
  assert.deepEqual([done.imported, saved().map((server) => server.name), applied()], [['github', 'sentry'], ['github', 'sentry'], 1])
  assert.match(done.notice, /SENTRY_TOKEN/)
  assert.equal(JSON.stringify(done).includes(SECRET), false)
  assert.deepEqual(saved()[0].env, { GITHUB_TOKEN: SECRET }, 'the key itself is saved, encrypted by the store')
})

test('a name taken since it was shown: nothing saved, the new scan back to look at', async (t) => {
  const { write, call, saved, setSaved } = setup(t)
  write({ github: { command: 'npx' } })
  const shown = await call('ext:scan-mcp', 'cursor')
  setSaved([{ name: 'github', type: 'stdio', command: 'node', args: [], url: '', env: {}, headers: {}, missing: [] }])
  const answer = await call('ext:import-mcp', shown.scanId, ['github'])
  assert.equal(answer.changed, true)
  assert.deepEqual(answer.scan.candidates.map((candidate: { name: string, why: string }) => [candidate.name, candidate.why]), [['github-2', 'taken']])
  assert.equal(saved().length, 1, 'nothing saved under a name not shown')
})

test('changed in any part since shown (here http turned into a command of the same name): nothing saved, shown again', async (t) => {
  const { write, call, saved } = setup(t)
  write({ tools: { type: 'http', url: 'https://tools.example/mcp' } })
  const shown = await call('ext:scan-mcp', 'cursor')
  write({ tools: { command: 'node', args: ['other.js'] } })
  const answer = await call('ext:import-mcp', shown.scanId, ['tools'])
  assert.deepEqual([answer.changed, answer.scan.candidates[0].type, saved().length], [true, 'stdio', 0], 'a new command is never started without being seen')
  write({ tools: { command: 'node', args: ['other.js'], env: { TOKEN: 'b' } } })
  const again = await call('ext:import-mcp', answer.scan.scanId, ['tools'])
  assert.equal(again.changed, true, 'a key changed counts too')
})

test('a scan ending after a later one does not take its place; an import holds the scan it was asked about', async (t) => {
  const gates: Array<() => void> = []
  const slow = () => new Promise<void>((resolve) => { gates.push(resolve) })
  const tools = { lookup: () => undefined, findCommand: (command: string) => `/usr/bin/${command}` }
  const { write, call, saved } = setup(t, { shell: async () => { await slow(); return tools } })
  write({ a: { command: 'node' } })
  const first = call('ext:scan-mcp', 'cursor')
  const second = call('ext:scan-mcp', 'cursor')
  gates.shift()!()
  await new Promise((resolve) => setImmediate(resolve))
  gates.shift()!()
  const [one, two] = await Promise.all([first, second])
  await assert.rejects(call('ext:import-mcp', one.scanId, ['a']), 'the earlier scan is not the one shown last')
  const importing = call('ext:import-mcp', two.scanId, ['a'])
  const meanwhile = call('ext:scan-mcp', 'cursor')
  gates.shift()!()
  await assert.rejects(importing, 'a scan begun meanwhile ends the import, nothing saved')
  gates.shift()!()
  await meanwhile
  assert.equal(saved().length, 0)
})

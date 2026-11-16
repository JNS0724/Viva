/** Real DSH Web acceptance of the packed plugin. Every model call stays on the local fixture. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { spawn, execFileSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire, findPackageJSON } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { openMemoryOwner } from '../src/memory/node/owner.ts'
import { openMemoryStore } from '../src/memory/node/memory-store.ts'
import { openMemoryDocuments } from '../src/memory/node/memory-document-store.ts'
import { memorySourceToken, memorySourceWorkspace } from '../src/memory/node/source-identity.ts'
import type { HostMemoryApi } from '../src/memory/contracts/host.ts'
import { buildMemoryPlugin } from './build-memory-plugin.ts'
import { startFakeLlm } from '../test/fixtures/fake-llm.ts'
import { createVenueModelFixture, venue } from '../test/fixtures/memory-plugin-venue.ts'

const project = path.resolve(import.meta.dirname, '..')
const require = createRequire(import.meta.url)
const output = path.join(project, 'smoke/memory-plugin')
const temporary = mkdtempSync(path.join(os.tmpdir(), 'viva-plugin-web-'))
const dataRoot = path.join(temporary, 'memory')
const home = path.join(temporary, 'home')
const workspace = path.join(temporary, 'workspace')
const installed = path.join(temporary, 'installed')
for (const dir of [output, home, workspace, installed]) mkdirSync(dir, { recursive: true })
const marker = '周报每周五下班前提交，保留项目决定和依据。'
const erased = '银杏编号被指定移出独立会话'
const kept = '白茶依然放在正方形桌上'
const original = `${erased}，${kept}。`
const sessionsRoot = path.join(home, 'sessions')
const storageRoot = path.join(home, 'storages')
const redact = (text: string) => text.replace(/https?:\/\/[^\s\x1b]+/gu, value => {
  try { const url = new URL(value); url.search = ''; url.hash = ''; return url.toString() } catch { return '[URL REDACTED]' }
})
function collectMarkdown(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? collectMarkdown(path.join(dir, entry.name)) : entry.isFile() && entry.name.endsWith('.md') ? [path.join(dir, entry.name)] : [])
}
async function until(check: () => boolean, label: string, timeout = 30_000) {
  const end = Date.now() + timeout
  while (!check()) { if (Date.now() >= end) throw new Error(`Timed out: ${label}`); await delay(100) }
}
function noteProgress() {
  const db = new DatabaseSync(path.join(dataRoot, 'memory.db'), { readOnly: true })
  try {
    const row = db.prepare('SELECT key,revision,processed FROM memory_daily_notes ORDER BY processed DESC LIMIT 1').get()
    return row ? { key: String(row.key), revision: Number(row.revision), processed: Number(row.processed) } : null
  } finally { db.close() }
}
function noteContextGeneration(key: string) {
  const identity: unknown = JSON.parse(key)
  assert.ok(Array.isArray(identity) && typeof identity[1] === 'string')
  const db = new DatabaseSync(path.join(dataRoot, 'memory.db'), { readOnly: true })
  try { return Number(db.prepare('SELECT generation FROM owner_context_generations WHERE session=?').get(identity[1])?.generation ?? 0) }
  finally { db.close() }
}
async function nativeMessages(session: string) {
  const ctx = new Context(), mounted = await ctx.plugin(jsonl, { root: sessionsRoot, compression: 'zstd' })
  try {
    const reader = await ctx.sessionPersistence.open(SessionId(session), 'read')
    try {
      return (await reader.read()).events.flatMap(event => event.type === 'user/message' && event.data.source.kind === 'user'
        ? event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []) : [])
    } finally { await reader.close() }
  } finally { await mounted.dispose() }
}

/** Exercise the shared trusted owner operation while Web is stopped. Web has no memory management page. */
async function prepareStandaloneForget() {
  const owner = openMemoryOwner({ root: dataRoot, dailyNotes: true,
    compute: () => null, route: () => null, quiesce: async () => {} })
  try {
    await owner.recover()
    const store = openMemoryStore(path.join(dataRoot, 'memory.db'))
    try {
      const row = store.db.prepare('SELECT id FROM memory_sources WHERE text=? AND withdrawn=0').get(original)
      const source = typeof row?.id === 'string' ? store.readSource(row.id) : undefined
      assert.ok(source?.session, 'Web must have admitted the original human source')
      const workspace = memorySourceWorkspace(source)
      const documents = openMemoryDocuments({ db: store.db, root: store.fileRoot, source(id) {
        const current = store.readSource(id)
        return current?.text ? { text: current.text, workspace: memorySourceWorkspace(current), token: memorySourceToken(current) } : undefined
      } })
      const created = documents.commit({ operationId: randomUUID(), workspace, path: 'digest/wiki/standalone-erasure-probe.md',
        expectedRevision: null, action: 'CREATE', markdown: erased, sources: [{ id: source.id, token: memorySourceToken(source),
          spans: [{ start: 0, end: erased.length }] }], reads: [] })
      assert.ok(created?.documentId)
      const identity = { kind: 'digest' as const, workspace, id: created.documentId }
      const file = await owner.handleHost('readFile', { args: [identity] }) as HostMemoryApi['readFile']['output']
      assert.ok(file)
      const operationId = randomUUID()
      await owner.handleHost('forgetFile', { args: [{ operationId, identity, version: file.version }] })
      const plan = store.db.prepare('SELECT payload FROM owner_file_native_erasures WHERE operation=?').get(operationId)
      assert.ok(plan && JSON.parse(String(plan.payload)).originals.length, 'owner must authenticate the exact native original before shutdown')
      assert.ok((await nativeMessages(source.session)).includes(original), 'the old physical native log still contains the target')
      return { operationId, session: source.session }
    } finally { store.close() }
  } finally { await owner.close() }
}

async function stop(proc: ChildProcess | undefined) {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return
  proc.kill('SIGTERM')
  await Promise.race([new Promise<void>(resolve => proc.once('exit', () => resolve())), delay(5_000)])
  if (proc.exitCode === null && proc.signalCode === null) {
    proc.kill('SIGKILL')
    await new Promise<void>(resolve => proc.once('exit', () => resolve()))
  }
}
function installArtifact() {
  const artifact = path.join(temporary, 'artifact')
  buildMemoryPlugin({ destination: artifact, compiledRoot: path.join(temporary, 'compiled') })
  const npm = process.env.npm_execpath ?? (process.env.PATH ?? '').split(path.delimiter).map(dir => path.join(dir, 'npm')).find(file => existsSync(file))
  if (!npm) throw new Error('Run through npm run smoke:memory-plugin')
  const run = (args: string[], cwd = temporary) => execFileSync(process.execPath, [realpathSync(npm), ...args, '--cache', path.join(temporary, 'cache')], {
    cwd, encoding: 'utf8', timeout: 60_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  const pack = (source: string) => {
    const result: unknown = JSON.parse(run(['pack', source, '--offline', '--ignore-scripts', '--json', '--pack-destination', temporary]))
    assert.ok(Array.isArray(result) && result.length === 1)
    const item: unknown = result[0]
    assert.ok(item && typeof item === 'object' && 'filename' in item && typeof item.filename === 'string')
    return path.join(temporary, item.filename)
  }
  const packageRoot = (name: string) => {
    const manifest = findPackageJSON(name, import.meta.url)
    if (!manifest) throw new Error('Missing installed package: ' + name)
    return path.dirname(manifest)
  }
  const plugin = pack(artifact)
  const dependencies = ['yaml', 'zod', 'marked'].map(name => pack(packageRoot(name)))
  writeFileSync(path.join(installed, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
  run(['install', plugin, ...dependencies, '--offline', '--ignore-scripts', '--legacy-peer-deps', '--no-audit', '--no-fund', '--package-lock=false'], installed)
  const manifest = JSON.parse(readFileSync(path.join(installed, 'node_modules/viva-memory/package.json'), 'utf8')) as { peerDependencies: Record<string, string> }
  // Use the same installed DSH runtime as the Web CLI. Only peers are shared; the plugin and own
  // runtime dependencies come from npm tarballs in this otherwise empty installation.
  for (const name of Object.keys(manifest.peerDependencies)) {
    const target = path.join(installed, 'node_modules', name)
    mkdirSync(path.dirname(target), { recursive: true })
    symlinkSync(packageRoot(name), target, 'junction')
  }
  rmSync(artifact, { recursive: true })
  rmSync(path.join(temporary, 'compiled'), { recursive: true })
  return path.join(installed, 'node_modules/viva-memory/index.js')
}
const venueModel = createVenueModelFixture()
const llm = await startFakeLlm({ decideFirst: (request: object) => {
  const venueReply = venueModel.decide(request)
  if (venueReply) return venueReply
  const input = request as { system?: unknown, tools?: Array<{ name?: string }>, messages?: Array<{ role?: string, content?: string | Array<{ type?: string, name?: string, text?: string }> }> }
  if (JSON.stringify(input.system).includes('整理最近完成的会话回合')) return {
    text: JSON.stringify({ status: 'write', title: '周报约定', markdown: `# 周报约定\n\n${marker}`, filename: 'weekly-summary' }),
  }
  const assistant = input.messages?.filter(message => message.role === 'assistant').at(-1)
  const tool = Array.isArray(assistant?.content) ? assistant.content.find(part => part.type === 'tool_use') : undefined
  if (tool?.name === 'memory_recall' && JSON.stringify(input.messages?.at(-1)).includes('tool_result')) {
    return { text: `查到了：${JSON.stringify(input.messages?.at(-1)).includes(marker) ? marker : '没有相关记忆'}` }
  }
  const lastUser = input.messages?.findLast(message => message.role === 'user')
  const blocks = Array.isArray(lastUser?.content) ? lastUser.content.flatMap(part => part.type === 'text' && part.text ? [part.text] : []) : []
  // Native providers coalesce adjacent user messages into one array of content blocks.
  // The shared fixture reads only its first block; recovery history precedes the new
  // question here. Require the actual latest question, not a match in retained history.
  const latestText = blocks.filter(text => !text.trim().startsWith('<')).at(-1)
  if (input.tools?.some(tool => tool.name === 'memory_recall') && latestText?.startsWith('查一下 ')) {
    return { tool: { name: 'memory_recall', input: { query: latestText.slice(4).trim() } } }
  }
  return null
} })
let proc: ChildProcess | undefined
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
let log = ''
let passed = false
const errors: string[] = []
try {
  const plugin = installArtifact()
  const patch = path.join(temporary, 'memory.patch.yml')
  const persistence = pathToFileURL(createRequire(path.join(installed, 'package.json')).resolve('viva-memory/persistence')).href
  writeFileSync(patch, `- id: session-log-deepseek\n  config:\n    enabled: false\n- id: session-persistence-jsonl\n  disabled: true\n- insert:\n    - id: viva-memory-session-persistence\n      name: ${JSON.stringify(persistence)}\n      config:\n        root: ${JSON.stringify(sessionsRoot)}\n        storageRoot: ${JSON.stringify(storageRoot)}\n        memoryRoot: ${JSON.stringify(dataRoot)}\n    - id: portable-memory\n      name: ${JSON.stringify(pathToFileURL(plugin).href)}\n      inject: [sessionPersistence]\n      config:\n        dataRoot: ${JSON.stringify(dataRoot)}\n        dailyNotes: true\n`)
  browser = await chromium.launch({ headless: true })
  const launch = async () => {
    let launchLog = ''
    proc = spawn(process.execPath, [require.resolve('@deepseek-ai/dsh/lib/bin.js'), '--profile', 'web', '--patch', patch, '--no-open', '--port', '0'], {
      cwd: workspace,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, SystemRoot: process.env.SystemRoot,
        DSH_HOME: home, DEEPSEEK_API_KEY: 'test-fake-key', DEEPSEEK_BASE_URL: llm.url, NO_PROXY: '127.0.0.1,localhost' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    proc.on('error', error => errors.push(error.message))
    proc.stdout?.on('data', data => { launchLog += String(data); log += String(data) })
    proc.stderr?.on('data', data => { launchLog += String(data); log += String(data) })
    await until(() => /https?:\/\/(?:127\.0\.0\.1|localhost)[^\s\x1b]+/u.test(launchLog) || proc?.exitCode !== null || errors.length > 0, 'DSH Web startup')
    const url = launchLog.match(/https?:\/\/(?:127\.0\.0\.1|localhost)[^\s\x1b]+/u)?.[0]
    assert.ok(url, 'DSH Web must report its local URL')
    const page = await browser!.newPage({ locale: 'en-US' })
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(url)
    const editor = page.locator('textarea,[contenteditable=true]').first()
    await editor.waitFor({ state: 'visible', timeout: 30_000 })
    const proceed = page.getByRole('button', { name: 'Continue', exact: true })
    if (await proceed.isVisible()) await proceed.click()
    return page
  }
  const send = async (page: Page, text: string, expected: string | RegExp) => {
    const previousReplies = await page.getByText(expected, { exact: false }).count()
    const editor = page.locator('textarea,[contenteditable=true]').first()
    await editor.click()
    await editor.pressSequentially(text, { delay: 5 })
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await expect.poll(() => page.getByText(expected, { exact: false }).count(), { timeout: 30_000 }).toBeGreaterThan(previousReplies)
    await page.getByText(expected, { exact: false }).last().waitFor({ state: 'visible', timeout: 30_000 })
    await page.getByRole('button', { name: 'Send message', exact: true }).waitFor({ state: 'visible', timeout: 30_000 })
  }
  let page = await launch()
  await send(page, `记住：${marker}`, /好的，我记住了|已收到，稍后整理/u)
  await until(() => collectMarkdown(dataRoot).some(file => file.includes(`${path.sep}digest${path.sep}`) && readFileSync(file, 'utf8').includes(marker)), 'explicit memory file committed')
  {
    const explicit = 'The oriole release checklist has four stages.'
    const saved = /Saved memory ([a-f0-9-]{36})\./u
    await send(page, `/memory-remember ${explicit}`, saved)
    const id = (await page.getByText(saved).last().textContent())?.match(saved)?.[1]
    assert.ok(id)
    assert.ok(collectMarkdown(dataRoot).some(file => readFileSync(file, 'utf8').includes(explicit)))
    assert.ok(!JSON.stringify(llm.requests).includes(explicit), 'the native command does not send its input to the model')
    await send(page, `/memory-forget ${id}`, /Memory (?:is no longer used\. Copy cleanup is pending|copies have been erased)\./u)
    await until(() => !collectMarkdown(dataRoot).some(file => readFileSync(file, 'utf8').includes(explicit)), 'native forget clears Markdown')
    assert.ok(!JSON.stringify(llm.requests).includes(explicit))
    await page.screenshot({ path: path.join(output, 'web-file-command-receipts.png'), fullPage: true })
  }
  await send(page, '查一下 周报', '查到了：')
  for (let turn = 1; turn <= 3; turn++) await send(page, `周报进展第 ${turn} 次：已经确认交付安排。`, `收到：「周报进展第 ${turn} 次`)
  await until(() => collectMarkdown(dataRoot).some(file => file.includes(`${path.sep}daily${path.sep}`) && readFileSync(file, 'utf8').includes(marker)), 'completed conversation daily note')
  let recoveredGeneration = 0
  {
    await send(page, '查一下 周报', `查到了：${marker}`)
    const original = noteProgress()
    assert.ok(original)
    const previousGeneration = noteContextGeneration(original.key)
    // Reading this card establishes a file dependency. Updating the same card must
    // retire the old native context before the next request, not strand the session.
    for (let turn = 4; turn <= 7; turn++) await send(page, `周报进展第 ${turn} 次：已经确认交付安排。`, `收到：「周报进展第 ${turn} 次`)
    await until(() => {
      const current = noteProgress()
      return current?.key === original.key && current.revision > original.revision
    }, 'same-session daily revision advances')
    await send(page, '查一下 周报', `查到了：${marker}`)
    recoveredGeneration = noteContextGeneration(original.key)
    assert.ok(recoveredGeneration > previousGeneration, 'this same session is durably rebuilt after the next daily update')
  }
  const requestText = JSON.stringify(llm.requests)
  assert.ok(requestText.includes('memory_remember') && requestText.includes('memory_recall'), 'native tools reach the model')
  assert.ok(llm.requests.some(request => JSON.stringify(request).includes('<about-user>') && JSON.stringify(request).includes(marker)), 'saved memory reaches an injected model request')
  await send(page, original, `收到：「${erased}`)
  const beforeRestart = collectMarkdown(dataRoot).map(file => path.relative(dataRoot, file))
  await page.screenshot({ path: path.join(output, 'web-before-restart.png'), fullPage: true })
  await page.close()
  await stop(proc)
  proc = undefined
  const forget = await prepareStandaloneForget()
  page = await launch()
  if (forget) {
    await until(() => {
      const db = new DatabaseSync(path.join(dataRoot, 'memory.db'), { readOnly: true })
      try {
        return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE name='owner_native_original_completed'").get())
          && Boolean(db.prepare('SELECT 1 FROM owner_native_original_completed WHERE operation=?').get(forget.operationId))
      } finally { db.close() }
    }, 'the packed provider commits its cold original receipt')
    const persisted = await nativeMessages(forget.session)
    assert.ok(!persisted.some(text => text.includes(erased)), 'the replacement provider opens only after physical originals are erased')
    assert.ok(persisted.some(text => text === ' '.repeat(erased.length) + original.slice(erased.length)), 'the disjoint part of the same native message survives unchanged')
  }
  const postRestart = llm.requests.length
  await send(page, '查一下 周报', '查到了：')
  assert.ok(!forget || llm.requests.slice(postRestart).every(request => !JSON.stringify(request).includes(erased)),
    'the first restarted model requests receive no erased original')

  assert.ok((await page.locator('body').innerText()).includes(marker), 'memory survives ordinary Node DSH restart')
  await page.screenshot({ path: path.join(output, 'web-after-restart.png'), fullPage: true })

  // Only browser-originated human turns produce these canonical sources and
  // the daily note. The sole fixture mutation below advances the persisted
  // scheduler deadline while the real Web owner is stopped.
  writeFileSync(path.join(output, 'web-before-venue-aria.yml'), await page.locator('body').ariaSnapshot())
  // The visible caption is "New Session"; the public AX label is "New session".
  await page.getByRole('button', { name: 'New session', exact: true }).last().click()
  await page.locator('textarea,[contenteditable=true]').first().waitFor({ state: 'visible', timeout: 30_000 })
  for (const fact of venue.facts) await send(page, fact, `收到：「${fact}`)
  const venueDaily = () => collectMarkdown(dataRoot).filter(file => file.includes(`${path.sep}daily${path.sep}`)
    && venue.facts.every(fact => readFileSync(file, 'utf8').includes(fact)))
  await until(() => venueDaily().length > 0, 'the venue human turns reach a real daily file')
  await page.close(); await stop(proc); proc = undefined
  {
    const db = new DatabaseSync(path.join(dataRoot, 'memory.db'))
    try {
      assert.equal(db.prepare("UPDATE effects SET due_at=0 WHERE kind='memory.dream'").run().changes, 1,
        'accelerate only the already-persisted dream schedule')
    } finally { db.close() }
  }
  page = await launch()
  let deferredId = ''
  const readDream = <T>(read: (db: DatabaseSync) => T): T => {
    const db = new DatabaseSync(path.join(dataRoot, 'memory.db'), { readOnly: true })
    try { return read(db) } finally { db.close() }
  }
  await until(() => readDream(db => {
    const row = db.prepare("SELECT operation FROM memory_document_deferred WHERE state='pending_clarification' AND payload LIKE ?")
      .get(`%${venue.topic}%`)
    deferredId = typeof row?.operation === 'string' ? row.operation : ''
    return Boolean(deferredId)
  }), 'real Extract and Integrate defer an ambiguous venue')
  assert.deepEqual(venueModel.report().stages, ['extract', 'integrate:deferred'])
  assert.equal(await page.getByPlaceholder('Type your answer', { exact: true }).count(), 0,
    'the background dream never asks the user')
  const queryStart = llm.requests.length
  await send(page, '帮我确认窗口对齐就好', '收到：「帮我确认窗口对齐就好')
  assert.equal(await page.getByPlaceholder('Type your answer', { exact: true }).count(), 0)
  assert.ok(llm.requests.slice(queryStart).every(request => {
    const input = request as { messages?: Array<{ role?: string, content?: unknown }> }
    return !input.messages?.some(message => message.role === 'assistant' && Array.isArray(message.content)
      && message.content.some((part: unknown) => part && typeof part === 'object' && 'type' in part && part.type === 'tool_use'
        && 'name' in part && part.name === 'memory_clarify'))
  }),
    'an unrelated turn does not initiate a native clarification call')
  await page.screenshot({ path: path.join(output, 'web-dream-deferred.png'), fullPage: true })
  const questionEditor = page.locator('textarea,[contenteditable=true]').first()
  await questionEditor.fill(`查一下 ${venue.topic}`)
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  const answer = page.getByPlaceholder('Type your answer', { exact: true })
  await answer.waitFor({ state: 'visible', timeout: 30_000 })
  writeFileSync(path.join(output, 'web-dream-question-aria.yml'), await page.locator('body').ariaSnapshot())
  await page.screenshot({ path: path.join(output, 'web-dream-question.png'), fullPage: true })
  await answer.fill(venue.answer)
  await page.getByRole('button', { name: 'Submit', exact: true }).click()
  await page.getByText(venue.completed, { exact: false }).last().waitFor({ state: 'visible', timeout: 30_000 })
  await until(() => readDream(db => db.prepare('SELECT state FROM memory_document_deferred WHERE operation=?').get(deferredId)?.state === 'resolved'),
    'the genuine Web answer resolves the original deferred work')
  await until(() => collectMarkdown(dataRoot).some(file => file.endsWith(venue.target.split('/').join(path.sep))
    && readFileSync(file, 'utf8').includes(venue.summary) && readFileSync(file, 'utf8').includes('memory_tags:')), 'the verified and tagged digest is committed')
  const dream = venueModel.report()
  assert.deepEqual(dream.stages, ['extract', 'integrate:deferred', 'integrate:resumed', 'verify', 'tag'],
    'the same dormant work resumes without another Extract')
  assert.deepEqual(new Set(dream.tools), new Set(['node_search', 'read', 'frontmatter_read', 'write', 'edit', 'frontmatter_update']))
  const checkpoint = readDream(db => {
    const receipt = db.prepare('SELECT receipt FROM memory_document_receipts WHERE operation=?').get(deferredId)
    assert.ok(receipt, 'the original deferred operation owns the committed document receipt')
    const saved = JSON.parse(String(receipt.receipt)) as { path: string }
    assert.equal(saved.path, venue.target)
    const notes = db.prepare('SELECT path,revision,processed FROM memory_daily_notes').all()
      .filter(note => venueDaily().some(file => file.endsWith(String(note.path).split('/').join(path.sep))))
    assert.ok(notes.length && notes.every(note => note.revision === note.processed), 'successful dream checkpoints all of its real daily inputs')
    assert.equal(db.prepare('SELECT count(*) n FROM memory_document_answers WHERE deferred=?').get(deferredId)?.n, 1,
      'the native Web answer is admitted once')
    return { operationId: deferredId, notes }
  })
  await page.screenshot({ path: path.join(output, 'web-dream-resolved.png'), fullPage: true })
  assert.deepEqual(errors, [])
  const report = { packedArtifact: true, isolatedInstallation: true, dshPeers: 'existing installed 0.2.2-rc.2 runtime', ordinaryNode: true,
    ipcParent: false, nativeRemember: true, nativeRecall: true, injection: true, dailyNotes: beforeRestart,
    standaloneFileCommands: true, sameSessionDailyUpdate: true, recoveredGeneration, coldPhysicalOriginals: Boolean(forget), restart: true,
    dream: { stages: dream.stages, tools: dream.tools, canonicalSources: dream.canonicalSources.length, checkpoint },
    nativeWebClarification: true, unrelatedTurnDoesNotAsk: true, modelRequests: llm.requests.length, pageErrors: errors }
  writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
  passed = true
} catch (error) {
  const page = browser?.contexts().flatMap(context => context.pages()).at(-1)
  if (page && !page.isClosed()) {
    await page.screenshot({ path: path.join(output, 'web-failure.png'), fullPage: true }).catch(() => {})
    writeFileSync(path.join(output, 'web-failure.txt'), await page.locator('body').innerText().catch(() => 'Page unavailable'))
    writeFileSync(path.join(output, 'web-failure-aria.yml'), await page.locator('body').ariaSnapshot().catch(() => 'Page unavailable'))
  }
  writeFileSync(path.join(output, 'report.json'), JSON.stringify({ passed: false, error: error instanceof Error ? error.message : String(error), modelRequests: llm.requests.length, pageErrors: errors }, null, 2) + '\n')
  throw error
} finally {
  if (browser) await browser.close()
  await stop(proc)
  await llm.close()
  if (!passed && existsSync(dataRoot)) cpSync(dataRoot, path.join(output, 'failed-data'), { recursive: true })
  writeFileSync(path.join(output, 'model-requests.json'), JSON.stringify(llm.requests, null, 2) + '\n')
  writeFileSync(path.join(output, 'launch-redacted.log'), redact(log))
  rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

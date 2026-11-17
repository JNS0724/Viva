import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { assembleMemoryPlugin, buildMemoryPlugin } from '../scripts/build-memory-plugin.ts'
import { MEMORY_HOST_PROTOCOL } from '../src/memory/contracts/host.ts'
import { runOfflineNpm } from './fixtures/offline-npm.ts'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)

test('offline npm failures retain stages and error codes without exposing raw configuration', t => {
  const dir = scratch(t)
  mkdirSync(path.join(dir, 'cache/_logs'), { recursive: true })
  writeFileSync(path.join(dir, 'cache/_logs', 'z-prior-pack-debug-0.log'), '0 timing reify:unpack Completed in 99999ms\n')
  assert.throws(() => runOfflineNpm({ node: process.execPath, cli: fileURLToPath(new URL('./fixtures/offline-npm-failure.ts', import.meta.url)),
    command: 'install', args: [], cwd: dir, cache: path.join(dir, 'cache') }), (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /npm install failed.*status=7/u)
    assert.match(error.message, /timing reify:unpack 17ms/u)
    assert.match(error.message, /silly idealTree/u)
    assert.match(error.message, /npm error EOFFLINE/u)
    assert.ok(!error.message.includes('PRIVATE_NPM_CONFIG_MUST_NOT_APPEAR'))
    assert.ok(!error.message.includes('private/location'))
    assert.ok(!error.message.includes('99999ms'), 'the previous pack must not be reported as the failed install')
    return true
  })
})

test('offline npm remains bounded and reports the actual timeout without retrying', t => {
  const dir = scratch(t)
  assert.throws(() => runOfflineNpm({ node: process.execPath, cli: fileURLToPath(new URL('./fixtures/offline-npm-failure.ts', import.meta.url)),
    command: 'install', args: ['hang'], cwd: dir, cache: path.join(dir, 'cache'), timeoutMs: 250 }), /code=ETIMEDOUT/u)
})

function scratch(t: test.TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'viva-memory-package-'))
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  return dir
}
function put(root: string, file: string, text: string) {
  const target = path.join(root, file)
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, text)
}

test('standalone assembly contains its module graph and refuses host imports before replacing output', t => {
  const dir = scratch(t)
  const compiledRoot = path.join(dir, 'compiled')
  const destination = path.join(dir, 'artifact')
  put(compiledRoot, 'plugins/memory/index.js', "export { value } from '../../src/memory/node/index.js'\n")
  put(compiledRoot, 'src/memory/node/index.js', "export const value = 42\n")
  const result = assembleMemoryPlugin({ compiledRoot, destination })
  assert.equal(result.modules, 2)
  assert.match(readFileSync(path.join(destination, 'index.js'), 'utf8'), /\.\/memory\/node\/index\.js/u)
  assert.ok(existsSync(path.join(destination, 'memory/node/index.js')))
  put(compiledRoot, 'plugins/memory/index.js', "import '../../src/backend/compose.js'\n")
  put(compiledRoot, 'src/backend/compose.js', 'throw new Error("must never ship")\n')
  assert.throws(() => assembleMemoryPlugin({ compiledRoot, destination }), /Missing compiled dependency|repository-only/u)
  assert.match(readFileSync(path.join(destination, 'index.js'), 'utf8'), /\.\/memory\/node/u)
  put(compiledRoot, 'plugins/memory/index.js', "import 'undeclared-runtime-package'\n")
  assert.throws(() => assembleMemoryPlugin({ compiledRoot, destination }), /Undeclared dependency/u)
  assert.throws(() => assembleMemoryPlugin({ compiledRoot, destination: compiledRoot }), /outside source/u)
})

test('npm-packed JS artifact installs offline and its Node API works without the development tree or DSH', { timeout: 90_000 }, t => {
  const dir = scratch(t)
  const artifact = path.join(dir, 'artifact')
  buildMemoryPlugin({ destination: artifact, compiledRoot: path.join(dir, 'compiled') })
  // npm test always supplies the real npm CLI. The fallback supports direct local Node runs on Unix.
  const npm = process.env.npm_execpath ?? (process.platform === 'win32' ? undefined : (process.env.PATH ?? '').split(path.delimiter).map(dir => path.join(dir, 'npm')).find(file => existsSync(file)))
  if (!npm || !existsSync(npm)) throw new Error('Run the package acceptance test through npm')
  const node = process.env.npm_node_execpath ?? process.execPath
  const cache = path.join(dir, 'npm-cache')
  const npmRun = (command: 'pack' | 'install', args: string[], cwd = dir) => runOfflineNpm({ node, cli: realpathSync(npm), command, args, cwd, cache })
  const pack = (source: string) => {
    const output: unknown = JSON.parse(npmRun('pack', [source, '--offline', '--ignore-scripts', '--json', '--pack-destination', dir]))
    assert.ok(Array.isArray(output) && output.length === 1)
    const item: unknown = output[0]
    assert.ok(item && typeof item === 'object' && 'filename' in item && typeof item.filename === 'string')
    return path.join(dir, item.filename)
  }
  const tarball = pack(artifact)
  const libraries = ['zod', 'yaml', 'marked'].map(name => pack(path.dirname(require.resolve(`${name}/package.json`))))
  const clean = path.join(dir, 'clean-project')
  mkdirSync(clean)
  writeFileSync(path.join(clean, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
  npmRun('install', [tarball, ...libraries, '--offline', '--ignore-scripts', '--legacy-peer-deps', '--no-audit', '--no-fund', '--package-lock=false'], clean)
  // Hide the build output: execution must resolve the installed tarball's own JS and dependencies.
  rmSync(artifact, { recursive: true })
  rmSync(path.join(dir, 'compiled'), { recursive: true })
  const code = `
    import assert from 'node:assert/strict';
    import { createRequire } from 'node:module';
    import { openMemoryOwner } from 'viva-memory/node';
    import { randomUUID } from 'node:crypto';
    import { parseHostMemoryCommand, memoryDomainErrorCode, combineMemoryProvenance, MEMORY_HOST_PROTOCOL } from 'viva-memory/contracts';
    assert.equal(MEMORY_HOST_PROTOCOL, ${MEMORY_HOST_PROTOCOL});
    assert.deepEqual(parseHostMemoryCommand('listFiles', { args: [{}] }), { method: 'listFiles', input: { args: [{}] } });
    assert.throws(() => parseHostMemoryCommand('addMemory', { args: ['obsolete'] }));
    assert.throws(() => parseHostMemoryCommand('internalRuntimeProperty', { args: [] }));
    assert.equal(memoryDomainErrorCode.parse('revision.conflict'), 'revision.conflict');
    assert.equal(memoryDomainErrorCode.safeParse('unrecognized').success, false);
    assert.deepEqual(combineMemoryProvenance(null, { sources: ['original'], epoch: 1, turnOnly: false }).sources, ['original']);
    const require = createRequire(import.meta.url);
    assert.throws(() => require.resolve('@deepseek-ai/dsh'));
    assert.throws(() => require.resolve('electron'));
    assert.equal(process.send, undefined);
    const options = { root: 'memory', compute:()=>null, route:()=>null, quiesce:async()=>{} };
    let owner = openMemoryOwner(options);
    await owner.recover();
    const input = { operationId: randomUUID(), text: 'Keep weekly summaries short.' };
    const created = await owner.handleHost('createFile', { args: [input] });
    assert.ok(owner.runtime.readFile(created.identity).markdown.includes(input.text));
    await owner.close();
    owner = openMemoryOwner(options);
    await owner.recover();
    assert.deepEqual(await owner.handleHost('createFile', { args: [input] }), created);
    const current = owner.runtime.readFile(created.identity);
    await owner.handleHost('forgetFile', { args: [{ operationId: randomUUID(), identity: created.identity, version: current.version }] });
    assert.equal(owner.runtime.readFile(created.identity), null);
    await owner.close();
    console.log('PACKAGED_NODE_OK');
  `
  const output = execFileSync(node, ['--input-type=module', '-e', code], { cwd: clean, encoding: 'utf8', timeout: 20_000,
    env: { ...process.env, NODE_PATH: '', ELECTRON_RUN_AS_NODE: '1' } })
  assert.match(output, /PACKAGED_NODE_OK/u)
  const manifest = JSON.parse(readFileSync(path.join(clean, 'node_modules/viva-memory/package.json'), 'utf8')) as { main: string, exports: Record<string, string>, dependencies: Record<string, string> }
  assert.equal(manifest.main, 'index.js')
  assert.equal(manifest.exports['./persistence'], './persistence.js')
  assert.ok(existsSync(path.join(clean, 'node_modules/viva-memory/persistence.js')))
  assert.equal(manifest.dependencies.yaml, '2.9.1')
  assert.equal(manifest.dependencies.marked, '18.0.14')
})

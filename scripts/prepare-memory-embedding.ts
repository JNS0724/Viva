import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as http from 'node:http'
import { createRequire } from 'node:module'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream } from 'node:stream/web'
import { parseArgs } from 'node:util'
import { readMemoryEmbeddingDescriptor, verifyMemoryEmbeddingAssets, writeMemoryEmbeddingManifest } from '../src/memory/node/memory-embedding-assets.ts'

import { memoryEmbeddingRecipe } from './memory-embedding-recipe.ts'

const source = path.resolve(import.meta.dirname, '..', 'build', 'memory-embedding')
const preparationVersion = 3
const { revision, modelUrl, files, encoding, descriptor, modelId } = memoryEmbeddingRecipe
const runtimePath = (dir: string) => path.join(dir, 'runtime')
const modelPath = (dir: string) => path.join(dir, 'model')
const nativePath = 'node_modules/onnxruntime-node/bin/napi-v6'
const licensePath = 'model-license.txt'
const require = createRequire(import.meta.url)
const { noticesText } = require('./third-party-notices.cjs') as { noticesText(options: { projectDir: string, platform: string, packages: string[], section?: boolean }): string }

type LockEntry = { version?: string, integrity?: string, optional?: boolean, os?: string[], cpu?: string[] }
type Lock = { packages: Record<string, LockEntry> }

async function verified(file: string, length: number, digest: string) {
  try {
    return (await fs.stat(file)).size === length && await sha256(file) === digest
  } catch { return false }
}

async function sha256(file: string) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

const DOWNLOAD_RETRY_DELAYS_MS = [2_000, 5_000, 10_000] as const

async function downloadPinnedAsset(name: string, size: number, file: string) {
  const url = new URL(name, modelUrl)
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(15 * 60_000) })
      if (!response.ok || !response.body) {
        const retryable = response.status === 429 || response.status >= 500
        const error = new Error(`Could not download pinned embedding asset ${name} (HTTP ${response.status})`)
        if (!retryable || attempt >= DOWNLOAD_RETRY_DELAYS_MS.length) throw error
        console.warn(`[embedding] ${error.message}; retrying in ${DOWNLOAD_RETRY_DELAYS_MS[attempt]} ms`)
        await new Promise(resolve => setTimeout(resolve, DOWNLOAD_RETRY_DELAYS_MS[attempt]))
        continue
      }
      let seen = 0
      const bounded = new Transform({ transform(chunk: Buffer, _encoding, callback) {
        seen += chunk.length
        callback(seen > size ? new Error(`Embedding asset ${name} exceeds its pinned size`) : null, chunk)
      } })
      await pipeline(Readable.fromWeb(response.body as ReadableStream<Uint8Array>), bounded, createWriteStream(file, { flags: 'wx' }))
      return
    } catch (error) {
      await fs.rm(file, { force: true })
      const permanent = error instanceof Error && (error.message.includes('exceeds its pinned size') || error.message.includes('(HTTP 4'))
      if (permanent || attempt >= DOWNLOAD_RETRY_DELAYS_MS.length) throw error
      console.warn(`[embedding] failed downloading ${name} (${error instanceof Error ? error.message : String(error)}); retrying in ${DOWNLOAD_RETRY_DELAYS_MS[attempt]} ms`)
      await new Promise(resolve => setTimeout(resolve, DOWNLOAD_RETRY_DELAYS_MS[attempt]))
    }
  }
}

async function prepareModel(dest: string, local?: string) {
  for (const [name, size, hash] of files) {
    const file = path.join(dest, name)
    await fs.mkdir(path.dirname(file), { recursive: true })
    if (local) await fs.copyFile(path.join(local, name), file)
    else await downloadPinnedAsset(name, size, file)
    if (!await verified(file, size, hash)) throw new Error(`Embedding asset ${name} failed SHA-256 verification`)
  }
  await fs.copyFile(path.join(source, licensePath), path.join(dest, 'LICENSE'))
  if ((await writeMemoryEmbeddingManifest(dest, encoding)).fingerprint !== descriptor.fingerprint) throw new Error('Prepared embedding descriptor differs from the pinned recipe')
}

async function installed(dir: string, packages: Lock['packages'], platform: string, arch: string, original?: Lock) {
  const found: string[] = []
  for (const [name, entry] of Object.entries(packages)) {
    if (!name || (entry.os && !entry.os.includes(platform)) || (entry.cpu && !entry.cpu.includes(arch))) continue
    try {
      const manifest = JSON.parse(await fs.readFile(path.join(dir, name, 'package.json'), 'utf8')) as { version?: string }
      if (manifest.version !== entry.version || (original && original.packages[name]?.integrity !== entry.integrity)) {
        throw new Error(`Embedding runtime package does not match its lock: ${name}`)
      }
    } catch (error) {
      if (entry.optional && (error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    found.push(name)
  }
  for (const name of ['node_modules/@huggingface/transformers', 'node_modules/onnxruntime-node', `node_modules/@img/sharp-${platform}-${arch}`]) {
    if (!found.includes(name)) throw new Error(`Embedding runtime package is missing: ${name}`)
  }
  const native = path.join(dir, nativePath, platform, arch)
  await fs.access(path.join(native, 'onnxruntime_binding.node'))
  if (platform === 'darwin') await fs.access(path.join(native, 'libonnxruntime.1.dylib'))
  else await fs.access(path.join(native, 'onnxruntime.dll'))
  return found
}

async function pruneRuntime(runtime: string, platform: string, arch: string) {
  const binaries = path.join(runtime, nativePath)
  for (const target of await fs.readdir(binaries)) {
    if (target !== platform) await fs.rm(path.join(binaries, target), { recursive: true, force: true })
  }
  for (const target of await fs.readdir(path.join(binaries, platform))) {
    if (target !== arch) await fs.rm(path.join(binaries, platform, target), { recursive: true, force: true })
  }
  if (platform === 'darwin') {
    // The pinned binding loads @rpath/libonnxruntime.1.dylib. Its npm tarball also carries a duplicate.
    const native = path.join(binaries, platform, arch)
    const primary = path.join(native, 'libonnxruntime.1.dylib')
    const duplicate = path.join(native, 'libonnxruntime.1.30.0.dylib')
    const digest = await sha256(primary)
    if (await verified(duplicate, (await fs.stat(primary)).size, digest)) await fs.unlink(duplicate)
  }
  // The Node Transformers.js entry bundles its own web fallback. Viva uses the native CPU backend.
  await fs.rm(path.join(runtime, 'node_modules', 'onnxruntime-web', 'dist'), { recursive: true, force: true })
  for (const item of ['src', 'types']) await fs.rm(path.join(runtime, 'node_modules', '@huggingface', 'transformers', item), { recursive: true, force: true })
}

async function prepare({ platform, arch, from, output }: { platform: string, arch: string, from?: string, output: string }) {
  if (!['darwin', 'win32'].includes(platform) || !['arm64', 'x64'].includes(arch)) throw new Error(`No local embedding runtime for ${platform}-${arch}`)
  const lockRaw = await fs.readFile(path.join(source, 'package-lock.json'))
  const lock = JSON.parse(lockRaw.toString()) as Lock
  const stamp = JSON.stringify({ preparationVersion, revision, platform, arch, identity: descriptor.fingerprint, lock: createHash('sha256').update(lockRaw).digest('hex') })
  if (!from) {
    try {
      if (await fs.readFile(path.join(output, 'manifest.json'), 'utf8') === stamp
        && readMemoryEmbeddingDescriptor(modelPath(output)).fingerprint === descriptor.fingerprint) {
        await verifyMemoryEmbeddingAssets(modelPath(output), descriptor)
        await installed(runtimePath(output), lock.packages, platform, arch)
        console.log(`[embedding] verified existing ${platform}-${arch} assets`)
        return
      }
    } catch { /* Recreate an incomplete or incompatible build cache. */ }
  }
  await fs.mkdir(path.dirname(output), { recursive: true })
  const stage = await fs.mkdtemp(path.join(path.dirname(output), '.prepare-'))
  try {
    const runtime = runtimePath(stage)
    await fs.mkdir(runtime)
    await fs.copyFile(path.join(source, 'package.json'), path.join(runtime, 'package.json'))
    await fs.writeFile(path.join(runtime, 'package-lock.json'), lockRaw)
    let packages: string[]
    if (from) {
      const cache = path.resolve(from)
      const priorRuntime = path.join(cache, 'embed-runtime')
      const priorLock = JSON.parse(await fs.readFile(path.join(priorRuntime, 'package-lock.json'), 'utf8')) as Lock
      packages = await installed(priorRuntime, lock.packages, platform, arch, priorLock)
      for (const name of packages) {
        const dest = path.join(runtime, name)
        await fs.mkdir(path.dirname(dest), { recursive: true })
        await fs.cp(path.join(priorRuntime, name), dest, { recursive: true, dereference: true })
      }
      await prepareModel(modelPath(stage), path.join(cache, 'models', ...modelId.split('/')))
    } else {
      http.setGlobalProxyFromEnv?.()
      // --ignore-scripts avoids optional GPU downloads, keeping the locked CPU binaries from the npm tarballs.
      const npm = process.env.npm_execpath
      if (!npm) throw new Error('Run memory:prepare-embedding through npm')
      execFileSync(process.execPath, [npm, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org/',
        `--os=${platform}`, `--cpu=${arch}`], { cwd: runtime, stdio: 'inherit' })
      packages = await installed(runtime, lock.packages, platform, arch)
      await prepareModel(modelPath(stage))
    }
    await pruneRuntime(runtime, platform, arch)
    const notices = noticesText({ projectDir: runtime, platform: `${platform}-${arch}`, packages, section: true })
    await fs.writeFile(path.join(stage, 'THIRD_PARTY_NOTICES.txt'), `${await fs.readFile(path.join(source, licensePath), 'utf8')}\n${notices}`)
    await fs.writeFile(path.join(stage, 'manifest.json'), stamp)
    await fs.rm(output, { recursive: true, force: true })
    await fs.rename(stage, output)
    console.log(`[embedding] prepared ${platform}-${arch} model and runtime at ${output}`)
  } finally { await fs.rm(stage, { recursive: true, force: true }) }
}

const { values } = parseArgs({ options: { from: { type: 'string' }, platform: { type: 'string' }, arch: { type: 'string' }, output: { type: 'string' } } })
await prepare({ platform: values.platform ?? process.platform, arch: values.arch ?? process.arch,
  from: values.from, output: path.resolve(values.output ?? path.join(source, 'prepared')) })

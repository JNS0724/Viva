import { createHash } from 'node:crypto'
import { createReadStream, lstatSync, readFileSync } from 'node:fs'
import { lstat, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { objectOf } from '../contracts/unknown-value.ts'

export const MEMORY_EMBEDDING_MANIFEST = 'embedding-manifest.json'
export const MEMORY_EMBEDDING_ASSET_PATHS = Object.freeze([
  'config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx',
] as const)
type AssetPath = typeof MEMORY_EMBEDDING_ASSET_PATHS[number]
export type MemoryEmbeddingPooling = 'mean' | 'cls'
export type MemoryEmbeddingEncoding = {
  dimensions: number, maxTokens: number, pooling: MemoryEmbeddingPooling,
  queryPrefix: 'query: ' | '', passagePrefix: 'passage: ' | '',
}
export type MemoryEmbeddingManifest = Readonly<MemoryEmbeddingEncoding & {
  version: 1, dtype: 'q8', normalization: 'l2',
  files: readonly Readonly<{ path: AssetPath, size: number, sha256: string }>[],
}>
export type MemoryEmbeddingDescriptor = Readonly<{ manifest: MemoryEmbeddingManifest, fingerprint: string }>
const digest = (text: string) => createHash('sha256').update(text).digest('hex')
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const positive = (value: unknown, maximum: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= maximum

/** One controlled on-disk layout. The content identity includes every model and encoding input. */
export function parseMemoryEmbeddingManifest(raw: unknown): MemoryEmbeddingDescriptor {
  const value = objectOf(raw)
  if (!value || !exactKeys(value, ['version', 'dimensions', 'dtype', 'pooling', 'normalization', 'queryPrefix', 'passagePrefix', 'maxTokens', 'files'])
    || value.version !== 1 || value.dtype !== 'q8' || (value.pooling !== 'mean' && value.pooling !== 'cls') || value.normalization !== 'l2'
    || !positive(value.dimensions, 8192) || !positive(value.maxTokens, 8192)
    || !((value.queryPrefix === 'query: ' && value.passagePrefix === 'passage: ') || (value.queryPrefix === '' && value.passagePrefix === ''))
    || !Array.isArray(value.files) || value.files.length !== MEMORY_EMBEDDING_ASSET_PATHS.length) throw new Error('Invalid embedding asset manifest')
  const files = MEMORY_EMBEDDING_ASSET_PATHS.map(name => {
    const matches = (value.files as unknown[]).map(objectOf).filter(file => file?.path === name)
    const file = matches[0]
    if (matches.length !== 1 || !file || !exactKeys(file, ['path', 'size', 'sha256'])
      || !positive(file.size, Number.MAX_SAFE_INTEGER) || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(file.sha256)) {
      throw new Error('Invalid embedding asset identity')
    }
    return Object.freeze({ path: name, size: file.size, sha256: file.sha256 })
  })
  const manifest: MemoryEmbeddingManifest = Object.freeze({ version: 1, dimensions: value.dimensions, dtype: 'q8', pooling: value.pooling, normalization: 'l2',
    queryPrefix: value.queryPrefix, passagePrefix: value.passagePrefix, maxTokens: value.maxTokens, files: Object.freeze(files) })
  return Object.freeze({ manifest, fingerprint: `memory-embedding-assets:v1:${digest(JSON.stringify(manifest))}` })
}

/** The parent reads only this small descriptor. Large file authentication belongs to the worker. */
export function readMemoryEmbeddingDescriptor(modelRoot: string): MemoryEmbeddingDescriptor {
  const file = path.join(modelRoot, MEMORY_EMBEDDING_MANIFEST), stat = lstatSync(file)
  if (!stat.isFile() || stat.size > 16_384) throw new Error('Invalid embedding manifest file')
  return parseMemoryEmbeddingManifest(JSON.parse(readFileSync(file, 'utf8')))
}

async function fileIdentity(file: string) {
  const before = await lstat(file)
  if (!before.isFile()) throw new Error('Embedding asset is not a regular file')
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  const after = await lstat(file)
  if (!after.isFile() || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) throw new Error('Embedding asset changed while authenticating')
  return { size: after.size, sha256: hash.digest('hex') }
}

/** Reject untracked runtime inputs and symlinks; no remote or alternative ONNX layout is inferred. */
async function verifyLayout(root: string, descriptor: MemoryEmbeddingDescriptor) {
  const allowed = new Set<string>([...descriptor.manifest.files.map(file => file.path), MEMORY_EMBEDDING_MANIFEST, 'LICENSE'])
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name === 'onnx' && entry.isDirectory()) {
      for (const nested of await readdir(path.join(root, 'onnx'), { withFileTypes: true })) {
        if (!nested.isFile() || !allowed.has(`onnx/${nested.name}`)) throw new Error('Unsupported embedding asset layout')
      }
    } else if (!entry.isFile() || !allowed.has(entry.name)) throw new Error('Unsupported embedding asset layout')
  }
}

export async function verifyMemoryEmbeddingAssets(modelRoot: string, expected: MemoryEmbeddingDescriptor): Promise<void> {
  await verifyLayout(modelRoot, expected)
  if (readMemoryEmbeddingDescriptor(modelRoot).fingerprint !== expected.fingerprint) throw new Error('Embedding manifest changed')
  for (const asset of expected.manifest.files) {
    const found = await fileIdentity(path.join(modelRoot, asset.path))
    if (found.size !== asset.size || found.sha256 !== asset.sha256) throw new Error('Embedding asset authentication failed')
  }
}

/** Build-time helper; fingerprints are computed from file contents, never their installation path. */
export async function writeMemoryEmbeddingManifest(modelRoot: string, encoding: MemoryEmbeddingEncoding): Promise<MemoryEmbeddingDescriptor> {
  const files = []
  for (const name of MEMORY_EMBEDDING_ASSET_PATHS) files.push({ path: name, ...await fileIdentity(path.join(modelRoot, name)) })
  const descriptor = parseMemoryEmbeddingManifest({ version: 1, dtype: 'q8', normalization: 'l2', ...encoding, files })
  await writeFile(path.join(modelRoot, MEMORY_EMBEDDING_MANIFEST), JSON.stringify(descriptor.manifest, null, 2) + '\n')
  await verifyMemoryEmbeddingAssets(modelRoot, descriptor)
  return descriptor
}

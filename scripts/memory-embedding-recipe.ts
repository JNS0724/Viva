import { parseMemoryEmbeddingManifest } from '../src/memory/node/memory-embedding-assets.ts'

/** Release recipe, not a model registry. Runtime dependencies remain independently locked. */
const modelId = 'onnx-community/granite-embedding-97m-multilingual-r2-ONNX'
const revision = '536a9f241cb3f02a9c5995a1e708c784bd274859'
const files = [
  ['config.json', 1215, 'ae74d55a56f779774cb9a8e63d3c2da9ae1af83c00229ffdff43d0b38407a0ee'],
  ['tokenizer.json', 25301671, '51947676cae1f991fa51c6b9a24e14ee5460e5f0b9f692f13bb3159829d1592a'],
  ['tokenizer_config.json', 12860, '6ed69389e30a8ecabfce2f9ebcdf0c908b34056f24d994340f2f216521c057d5'],
  ['onnx/model_quantized.onnx', 97858099, '704c1ebca5fbb7cd83ced41827658ac4c9990c64f7f2874d22b78044e5022e22'],
] as const
const encoding = { dimensions: 384, maxTokens: 128, pooling: 'cls', queryPrefix: '', passagePrefix: '' } as const
const descriptor = parseMemoryEmbeddingManifest({ version: 1, dtype: 'q8', normalization: 'l2', ...encoding,
  files: files.map(([name, size, sha256]) => ({ path: name, size, sha256 })) })

export const memoryEmbeddingRecipe = Object.freeze({ modelId, revision, files, encoding, descriptor,
  modelUrl: `https://huggingface.co/${modelId}/resolve/${revision}/` })

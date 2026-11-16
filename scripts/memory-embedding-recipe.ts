import { parseMemoryEmbeddingManifest } from '../src/memory/node/memory-embedding-assets.ts'

/** Release recipe, not a model registry. Runtime dependencies remain independently locked. */
const modelId = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2'
const revision = '2c4055b12046f11709e9df2c122e59ffbdc2f900'
const files = [
  ['config.json', 673, '05b570bff786faa5c4604152aa16f19f77ed6dfc31e47dd0f3dd987078693ac7'],
  ['tokenizer.json', 17082913, 'b60b6b43406a48bf3638526314f3d232d97058bc93472ff2de930d43686fa441'],
  ['tokenizer_config.json', 496, '3f5961b9ac86288cccdb97f32fb848d6187c78e1603958c53f3ea1f296b7d8a2'],
  ['onnx/model_quantized.onnx', 118308126, '66fc00f5f29afcaff34092e1bdd20008ca3918265a82fb9695a551e510cc4ebc'],
] as const
const encoding = { dimensions: 384, maxTokens: 128, queryPrefix: '', passagePrefix: '' } as const
const descriptor = parseMemoryEmbeddingManifest({ version: 1, dtype: 'q8', pooling: 'mean', normalization: 'l2', ...encoding,
  files: files.map(([name, size, sha256]) => ({ path: name, size, sha256 })) })

export const memoryEmbeddingRecipe = Object.freeze({ modelId, revision, files, encoding, descriptor,
  modelUrl: `https://huggingface.co/${modelId}/resolve/${revision}/` })

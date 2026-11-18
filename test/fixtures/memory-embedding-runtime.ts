import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** Protocol fixture only: these unit vectors are not evidence of semantic retrieval quality. */
export const env = { allowRemoteModels: true, useFSCache: true, useBrowserCache: true }
export async function pipeline(task: string, model: string, settings: {
  device: string, dtype: string, local_files_only: boolean,
}) {
  if (task !== 'feature-extraction' || settings.device !== 'cpu' || settings.dtype !== 'q8'
    || !settings.local_files_only || env.allowRemoteModels || env.useFSCache || env.useBrowserCache) throw new Error('local settings')
  const config = JSON.parse(readFileSync(path.join(model, 'config.json'), 'utf8')) as {
    hidden_size: number, fixture_behavior?: string, fixture_token_limit?: number, fixture_pooling?: 'mean' | 'cls',
  }
  if (config.fixture_behavior === 'replace-on-load') writeFileSync(path.join(model, 'onnx/model_quantized.onnx'), 'changed during pipeline initialization')
  if (config.fixture_behavior === 'wrong-ready') process.send?.({ type: 'ready', fingerprint: 'unverified-space', dimensions: config.hidden_size })
  if (config.fixture_behavior === 'result-before-ready') process.send?.({ type: 'result', id: 1, rows: [], fingerprint: 'unverified-space', dimensions: config.hidden_size })
  if (config.fixture_behavior === 'diagnostic-noise') {
    for (let index = 0; index < 20; index++) {
      process.send?.({ type: 'diagnostic-worker', version: 999, id: 1, stage: 'ready', diagnostics: { secret: 'SECRET_DIAGNOSTIC_INPUT' } })
    }
  }
  process.on('message', (raw: unknown) => {
    if (!raw || typeof raw !== 'object') return
    const message = raw as { id?: unknown, inputs?: unknown }
    if (Array.isArray(message.inputs) && message.inputs.some(input => input && typeof input === 'object'
      && 'text' in input && input.text === 'wrong result identity')) {
      process.send?.({ type: 'result', id: message.id, fingerprint: 'another-space', dimensions: config.hidden_size, rows: [[1]] })
    }
  })
  const extract = async (prompts: string[], options: { pooling: string, normalize: boolean }) => {
    if (options.pooling !== (config.fixture_pooling ?? 'mean') || !options.normalize) throw new Error('pooling settings')
    if (prompts.some(prompt => prompt.includes('stop worker'))) process.exit(42)
    if (prompts.some(prompt => prompt.includes('hang worker'))) await new Promise(resolve => setTimeout(resolve, 30_000))
    const width = config.hidden_size + (config.fixture_behavior === 'wrong-width' ? 1 : 0)
    const data = new Float32Array(prompts.length * width)
    for (const [index, prompt] of prompts.entries()) {
      const component = prompt.startsWith('query: ') ? 0 : prompt.startsWith('passage: ') ? 1 : 2
      data[index * width + Math.min(component, width - 1)] = 1
    }
    return { dims: [prompts.length, width], data }
  }
  extract.tokenizer = { model_max_length: config.fixture_token_limit ?? 512,
    encode: (input: string) => Array<number>(input.includes('too long') ? 513 : 2).fill(1) }
  return extract
}

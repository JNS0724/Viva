import { PROFILE_FIELDS } from '../shared/profile-fields.ts'
import { translate } from '../shared/i18n/translate.ts'
import { createMemoryRuntime as createNodeMemoryRuntime } from '../memory/node/runtime.ts'
import type { NodeMemoryRuntimeOptions } from '../memory/node/runtime.ts'

/** Temporary P1 bootstrap: Viva supplies presentation only; P2 moves ownership to the plugin. */
export function createMemoryRuntime(options: NodeMemoryRuntimeOptions) {
  return createNodeMemoryRuntime({
    ...options,
    presentation: { text: (key, values) => translate(`main.memory.${key}`, values), profileLabels: () => PROFILE_FIELDS, ...options.presentation },
  })
}
export { MAX_RECALL_CHARS, MAX_DEEP_RECALL_CHARS } from '../memory/core/memory-runtime.ts'
export type { MemoryWithdrawal, MemoryRuntime } from '../memory/core/memory-runtime.ts'

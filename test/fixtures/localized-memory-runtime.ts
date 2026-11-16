import { PROFILE_FIELDS } from '../../src/shared/profile-fields.ts'
import { translate } from '../../src/shared/i18n/translate.ts'
import { createMemoryRuntime as createNodeMemoryRuntime } from '../../src/memory/node/runtime.ts'
import type { NodeMemoryRuntimeOptions } from '../../src/memory/node/runtime.ts'

/** Localized domain fixture for pre-owner regression tests; production runtime ownership stays in the plugin. */
export function createMemoryRuntime(options: NodeMemoryRuntimeOptions) {
  return createNodeMemoryRuntime({
    ...options,
    presentation: { text: (key, values) => translate(`main.memory.${key}`, values), profileLabels: () => PROFILE_FIELDS, ...options.presentation },
  })
}
export { MAX_RECALL_CHARS, MAX_DEEP_RECALL_CHARS } from '../../src/memory/core/memory-runtime.ts'
export type { MemoryWithdrawal, MemoryRuntime } from '../../src/memory/core/memory-runtime.ts'

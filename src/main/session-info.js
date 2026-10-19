const MODEL_CONFIG_ID = 'model'
const EFFORT_CONFIG_ID = 'reasoning_effort'
export const CONFIG_IDS = Object.freeze([MODEL_CONFIG_ID, EFFORT_CONFIG_ID])

function flattenSelectOptions(options) {
  if (!Array.isArray(options)) return []
  return options.flatMap((item) => (Array.isArray(item?.options)
    ? item.options.map((option) => ({ ...option, group: item.name ?? item.group ?? '' }))
    : [{ ...item, group: '' }]))
}

function findOption(configOptions, id, category) {
  if (!Array.isArray(configOptions)) return null
  return configOptions.find((o) => o?.id === id || o?.category === category) ?? null
}

/**
 * Projects ACP `configOptions` into what the UI needs: the current model and reasoning effort plus their choices.
 * @returns {{ model: string, modelValue: string, models: Array<{value: string, name: string, group: string}>, effort: string, efforts: Array<{value: string, name: string}> }}
 */
export function describeConfig(configOptions) {
  const modelOption = findOption(configOptions, MODEL_CONFIG_ID, 'model')
  const effortOption = findOption(configOptions, EFFORT_CONFIG_ID, 'thought_level')
  const models = flattenSelectOptions(modelOption?.options).map(({ value, name, group }) => ({ value, name, group }))
  const efforts = flattenSelectOptions(effortOption?.options).map(({ value, name }) => ({ value, name }))
  const modelValue = modelOption ? String(modelOption.currentValue ?? '') : ''
  return {
    model: models.find((m) => m.value === modelValue)?.name || modelValue,
    modelValue,
    models,
    effort: effortOption ? String(effortOption.currentValue ?? '') : '',
    efforts,
  }
}

/** Picks the display name of the selected model from an ACP `configOptions` list. */
export const currentModelName = (configOptions) => describeConfig(configOptions).model

/** JSON-RPC errors from the ACP SDK carry the real cause in `data` (e.g. `{ details: 'unknown model option' }`). */
function errorDetail(err) {
  const data = err?.data
  if (!data) return ''
  if (typeof data === 'string') return data
  return String(data.details ?? data.message ?? '')
}

/** Turns any thrown value into one readable line, optionally appending the tail of dsh's stderr. */
export function describeError(err, stderrTail = '') {
  const message = err instanceof Error ? err.message : typeof err === 'object' && err?.message ? err.message : String(err)
  const detail = errorDetail(err)
  const base = detail && !message.includes(detail) ? `${message}: ${detail}` : message
  const tail = stderrTail.trim().split('\n').slice(-3).join(' | ')
  return tail ? `${base}（dsh: ${tail}）` : base
}

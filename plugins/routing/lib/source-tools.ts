import { FORBIDDEN_SOURCE_TOOLS } from './policy.ts'

/**
 * Runtime ownership and read-only capability verification for plugin-backed data source tools.
 * Tracks which Cordis plugin fiber registered each global tool so a manifest cannot claim tools
 * registered by another plugin, and requires explicit read-only capability metadata on each tool.
 */

export interface ToolRuntimeRecord {
  definition: unknown
  ownerEntryIds: ReadonlySet<string>
  ownerNames: ReadonlySet<string>
}

export type VerifySourceToolsResult =
  | { ok: true, tools: string[] }
  | { ok: false, reason: string }

const rec = (value: unknown): Record<string, unknown> =>
  (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {})

/**
 * Checks whether a registered tool definition explicitly declares read-only capability metadata
 * and does not declare destructive or mutating behavior.
 */
export function isReadOnlyToolDefinition(definition: unknown): boolean {
  const def = rec(definition)
  const annotations = rec(def.annotations)
  const meta = rec(def.meta)
  if (def.readOnly === false || def.mutates === true) return false
  if (annotations.readOnlyHint === false || annotations.destructiveHint === true) return false
  if (meta.readOnly === false || meta.mutates === true) return false
  return def.readOnly === true || annotations.readOnlyHint === true || meta.readOnly === true
}

/** Extracts owning Cordis entry IDs and plugin names from a calling context's fiber ancestry. */
export function ownersFromContext(callingCtx: unknown): { entryIds: Set<string>, names: Set<string> } {
  const entryIds = new Set<string>()
  const names = new Set<string>()
  let fiber = rec(callingCtx).fiber as Record<string, unknown> | undefined
  const seen = new Set<unknown>()
  while (fiber && typeof fiber === 'object' && !seen.has(fiber)) {
    seen.add(fiber)
    const entry = rec(fiber.entry)
    if (typeof entry.id === 'string' && entry.id) entryIds.add(entry.id)
    if (typeof entry.name === 'string' && entry.name) names.add(entry.name)
    const runtime = rec(fiber.runtime)
    if (typeof runtime.name === 'string' && runtime.name) names.add(runtime.name)
    const plugin = rec(runtime.plugin)
    if (typeof plugin.name === 'string' && plugin.name) names.add(plugin.name)
    fiber = fiber.parent as Record<string, unknown> | undefined
  }
  return { entryIds, names }
}

/**
 * Wraps `toolsService.register` (on its prototype when shared across Cordis contexts) to track
 * runtime registration ownership for global tools. Returns a lookup helper and a cleanup disposer.
 */
export function installToolOwnershipTracker(toolsService: unknown) {
  const registry = new Map<string, ToolRuntimeRecord>()
  const proto = toolsService && typeof toolsService === 'object' ? Object.getPrototypeOf(toolsService) : null
  const target = proto && typeof proto.register === 'function' ? proto : (toolsService as Record<string, unknown> | null)
  const original = target && typeof target.register === 'function'
    ? target.register as (this: { ctx?: unknown }, definition: { name?: string }, options?: unknown) => unknown
    : null

  if (target && original) {
    target.register = function patchedRegister(this: { ctx?: unknown }, definition: { name?: string }, options?: unknown) {
      const dispose = original.call(this, definition, options)
      const name = typeof definition?.name === 'string' ? definition.name : ''
      if (name) {
        const { entryIds, names } = ownersFromContext(this?.ctx)
        const record: ToolRuntimeRecord = { definition, ownerEntryIds: entryIds, ownerNames: names }
        registry.set(name, record)
        if (typeof dispose === 'function') {
          return () => {
            if (registry.get(name) === record) registry.delete(name)
            return (dispose as () => unknown)()
          }
        }
      }
      return dispose
    }
  }

  return {
    lookup: (name: string): ToolRuntimeRecord | undefined => registry.get(name),
    dispose: () => {
      if (target && original && target.register !== original) target.register = original
      registry.clear()
    },
  }
}

/**
 * Verifies that declared tools exist at runtime, are owned by the selected plugin bundle (via
 * Cordis entry ID or plugin name), and explicitly carry read-only capability metadata.
 */
export function verifyPluginReadOnlyTools({
  pluginName,
  ownerEntryIds,
  declaredTools,
  lookupTool,
}: {
  pluginName: string
  ownerEntryIds: readonly string[]
  declaredTools: readonly string[]
  lookupTool: (name: string) => ToolRuntimeRecord | undefined
}): VerifySourceToolsResult {
  if (!declaredTools.length) {
    return { ok: false, reason: `插件 ${pluginName} 未声明任何只读工具` }
  }
  const expectedEntries = new Set(ownerEntryIds)
  const verified: string[] = []
  for (const name of declaredTools) {
    if (FORBIDDEN_SOURCE_TOOLS.has(name)) {
      return { ok: false, reason: `工具 ${name} 不允许在数据源会话中调用` }
    }
    const record = lookupTool(name)
    if (!record) {
      return { ok: false, reason: `工具 ${name} 未由所选插件 ${pluginName} 注册` }
    }
    const ownedByEntry = expectedEntries.size > 0 && [...record.ownerEntryIds].some((id) => expectedEntries.has(id))
    const ownedByName = record.ownerNames.has(pluginName)
    if (!ownedByEntry && !ownedByName) {
      return { ok: false, reason: `工具 ${name} 归属其他插件，不能绑定到 ${pluginName}` }
    }
    if (!isReadOnlyToolDefinition(record.definition)) {
      return { ok: false, reason: `工具 ${name} 未声明只读能力元数据，已拒绝绑定` }
    }
    verified.push(name)
  }
  return { ok: true, tools: verified }
}

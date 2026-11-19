import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type { ToolDefinition, ToolsService } from '@deepseek-ai/dsh-tools'
import { admitFeedSource } from './policy.ts'

/** Loader entry IDs, keyed by the exact definition registered with dsh. */
type Lookup = (definition: ToolDefinition) => ReadonlySet<string> | undefined
type Register = (this: { ctx: Context }, ...args: Parameters<ToolsService['register']>) => ReturnType<ToolsService['register']>

interface ToolPolicy {
  pluginName: string
  ownerEntryIds: readonly string[]
  allowedTools: readonly string[]
}

export type VerifySourceToolsResult =
  | { ok: true }
  | { ok: false, code: 'unknown-provenance' | 'rejected', reason: string }

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? value as Record<string, unknown> : {}

function isReadOnlyTool(definition: ToolDefinition): boolean {
  const tool = record(definition)
  const annotations = record(tool.annotations)
  const meta = record(tool.meta)
  if (tool.readOnly === false || tool.mutates === true) return false
  if (annotations.readOnlyHint === false || annotations.destructiveHint === true) return false
  if (meta.readOnly === false || meta.mutates === true) return false
  return tool.readOnly === true || annotations.readOnlyHint === true || meta.readOnly === true
}

/** Cordis links each fiber to its parent Context. An entry-less child still belongs to its loader ancestor. */
function ownershipOf(ctx: Context): ReadonlySet<string> {
  const entries = new Set<string>()
  const seen = new Set<Context['fiber']>()
  try {
    for (let fiber = ctx.fiber; fiber && !seen.has(fiber); fiber = fiber.parent.fiber) {
      seen.add(fiber)
      if (fiber.entry) entries.add(fiber.entry.id)
    }
  } catch {
    // A context that refuses inspection must never interrupt normal tool registration.
  }
  return entries
}

/**
 * dsh exposes tool definitions, while the registering Cordis context is only available during registration.
 * Capture the entry IDs without changing the registration or its disposer. The weak map neither retains unloaded
 * tools nor lets a different definition inherit the ownership of a previously registered name.
 */
export function installToolProvenance(tools: ToolsService) {
  const entries = new WeakMap<ToolDefinition, ReadonlySet<string>>()
  const prototype = Object.getPrototypeOf(tools) as { register: Register }
  const original = prototype.register
  const register: Register = function (definition, options) {
    const dispose = original.call(this, definition, options)
    const owners = ownershipOf(this.ctx)
    const previous = entries.get(definition)
    // If a definition is shared between registrations, only ownership common to both can be proven.
    entries.set(definition, previous ? new Set([...owners].filter(owner => previous.has(owner))) : owners)
    return dispose
  }
  prototype.register = register
  return {
    lookup: (definition: ToolDefinition) => entries.get(definition),
    dispose() {
      if (prototype.register === register) prototype.register = original
    },
  }
}

function verifyTool(name: string, definition: ToolDefinition | undefined, pluginName: string, owners: ReadonlySet<string>, lookup: Lookup): VerifySourceToolsResult {
  if (!definition) return { ok: false, code: 'rejected', reason: `工具 ${name} 当前未注册` }
  const registeredBy = lookup(definition)
  if (registeredBy?.size && ![...registeredBy].some(id => owners.has(id))) {
    return { ok: false, code: 'rejected', reason: `工具 ${name} 归属其他插件，不能绑定到 ${pluginName}` }
  }
  if (!isReadOnlyTool(definition)) return { ok: false, code: 'rejected', reason: `工具 ${name} 未声明只读能力元数据，已拒绝绑定` }
  if (!registeredBy?.size) return { ok: false, code: 'unknown-provenance', reason: `工具 ${name} 的注册来源未知` }
  return { ok: true }
}

/** Verify every declared tool against the live global registry before the first model prompt. */
export function verifyPluginReadOnlyTools(policy: ToolPolicy, resolve: (name: string) => ToolDefinition | undefined, lookup: Lookup): VerifySourceToolsResult {
  const { pluginName, allowedTools } = policy
  const owners = new Set(policy.ownerEntryIds)
  const names = new Set(allowedTools)
  if (!owners.size || !names.size) return { ok: false, code: 'rejected', reason: `插件 ${pluginName} 没有可用的只读工具` }
  let unknown: Extract<VerifySourceToolsResult, { ok: false }> | undefined
  for (const name of names) {
    const admission = admitFeedSource(names, name)
    if (!admission.allowed) return { ok: false, code: 'rejected', reason: admission.reason ?? '' }
    const checked = verifyTool(name, resolve(name), pluginName, owners, lookup)
    if (checked.ok) continue
    if (checked.code === 'rejected') return checked
    unknown ??= checked
  }
  return unknown ?? { ok: true }
}

/** A long run may outlive a plugin reload. Check the definition dsh actually admitted for every call. */
export function createSourceGuard(lookup: Lookup) {
  const scopes = new Map<string, { pluginName: string, owners: ReadonlySet<string>, tools: ReadonlySet<string> }>()
  return {
    bind(sessionId: string, { pluginName, ownerEntryIds, allowedTools }: ToolPolicy) {
      scopes.set(sessionId, { pluginName, owners: new Set(ownerEntryIds), tools: new Set(allowedTools) })
    },
    toolsOf: (sessionId: string) => scopes.get(sessionId)?.tools,
    drop: (sessionId: string) => { scopes.delete(sessionId) },
    deny(sessionId: string, name: string, definition: ToolDefinition | undefined): string | undefined {
      const scope = scopes.get(sessionId)
      if (!scope) return
      const admission = admitFeedSource(scope.tools, name)
      if (!admission.allowed) return admission.reason
      const checked = verifyTool(name, definition, scope.pluginName, scope.owners, lookup)
      return checked.ok ? undefined : checked.reason
    },
  }
}

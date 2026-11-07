/**
 * What a dsh plugin's package.json says of it working in Viva: only what is known, not a promise. Viva runs dsh's
 * ACP composition (dsh-base and dsh-acp-app), without the browser host dsh's Web app runs: a plugin that needs that
 * host (its HTTP server, or the Web app bundle itself) cannot work here. Nothing else can be told from the manifest
 * alone (a bundle's own patch may still ask for a service Viva does not have), so the rest is "nothing known against
 * it"; whether its rows actually run is the plugin's standing (capabilities-state.ts pluginStanding). A plugin's
 * author can say it supports Viva (`"viva": { "supports": true }`), which is taken as said, not as checked.
 */
export const WEB_HOST: readonly string[] = Object.freeze(['@deepseek-ai/dsh-host-webserver', '@deepseek-ai/dsh-web-app'])

export type VivaFit =
  | { kind: 'declared' }
  | { kind: 'no-conflict' }
  | { kind: 'web-part' }
  | { kind: 'needs-web', needs: readonly string[] }
  | { kind: 'unknown' }

const record = (value: unknown): Record<string, unknown> =>
  (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {})

export function vivaFit(manifest: unknown): VivaFit {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return { kind: 'unknown' }
  const pkg = record(manifest)
  if (record(pkg.viva).supports === true) return { kind: 'declared' }
  const needs = [...Object.keys(record(pkg.dependencies)), ...Object.keys(record(pkg.peerDependencies))].filter((name) => WEB_HOST.includes(name))
  if (needs.length) return { kind: 'needs-web', needs: [...new Set(needs)] }
  return record(pkg.dsh).client ? { kind: 'web-part' } : { kind: 'no-conflict' }
}

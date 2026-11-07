/**
 * Whether a dsh plugin works in Viva, read from its package.json. Viva runs dsh over ACP, without dsh's Web host,
 * so a plugin that needs that host (or the Web API packages served by it) cannot run here; one that brings a part
 * for dsh's Web client runs, that part not shown. A plugin's author can say outright that it works in Viva:
 * `"viva": { "supports": true }`.
 */
const WEB_HOST = /^@deepseek-ai\/dsh-(host-webserver|web|web-app|api-.+)$/

export type VivaFit =
  | { kind: 'declared' }
  | { kind: 'fits' }
  | { kind: 'web-part' }
  | { kind: 'needs-web', needs: readonly string[] }
  | { kind: 'unknown' }

const record = (value: unknown): Record<string, unknown> =>
  (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {})

export function vivaFit(manifest: unknown): VivaFit {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return { kind: 'unknown' }
  const pkg = record(manifest)
  if (record(pkg.viva).supports === true) return { kind: 'declared' }
  const needs = [...Object.keys(record(pkg.dependencies)), ...Object.keys(record(pkg.peerDependencies))].filter((name) => WEB_HOST.test(name))
  if (needs.length) return { kind: 'needs-web', needs: [...new Set(needs)] }
  return record(pkg.dsh).client ? { kind: 'web-part' } : { kind: 'fits' }
}

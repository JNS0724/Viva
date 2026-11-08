import http from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * An npm registry on this computer, for the company plugin source (backend/plugin-catalog.ts): its search
 * (`/-/v1/search`) finds every package it has, and each package's packument has its one version. Every request is
 * written down with the token it came with.
 */
export interface FakeRegistry { url: string, asked: Array<{ url: string, auth: string | null }>, close: () => Promise<void> }
/** A package's package.json, as the registry has it. */
export type FakePackage = { version: string, [field: string]: unknown }

export async function startFakeRegistry(packages: Readonly<Record<string, FakePackage>>): Promise<FakeRegistry> {
  const asked: FakeRegistry['asked'] = []
  const server = http.createServer((req, res) => {
    const url = req.url ?? ''
    asked.push({ url, auth: req.headers.authorization ?? null })
    const json = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
    if (url.startsWith('/-/v1/search')) {
      const objects = Object.values(packages).map((pkg) => ({ package: { ...pkg, date: '2026-11-01T00:00:00.000Z' } }))
      return json(200, { total: objects.length, objects })
    }
    const name = decodeURIComponent(url.slice(1).split('?')[0])
    const pkg = packages[name]
    if (!pkg) return json(404, { error: 'not found' })
    return json(200, { name, 'dist-tags': { latest: pkg.version }, versions: { [pkg.version]: { ...pkg, dist: { tarball: `http://127.0.0.1/${name}.tgz`, shasum: '0' } } } })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
    asked,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

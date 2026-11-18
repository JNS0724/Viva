import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

/** Give the isolated offline registry all declared runtime dependencies, including transitive ones. */
export function installedRuntimePackages(names: readonly string[], require: ReturnType<typeof createRequire>): string[] {
  const seen = new Map<string, string>()
  function visit(name: string, resolveFrom: ReturnType<typeof createRequire>) {
    let directory = path.dirname(resolveFrom.resolve(name))
    while (true) {
      const manifest = path.join(directory, 'package.json')
      if (existsSync(manifest)) {
        const value = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string; version?: string; dependencies?: Record<string, string> }
        if (value.name === name) {
          const previous = seen.get(name)
          if (previous) {
            if (previous !== directory && readFileSync(path.join(previous, 'package.json'), 'utf8') !== readFileSync(manifest, 'utf8')) throw new Error(`Offline fixture needs multiple versions of ${name}`)
            return
          }
          seen.set(name, directory)
          for (const dependency of Object.keys(value.dependencies ?? {})) visit(dependency, createRequire(manifest))
          return
        }
      }
      const parent = path.dirname(directory)
      if (parent === directory) throw new Error(`Cannot find runtime package ${name}`)
      directory = parent
    }
  }
  for (const name of names) visit(name, require)
  return [...seen.values()]
}

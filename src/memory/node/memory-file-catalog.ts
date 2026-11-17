import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MemoryFileCatalog, MemoryCatalogFile, MemoryCatalogChange, MemoryFileIdentity } from '../core/ports/file-index.ts'
import { dailyPath, digestPath } from '../contracts/memory-file-contract.ts'
import { memoryFileRevision } from './memory-file-store.ts'

/** Observation only. Neither a new pathname nor matching bytes grant a file a trusted identity. */
export function openMemoryFileCatalog({ root }: { root: string }): MemoryFileCatalog {
  function scan(workspace: string, accepted: readonly MemoryFileIdentity[]): MemoryCatalogChange[] {
    if (!/^[a-f0-9]{64}$/u.test(workspace) || accepted.some(file => file.workspace !== workspace)) throw new Error('invalid-memory-workspace')
    const output: MemoryCatalogChange[] = [], found = new Map<string,MemoryCatalogFile>()
    function walk(directory: string, relative: string) {
      try {
        const stat = lstatSync(directory)
        if (stat.isSymbolicLink()) { output.push({kind:'quarantined',path:relative,reason:'symlink'}); return }
        if (!stat.isDirectory()) { output.push({kind:'quarantined',path:relative,reason:'invalid-path'}); return }
        for (const entry of readdirSync(directory, {withFileTypes:true})) {
          if (entry.name.startsWith('.') || /(?:\.tmp|\.bak|~)$/u.test(entry.name)) continue
          const path = relative ? `${relative}/${entry.name}` : entry.name, absolute = join(directory,entry.name)
          if (entry.isSymbolicLink()) { output.push({kind:'quarantined',path,reason:'symlink'}); continue }
          if (entry.isDirectory()) { walk(absolute,path); continue }
          if (!entry.name.endsWith('.md')) continue
          if (!entry.isFile() || !(path.startsWith('daily/') ? dailyPath : digestPath).safeParse(path).success) { output.push({kind:'quarantined',path,reason:'invalid-path'}); continue }
          try {
            // Recheck immediately before reading, including any directory swapped after enumeration.
            const components = path.split('/'); let cursor=join(root,workspace)
            if (lstatSync(root).isSymbolicLink() || lstatSync(cursor).isSymbolicLink()) throw new Error('symlink')
            for (const component of components) { cursor=join(cursor,component); if (lstatSync(cursor).isSymbolicLink()) throw new Error('symlink') }
            const markdown=readFileSync(absolute,'utf8')
            found.set(path,{path,markdown,revision:memoryFileRevision(markdown)})
          } catch (error) { output.push({kind:'quarantined',path,reason:error instanceof Error && error.message==='symlink'?'symlink':'unreadable'}) }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') output.push({kind:'quarantined',path:relative,reason:'unreadable'})
      }
    }
    try {
      if (lstatSync(root).isSymbolicLink() || lstatSync(join(root,workspace)).isSymbolicLink()) return [{kind:'quarantined',path:'',reason:'symlink'}]
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return [{kind:'quarantined',path:'',reason:'unreadable'}] }
    walk(join(root,workspace,'daily'),'daily'); walk(join(root,workspace,'digest'),'digest')
    const bound = new Set(accepted.map(file => file.path)), missing=accepted.filter(file => !found.has(file.path))
    const added=[...found.values()].filter(file => !bound.has(file.path)), renamed=new Set<string>(), consumed=new Set<string>()
    for (const file of accepted) {
      const observed=found.get(file.path)
      if (observed) output.push({kind:observed.revision===file.revision?'unchanged':'modified',identity:file,file:observed})
    }
    for (const file of added) {
      const old=missing.filter(item => item.revision===file.revision)
      const peers=[...found.values()].filter(item => item.revision===file.revision)
      const prior=accepted.filter(item => item.revision===file.revision)
      if (old.length===1 && peers.length===1 && prior.length===1) {
        output.push({kind:'rename',identity:old[0]!,file}); renamed.add(old[0]!.id); consumed.add(file.path)
      } else if (old.length > 0) { output.push({kind:'quarantined',path:file.path,reason:'ambiguous-rename'}); consumed.add(file.path) }
      else if (prior.length || peers.length > 1) { output.push({kind:'quarantined',path:file.path,reason:'duplicate-content'}); consumed.add(file.path) }
    }
    for (const file of missing) if (!renamed.has(file.id)) output.push({kind:'missing',identity:file})
    for (const file of added) if (!consumed.has(file.path)) output.push({kind:'added',file})
    return output
  }
  return {scan}
}

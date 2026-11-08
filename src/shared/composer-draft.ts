/** One application-run draft per selected conversation, shared by the two composer hosts. */
export interface DraftFile { path: string, name: string, size: number }
export interface DraftImage { id: string, size?: number }
export interface DraftContent { text: string, files: DraftFile[], images: DraftImage[], error: string | null }
export interface DraftSnapshot extends DraftContent { key: string, version: number, epoch: number, sequence: number, owner: 'main' | 'desk', baseImages?: string[], baseFiles?: string[] }
export const EMPTY_DRAFT: Readonly<DraftContent> = Object.freeze({ text: '', files: [], images: [], error: null })

/** Stale hosts cannot replace a draft after focus/target handoff; send receipts clear only their snapshot. */
export function createComposerDraftStore(changed: (snapshot: DraftSnapshot) => void = () => {}) {
  const drafts = new Map<string, DraftContent & { version: number }>()
  let key = 'startup', epoch = 0, sequence = 0, owner: DraftSnapshot['owner'] = 'main'
  const content = () => drafts.get(key) ?? { ...EMPTY_DRAFT, version: 0 }
  const snapshot = (): DraftSnapshot => structuredClone({ ...content(), key, epoch, owner, sequence })
  function publish() { const next = snapshot(); changed(next); return next }
  return {
    snapshot,
    select(next: string, inherit = false) {
      if (next === key) return snapshot()
      if (inherit && !drafts.has(next)) drafts.set(next, { ...structuredClone(content()), version: 0 })
      key = next; epoch++; sequence = 0
      return publish()
    },
    own(next: DraftSnapshot['owner']) {
      if (next === owner) return snapshot()
      owner = next; epoch++; sequence = 0
      return publish()
    },
    update(source: DraftSnapshot['owner'], next: DraftSnapshot): { ok: boolean, draft: DraftSnapshot } {
      if (next.key !== key || next.epoch !== epoch || source !== owner || next.sequence <= sequence) return { ok: false, draft: snapshot() }
      const base = new Set(next.baseImages ?? content().images.map(image => image.id))
      const ids = new Set(next.images.map(image => image.id))
      const images = [...next.images, ...content().images.filter(image => !base.has(image.id) && !ids.has(image.id))].slice(0, 10)
      const fileBase = new Set(next.baseFiles ?? content().files.map(file => file.path)), paths = new Set(next.files.map(file => file.path))
      const files = [...next.files, ...content().files.filter(file => !fileBase.has(file.path) && !paths.has(file.path))].slice(0, 10)
      sequence = next.sequence
      drafts.set(key, { text: next.text, files: structuredClone(files), images: structuredClone(images), error: next.error, version: content().version + 1 })
      return { ok: true, draft: publish() }
    },
    appendImage(target: string, image: DraftImage) {
      const prior = drafts.get(target) ?? { ...EMPTY_DRAFT, version: 0 }
      if (prior.images.some(item => item.id === image.id) || prior.images.length >= 10) return
      drafts.set(target, { ...prior, images: [...prior.images, structuredClone(image)], version: prior.version + 1 })
      if (target === key) publish()
    },
    appendFiles(target: string, files: DraftFile[]) {
      const prior = drafts.get(target) ?? { ...EMPTY_DRAFT, version: 0 }
      const paths = new Set(prior.files.map(file => file.path))
      drafts.set(target, { ...prior, files: [...prior.files, ...structuredClone(files).filter(file => !paths.has(file.path))].slice(0, 10), version: prior.version + 1 })
      if (target === key) publish()
    },
    clear(sent: Pick<DraftSnapshot, 'key' | 'version'>) {
      const prior = drafts.get(sent.key)
      if (!prior || prior.version !== sent.version) return false
      drafts.set(sent.key, { ...EMPTY_DRAFT, version: prior.version + 1 })
      if (sent.key === key) publish()
      return true
    },
  }
}

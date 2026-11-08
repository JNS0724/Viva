import type { DraftContent, DraftSnapshot, DraftImage, DraftFile } from '../shared/composer-draft.ts'

/** Ordered one-way edits avoid an async write queue at a window handoff. The main process owns the lease. */
export function createComposerDraftActions({ api, host, read, write }: {
  api: Pick<DraftApi, 'getDraft' | 'onDraft' | 'updateDraft' | 'appendDraftImage' | 'appendDraftFiles'>, host: DraftSnapshot['owner'], read: () => DraftContent, write: (draft: DraftSnapshot) => void,
}) {
  let current: DraftSnapshot | null = null
  let expected: string | null = null
  let applying = false
  let knownImages = new Set<string>()
  let knownFiles = new Set<string>()
  function accept(next: DraftSnapshot | null) {
    if (!next || current && next.epoch < current.epoch) return
    if (current && next.epoch === current.epoch && next.owner === host && next.sequence < current.sequence) {
      const local = read()
      const extra = next.images.filter(image => !knownImages.has(image.id) && !local.images.some(item => item.id === image.id))
      const files = next.files.filter(file => !knownFiles.has(file.path) && !local.files.some(item => item.path === file.path))
      current = { ...next, ...local, sequence: current.sequence, version: Math.max(current.version, next.version), images: [...local.images, ...extra], files: [...local.files, ...files] }
      next.images.forEach(image => knownImages.add(image.id))
      next.files.forEach(file => knownFiles.add(file.path))
      if (!extra.length && !files.length) return
      applying = true
      try { write(current) } finally { applying = false }
      return
    }
    if (current && next.epoch === current.epoch && next.version < current.version) return
    current = next
    knownImages = new Set(next.images.map(image => image.id))
    knownFiles = new Set(next.files.map(file => file.path))
    if (expected && next.key !== expected) return
    applying = true
    try { write(next) } finally { applying = false }
  }
  api.onDraft(accept)
  api.getDraft().then(accept)
  const ready = () => Boolean(current && current.owner === host && (!expected || current.key === expected))
  return {
    ready,
    snapshot: () => current,
    expect(key: string) {
      if (expected === key) return
      expected = key
      if (current?.key !== key) return
      applying = true
      try { write(current) } finally { applying = false }
    },
    changed() {
      if (applying || !current || !ready()) return
      const edit = { ...current, ...read(), sequence: current.sequence + 1, baseImages: current.images.map(image => image.id), baseFiles: current.files.map(file => file.path) }
      edit.images.forEach(image => knownImages.add(image.id))
      edit.files.forEach(file => knownFiles.add(file.path))
      current = { ...edit, version: edit.version + 1 }
      api.updateDraft(edit)
    },
    captureImage() {
      const origin = current
      return (image: DraftImage) => {
        if (!origin) return false
        if (current?.key === origin.key && current.epoch === origin.epoch && ready()) return false
        void api.appendDraftImage(origin.key, image)
        return true
      }
    },
    captureFiles() {
      const origin = current
      return (files: DraftFile[]) => {
        if (!origin || current?.key === origin.key && current.epoch === origin.epoch && ready()) return false
        if (files.length) void api.appendDraftFiles(origin.key, files.map(file => file.path))
        return true
      }
    },
  }
}

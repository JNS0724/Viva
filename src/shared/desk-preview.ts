import type { DraftFile } from './composer-draft.ts'

export interface DeskPreviewDraft {
  text: string
  files: readonly DraftFile[]
}

export interface DeskPreviewSurface {
  revision: number
  draft: DeskPreviewDraft
  focusBody?: boolean
}

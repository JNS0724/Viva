import { parseMemoryDocument } from './memory-document.ts'
import { inspectMarkdownBlocks } from './memory-markdown.ts'

export const RESIDENT_PROFILE_PATH = 'digest/personal/profile.md'
export const MAX_PROFILE_L2_CHARS = 800
export const CONFIRMED_SECTION_HEADING = '## 用户确认'
export const AUTO_SECTION_HEADING = '## 自动整理'

const CONFIRMED_TITLES = new Set(['用户确认', 'user confirmed'])
const AUTO_TITLES = new Set(['自动整理', 'auto summary'])
const SOURCES_TITLES = new Set(['sources', '来源'])

export function userWorkspaceId(hash: (text: string) => string): string {
  return hash(JSON.stringify([{ kind: 'user' }, { kind: 'user' }, null]))
}

/** Platform-independent case-insensitive check for the reserved global profile path. */
export function isReservedProfilePath(filePath: string): boolean {
  return filePath.toLowerCase() === RESIDENT_PROFILE_PATH
}

export function isResidentProfileIdentity(workspace: string, filePath: string, userWorkspace: string): boolean {
  return workspace === userWorkspace && isReservedProfilePath(filePath)
}

export function codePointLength(text: string): number {
  return [...text].length
}

function classifyReservedTitle(title: string): 'confirmed' | 'auto' | 'sources' | null {
  const normalized = title.trim().replace(/\s+/gu, ' ').toLowerCase()
  if (CONFIRMED_TITLES.has(normalized)) return 'confirmed'
  if (AUTO_TITLES.has(normalized)) return 'auto'
  if (SOURCES_TITLES.has(normalized)) return 'sources'
  return null
}

function classifyHeading(line: string): 'confirmed' | 'auto' | 'sources' | null {
  const blocks = inspectMarkdownBlocks(line)
  if (blocks.length === 1 && blocks[0]!.type === 'heading' && blocks[0]!.headingText !== undefined) {
    return classifyReservedTitle(blocks[0]!.headingText)
  }
  return null
}

export interface ParsedProfileSections {
  confirmedLines: string[]
  autoLines: string[]
  sourcesLines: string[]
  hasConfirmedHeading: boolean
  hasAutoHeading: boolean
  duplicateReservedHeading: boolean
}

export function parseProfileSections(body: string): ParsedProfileSections {
  const normalized = body.replace(/\r\n/gu, '\n')
  const blocks = inspectMarkdownBlocks(normalized)
  const confirmedLines: string[] = []
  const autoLines: string[] = []
  const sourcesLines: string[] = []
  let section: 'preamble' | 'confirmed' | 'auto' | 'sources' = 'preamble'
  let confirmedCount = 0
  let autoCount = 0
  let duplicateReservedHeading = false
  let nestedConfirmed = false

  const pushRaw = (raw: string) => {
    const target = section === 'confirmed' ? confirmedLines : section === 'sources' ? sourcesLines : autoLines
    const blockLines = raw.replace(/\n$/u, '').split('\n')
    for (const line of blockLines) target.push(line)
  }

  for (const block of blocks) {
    if (block.type === 'heading' && block.headingText !== undefined) {
      const kind = classifyReservedTitle(block.headingText)
      if (kind === 'confirmed') {
        confirmedCount++
        if (confirmedCount > 1) duplicateReservedHeading = true
        section = 'confirmed'
        continue
      }
      if (kind === 'auto') {
        autoCount++
        if (autoCount > 1) duplicateReservedHeading = true
        section = 'auto'
        continue
      }
      if (kind === 'sources') {
        section = 'sources'
        sourcesLines.push('## Sources')
        continue
      }
    }
    if (block.nestedHeadingTexts?.length) {
      for (const headingText of block.nestedHeadingTexts) {
        const kind = classifyReservedTitle(headingText)
        if (kind === 'confirmed') nestedConfirmed = true
        if (kind === 'auto') {
          autoCount++
          if (autoCount > 1) duplicateReservedHeading = true
        }
      }
    }
    if (block.type === 'space') {
      const blanks = Math.max(0, block.raw.split('\n').length - 1)
      const target = section === 'confirmed' ? confirmedLines : section === 'sources' ? sourcesLines : autoLines
      for (let i = 0; i < blanks; i++) target.push('')
      continue
    }
    pushRaw(block.raw)
  }

  return {
    confirmedLines: trimBlankEdges(confirmedLines),
    autoLines: trimBlankEdges(autoLines),
    sourcesLines: trimBlankEdges(sourcesLines),
    hasConfirmedHeading: confirmedCount > 0 || nestedConfirmed,
    hasAutoHeading: autoCount > 0,
    duplicateReservedHeading,
  }
}

function trimBlankEdges(lines: string[]): string[] {
  let start = 0
  let end = lines.length
  while (start < end && !lines[start]!.trim()) start++
  while (end > start && !lines[end - 1]!.trim()) end--
  return lines.slice(start, end)
}

export function formatProfileBody({ confirmedLines, autoLines, sourcesLines = [] }: {
  confirmedLines: readonly string[]
  autoLines: readonly string[]
  sourcesLines?: readonly string[]
}): string {
  const blocks: string[] = []
  const confirmed = trimBlankEdges([...confirmedLines])
  const auto = trimBlankEdges([...autoLines])
  const sources = trimBlankEdges([...sourcesLines])
  if (confirmed.length > 0) blocks.push(`${CONFIRMED_SECTION_HEADING}\n${confirmed.join('\n')}`)
  if (auto.length > 0 || confirmed.length === 0) {
    blocks.push(auto.length > 0 ? `${AUTO_SECTION_HEADING}\n${auto.join('\n')}` : AUTO_SECTION_HEADING)
  }
  if (sources.length > 0) blocks.push(sources.join('\n'))
  return blocks.join('\n\n')
}

/**
 * Deterministic user edit placement for `digest/personal/profile.md`:
 * - Existing lines edited/deleted inside `## 用户确认` follow the user's new text;
 * - Any non-empty line added or modified outside `## 用户确认` (including appended at the end)
 *   relative to `beforeBody` is placed into `## 用户确认` so Dream cannot overwrite it;
 * - Untouched `## 自动整理` lines remain in `## 自动整理`.
 */
export function mergeUserProfileEdit(beforeBody: string, afterBody: string): string {
  const before = parseProfileSections(beforeBody)
  const after = parseProfileSections(afterBody)
  const beforeAutoCounts = new Map<string, number>()
  for (const line of before.autoLines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    beforeAutoCounts.set(trimmed, (beforeAutoCounts.get(trimmed) ?? 0) + 1)
  }
  const nextConfirmed = [...after.confirmedLines]
  const nextAuto: string[] = []
  for (const line of after.autoLines) {
    const trimmed = line.trim()
    if (!trimmed) {
      nextAuto.push(line)
      continue
    }
    const remaining = beforeAutoCounts.get(trimmed) ?? 0
    if (remaining > 0) {
      beforeAutoCounts.set(trimmed, remaining - 1)
      nextAuto.push(line)
    } else {
      nextConfirmed.push(line)
    }
  }
  const beforeSourceCounts = new Map<string, number>()
  for (const line of before.sourcesLines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    beforeSourceCounts.set(trimmed, (beforeSourceCounts.get(trimmed) ?? 0) + 1)
  }
  const nextSources: string[] = []
  for (const line of after.sourcesLines) {
    const trimmed = line.trim()
    if (!trimmed) {
      nextSources.push(line)
      continue
    }
    const remaining = beforeSourceCounts.get(trimmed) ?? 0
    if (remaining > 0) {
      beforeSourceCounts.set(trimmed, remaining - 1)
      nextSources.push(line)
    } else if (classifyHeading(line) === 'sources' || /^-\s+\[\[.+?\]\]$/u.test(trimmed)) {
      nextSources.push(line)
    } else {
      nextConfirmed.push(line)
    }
  }
  return formatProfileBody({
    confirmedLines: nextConfirmed,
    autoLines: nextAuto,
    sourcesLines: nextSources.length > 0 ? nextSources : before.sourcesLines,
  })
}

/**
 * Dream write guard covering both CREATE and REFINE:
 * - Rejects any Dream output carrying a `## 用户确认` / `## User Confirmed` heading or duplicate reserved headings;
 * - Strips any `## 自动整理` heading wrapper from Dream output and assembles canonical sections;
 * - On CREATE: emits only `## 自动整理`;
 * - On REFINE: prepends existing `## 用户确认` verbatim before Dream's `## 自动整理`.
 */
export function assembleDreamProfileBody({ existingBody, autoSummaryBody, action }: {
  existingBody: string | null
  autoSummaryBody: string
  action: 'CREATE' | 'REFINE'
}): string {
  const proposed = parseProfileSections(autoSummaryBody)
  if (proposed.hasConfirmedHeading || proposed.duplicateReservedHeading) {
    throw new Error('dream-profile-reserved-heading')
  }
  const autoLines = proposed.autoLines
  if (autoLines.length === 0) throw new Error('dream-profile-empty-auto')
  const confirmedLines = action === 'REFINE' && existingBody !== null
    ? parseProfileSections(existingBody).confirmedLines
    : []
  return formatProfileBody({ confirmedLines, autoLines })
}

function truncateCodePoints(text: string, limit: number): string {
  if (limit <= 0) return ''
  const chars = [...text]
  if (chars.length <= limit) return text
  return limit === 1 ? '…' : `${chars.slice(0, limit - 1).join('')}…`
}

function confirmedProjectionBlock(confirmedLines: readonly string[]): string {
  const trimmed = trimBlankEdges([...confirmedLines])
  return trimmed.length > 0 ? `${CONFIRMED_SECTION_HEADING}\n${trimmed.join('\n')}` : ''
}

function autoProjectionBlock(autoLines: readonly string[]): string {
  const trimmed = trimBlankEdges([...autoLines])
  return trimmed.length > 0 ? `${AUTO_SECTION_HEADING}\n${trimmed.join('\n')}` : ''
}

/** Exact Unicode code point count of the confirmed section as projected into L2. */
export function measureConfirmedSectionL2(body: string): number {
  const parsed = parseProfileSections(body)
  return codePointLength(confirmedProjectionBlock(parsed.confirmedLines))
}

/**
 * Project stored profile Markdown into bounded L2 text:
 * - Strips frontmatter and `## Sources` provenance links;
 * - Preserves `## 用户确认` in full first;
 * - Allocates remaining code-point budget (up to `limit`) to `## 自动整理`.
 */
export function projectProfileL2(markdown: string, limit = MAX_PROFILE_L2_CHARS): string {
  let body = markdown
  try {
    body = parseMemoryDocument(markdown).body
  } catch { /* Fall back to raw body if frontmatter is absent. */ }
  const parsed = parseProfileSections(body)
  const confirmedBlock = confirmedProjectionBlock(parsed.confirmedLines)
  const autoBlock = autoProjectionBlock(parsed.autoLines)
  if (!confirmedBlock && !autoBlock) return ''
  if (!confirmedBlock) return truncateCodePoints(autoBlock, limit)
  const confirmedLen = codePointLength(confirmedBlock)
  if (confirmedLen >= limit || !autoBlock) {
    return truncateCodePoints(confirmedBlock, limit)
  }
  const separator = '\n\n'
  const remaining = limit - confirmedLen - codePointLength(separator)
  if (remaining <= codePointLength(AUTO_SECTION_HEADING) + 1) {
    return confirmedBlock
  }
  const autoBodyBudget = remaining - codePointLength(`${AUTO_SECTION_HEADING}\n`)
  const autoBody = trimBlankEdges([...parsed.autoLines]).join('\n')
  const fittedAuto = `${AUTO_SECTION_HEADING}\n${truncateCodePoints(autoBody, autoBodyBudget)}`
  return `${confirmedBlock}${separator}${fittedAuto}`
}

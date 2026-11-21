import { memoryDocumentLines } from './memory-document.ts'

export interface MemoryLineRevision {
  at: number
  before: string
  after: string
}

export interface MemoryLineChange {
  at: number
  before: string
  after: string
}

type LineHunk = { bStart: number, bEnd: number, aStart: number, aEnd: number }

const MAX_LCS_CELLS = 200_000
const DEFAULT_MAX_CHARS = 300

function splitLines(markdown: string): string[] {
  return memoryDocumentLines(markdown).map(line => markdown.slice(line.startOffset, line.contentEndOffset))
}

function clipText(text: string, maxChars: number): string {
  const chars = [...text]
  return chars.length > maxChars ? chars.slice(0, Math.max(1, maxChars - 1)).join('') + '…' : text
}

function diffLineHunks(before: readonly string[], after: readonly string[]): LineHunk[] {
  let prefix = 0
  const minLen = Math.min(before.length, after.length)
  while (prefix < minLen && before[prefix] === after[prefix]) prefix++

  let suffix = 0
  while (
    suffix < before.length - prefix
    && suffix < after.length - prefix
    && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix++
  }

  const bMidStart = prefix
  const bMidEnd = before.length - suffix
  const aMidStart = prefix
  const aMidEnd = after.length - suffix
  const bLen = bMidEnd - bMidStart
  const aLen = aMidEnd - aMidStart

  if (bLen === 0 && aLen === 0) return []
  if (bLen === 0 || aLen === 0 || bLen * aLen > MAX_LCS_CELLS) {
    return [{ bStart: bMidStart, bEnd: bMidEnd, aStart: aMidStart, aEnd: aMidEnd }]
  }

  const cols = aLen + 1
  const dp = new Int32Array((bLen + 1) * cols)
  for (let i = bLen - 1; i >= 0; i--) {
    const bLine = before[bMidStart + i]!
    const row = i * cols
    const nextRow = (i + 1) * cols
    for (let j = aLen - 1; j >= 0; j--) {
      if (bLine === after[aMidStart + j]!) {
        dp[row + j] = dp[nextRow + j + 1]! + 1
      } else {
        const down = dp[nextRow + j]!
        const right = dp[row + j + 1]!
        dp[row + j] = down >= right ? down : right
      }
    }
  }

  const hunks: LineHunk[] = []
  let i = 0
  let j = 0
  let hBStart = -1
  let hAStart = -1
  const flush = (bIdx: number, aIdx: number) => {
    if (hBStart !== -1) {
      hunks.push({ bStart: bMidStart + hBStart, bEnd: bMidStart + bIdx, aStart: aMidStart + hAStart, aEnd: aMidStart + aIdx })
      hBStart = -1
      hAStart = -1
    }
  }
  while (i < bLen && j < aLen) {
    if (before[bMidStart + i] === after[aMidStart + j]) {
      flush(i, j)
      i++
      j++
    } else {
      if (hBStart === -1) { hBStart = i; hAStart = j }
      if (dp[(i + 1) * cols + j]! >= dp[i * cols + (j + 1)]!) i++
      else j++
    }
  }
  if (i < bLen || j < aLen) {
    if (hBStart === -1) { hBStart = i; hAStart = j }
    flush(bLen, aLen)
  } else {
    flush(i, j)
  }
  return hunks
}

function mapSurvivingRange(hunks: readonly LineHunk[], start: number, end: number): [number, number] | null {
  let firstB = -1
  let lastB = -1
  let delta = 0
  let cursor = 0
  for (const hunk of hunks) {
    const segStart = Math.max(start, cursor)
    const segEnd = Math.min(end, hunk.aStart)
    if (segStart < segEnd) {
      if (firstB === -1) firstB = segStart + delta
      lastB = segEnd + delta
    }
    delta += (hunk.bEnd - hunk.bStart) - (hunk.aEnd - hunk.aStart)
    cursor = hunk.aEnd
  }
  const tailStart = Math.max(start, cursor)
  if (tailStart < end) {
    if (firstB === -1) firstB = tailStart + delta
    lastB = end + delta
  }
  return firstB !== -1 && firstB < lastB ? [firstB, lastB] : null
}

/**
 * Git-style line history (`git log -L`) over newest-first verified document revisions.
 * Traces `[startLine, endLine]` (1-based inclusive into `revisions[0].after`) backward
 * across revisions until the most recent revision that replaced or removed non-empty
 * text inside those lines, ignoring edits to other sections or pure insertions.
 */
export function traceLineHistory(
  revisions: readonly MemoryLineRevision[],
  startLine: number,
  endLine: number,
  maxChars = DEFAULT_MAX_CHARS,
): MemoryLineChange | null {
  if (!revisions.length || !Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) || startLine < 1 || endLine < startLine) {
    return null
  }
  let curStart = startLine - 1
  let curEnd = endLine
  let initialized = false

  for (const revision of revisions) {
    const afterLines = splitLines(revision.after)
    if (!initialized) {
      curEnd = Math.min(curEnd, afterLines.length)
      if (curStart >= curEnd) return null
      initialized = true
    }
    const beforeLines = splitLines(revision.before)
    const hunks = diffLineHunks(beforeLines, afterLines)
    if (!hunks.length) continue

    const overlapping = hunks.filter(hunk =>
      hunk.aEnd > hunk.aStart
        ? hunk.aStart < curEnd && hunk.aEnd > curStart
        : hunk.bEnd > hunk.bStart && curStart < hunk.aStart && hunk.aStart < curEnd,
    )
    const beforeParts = overlapping
      .flatMap(hunk => hunk.bEnd > hunk.bStart ? [beforeLines.slice(hunk.bStart, hunk.bEnd).join('\n').trim()] : [])
      .filter(Boolean)
    if (beforeParts.length) {
      const afterParts = overlapping
        .flatMap(hunk => hunk.aEnd > hunk.aStart ? [afterLines.slice(hunk.aStart, hunk.aEnd).join('\n').trim()] : [])
        .filter(Boolean)
      return {
        at: revision.at,
        before: clipText(beforeParts.join('\n...\n'), maxChars),
        after: clipText(afterParts.join('\n...\n'), maxChars),
      }
    }

    const mapped = mapSurvivingRange(hunks, curStart, curEnd)
    if (!mapped) return null
    ;[curStart, curEnd] = mapped
  }
  return null
}

const han = /^\p{Script=Han}+$/u
// Break at Han/Latin boundaries, including when a project code is adjacent to Han text.
const words = /\p{Script=Han}+|(?:(?!\p{Script=Han})[\p{L}\p{M}\p{N}])+(?:[-_./@](?:(?!\p{Script=Han})[\p{L}\p{M}\p{N}])+)*/gu

export function memorySearchTokens(text: string, indexing: boolean) {
  const result: string[] = []
  for (const part of text.normalize('NFKC').toLowerCase().match(words) ?? []) {
    if (han.test(part)) {
      const chars = [...part]
      if (indexing || chars.length === 1) for (const char of chars) result.push(char)
      for (let index = 1; index < chars.length; index++) result.push(chars[index - 1] + chars[index])
    } else {
      result.push(part)
      if (indexing && /[-_./@]/u.test(part)) result.push(...part.split(/[-_./@]/u))
    }
  }
  return result
}

export function lexicalTerms(text: string, indexing: boolean) {
  return new Set(memorySearchTokens(text, indexing))
}

/** Verify an index hit against language visible in the canonical projection. */
export function memoryIndexMatches(text: string, query: string, keywords: readonly string[] = []) {
  const indexed = lexicalTerms([text, ...keywords].join(' '), true)
  const terms = lexicalTerms(query, false)
  return terms.size > 0 && [...terms].every(term => indexed.has(term))
}

// Explicit identifiers retain their exact token even when the rest of a query is semantic.
export function memoryIdentifierTokens(text: string) {
  return (text.normalize('NFKC').toLowerCase().match(words) ?? [])
    .filter(part => /^\p{L}[\p{L}\p{M}\p{N}]*([-_./][\p{L}\p{M}\p{N}]+)+$/u.test(part) && /\p{N}/u.test(part))
}

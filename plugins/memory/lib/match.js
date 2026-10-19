/**
 * Layer 3 of retrieval: what `recall` finds for the keywords the model chose. Chinese has no spaces and
 * most words are two characters, so text is compared by character pairs (bigrams); Latin words and
 * numbers count whole. The store holds at most a few thousand short lines, so scoring them all takes
 * milliseconds.
 */

/** Pairs that appear in almost any request and say nothing about its topic. */
export const STOP_BIGRAMS = new Set([
  '帮我', '一下', '我们', '你们', '他们', '这个', '那个', '什么', '怎么', '可以', '一个', '没有', '就是',
  '还是', '然后', '已经', '因为', '所以', '如果', '但是', '需要', '看看', '告诉', '请你', '是不', '不是',
  '的话', '一些', '有没', '现在', '时候', '这些', '那些', '为什', '么样',
])
/** Function words: a pair containing one ("的周", "张三是") is grammar, not topic. */
const STOP_CHARS = new Set([...'的了吗呢吧啊呀是我你他她它们这那个一不也都就还在和与把被给谁哪'])
const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'this', 'that', 'you', 'are', 'can', 'please'])
const MIN_WORD_CHARS = 2
/** Words say more than single Han pairs. */
const WORD_WEIGHT = 2

const isHan = (char) => /\p{Script=Han}/u.test(char)

/**
 * @param {string} text
 * @returns {Set<string>} lower-cased words and Han bigrams
 */
export function termsOf(text) {
  const terms = new Set()
  for (const segment of String(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    const chars = [...segment]
    if (!chars.some(isHan)) {
      if (chars.length >= MIN_WORD_CHARS && !STOP_WORDS.has(segment)) terms.add(segment)
      continue
    }
    for (let i = 0; i + 1 < chars.length; i += 1) {
      const pair = chars[i] + chars[i + 1]
      if (!STOP_BIGRAMS.has(pair) && !STOP_CHARS.has(chars[i]) && !STOP_CHARS.has(chars[i + 1])) terms.add(pair)
    }
  }
  return terms
}

/** Share of the query a memory must cover: one stray shared pair out of four is not a match. */
export const MIN_COVERAGE = 0.34
const termWeight = (term) => ([...term].some(isHan) ? 1 : WORD_WEIGHT)

function scoreOf(queryTerms, text) {
  const haystack = text.toLowerCase()
  let score = 0
  for (const term of queryTerms) {
    if (haystack.includes(term)) score += termWeight(term)
  }
  return score
}

/** The query's words, as the model separated them ("结算口径 财务"). */
const queryWords = (query) => String(query).toLowerCase().split(/[\s,，、;；]+/).filter((word) => [...word].length >= 2)

/** A keyword the memory was saved with appears in the query, or a query word is part of one. */
function hitsKeyword(memory, words) {
  return (memory.keywords ?? []).some((keyword) => {
    const key = keyword.toLowerCase()
    return words.some((word) => word.includes(key) || key.includes(word))
  })
}

/**
 * @template {{ text: string, keywords?: string[], updatedAt: number }} T
 * @param {T[]} memories
 * @param {string} query keywords, separated by spaces
 * @param {number} limit
 * @returns {T[]} memories that match one of their keywords or cover enough of the query, best first;
 *   none at all rather than weak ones
 */
export function recallMatches(memories, query, limit) {
  const terms = termsOf(query)
  const words = queryWords(query)
  if (terms.size === 0 && words.length === 0) return []
  const total = [...terms].reduce((sum, term) => sum + termWeight(term), 0)
  const needed = Math.max(1, Math.ceil(total * MIN_COVERAGE))
  return memories
    .map((memory) => {
      const keyword = hitsKeyword(memory, words)
      const score = scoreOf(terms, memory.text) + (keyword ? WORD_WEIGHT : 0)
      return { memory, score, keep: keyword || score >= needed }
    })
    .filter(({ keep }) => keep)
    .sort((a, b) => b.score - a.score || b.memory.updatedAt - a.memory.updatedAt)
    .slice(0, limit)
    .map(({ memory }) => memory)
}

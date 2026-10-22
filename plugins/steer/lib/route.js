/**
 * Where words typed while a turn runs should go, judged by the model itself (the app's guess from the words
 * alone gets it wrong now and then): into the turn, or something else, the turn moving to the background.
 * One short call on the session's own model route; the app falls back to its guess when it has no answer.
 */
export const ROUTE_SYSTEM = [
  '你是插话分流器。用户在助手做一件事的时候又说了一句话。',
  '判断这句话是在补充、修改、追问正在做的这件事（INTO），还是一件与它无关的新事（OTHER）。',
  '拿不准时回答 INTO。只回答 INTO 或 OTHER 一个词，不要解释。',
].join('\n')

export const ROUTE_MAX_TOKENS = 8
export const ROUTE_TIMEOUT_MS = 4000

/** The question put to the model: what runs, and what was just said. */
export const routeInput = (words, text) => JSON.stringify({ running: words, said: text })

/** @returns {'into' | 'other'} only a clear OTHER moves the turn; anything else stays with it */
export const routeOf = (answer) => (/OTHER/i.test(String(answer ?? '')) ? 'other' : 'into')

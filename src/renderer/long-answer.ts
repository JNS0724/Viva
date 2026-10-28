/**
 * How much of a finished answer is drawn at first: a very long one (a 200 KB report is thousands of elements) shows
 * its start, cut where a paragraph ends, and the rest when asked for (展开全文, view/thread.ts).
 */
export const LONG_ANSWER_CHARS = 16_000
const FENCE = /^```/gm

/** The start of a long answer: up to LONG_ANSWER_CHARS, ending with a paragraph, never inside a code block. */
export function answerStart(text: string): string {
  const head = text.slice(0, LONG_ANSWER_CHARS)
  const paragraph = head.lastIndexOf('\n\n')
  let cut = paragraph > LONG_ANSWER_CHARS / 2 ? head.slice(0, paragraph) : head
  // An odd number of fences: the cut is inside a code block; end before it.
  if ((cut.match(FENCE)?.length ?? 0) % 2 === 1) cut = cut.slice(0, cut.lastIndexOf('```'))
  return cut
}

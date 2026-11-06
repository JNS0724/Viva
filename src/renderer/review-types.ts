

/** A background task of a topic (history-review.ts ReviewTask). */
export type ReviewTask = { id: string, createdAt: number, title: string, turns: number, hasFiles: boolean, stars: number }

/** A topic as the history lists it (history-review.ts ReviewTopic). */
export type ReviewTopic = {
  id: string, title: string, startedAt: number, lastAt: number, turns: number, hasFiles: boolean, stars: number,
  cwds: readonly string[], segments: readonly string[], head: string | null, tasks: readonly ReviewTask[],
}

/** A message read in 回顾, with the segment it is kept in. */
export type ReaderMessage = SegmentMessage & { segmentId: string }

/**
 * What is read at the top: opened from a hit, a link or a star; `found`, the message it named (its `data-msg`),
 * marked while it is open; `notice` when that message itself is not there.
 */
export type ReviewFocus = { key: string, title: string, at: number | null, head: string | null, found: string | null, notice: string | null }


/**
 * The part of what is read that is drawn: `messages` from place `from` of `total` (history-reader.ts), never more
 * than READER_MAX, so a topic of a thousand turns reads with no more on the page than a short one. Reading on at one
 * end lets go of as many at the other; `loading`, the end being read. `read` names the reading it came from (a part
 * asked for by an earlier one, opened before the topic was opened again elsewhere, is not taken); `whole`, a segment
 * read with the talk it shares, as every part read on of it is too.
 */
export type ReaderWindow = {
  key: string, read: number, whole: boolean, total: number, from: number, messages: readonly ReaderMessage[], loading: 'before' | 'after' | null,
}

export type ReaderEdge = 'before' | 'after'

/** A part read from the history: where it starts, what it holds. */
export type ReadPart = { total: number, from: number, messages: readonly ReaderMessage[] }

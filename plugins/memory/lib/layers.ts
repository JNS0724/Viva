import { namesIn, namesOfMemory } from './names.ts'

/**
 * Decides, turn by turn, what each retrieval layer puts in front of the model. Pure: the session state
 * goes in and the next one comes out, so every rule can be tested with plain values.
 *
 *  1. fixed  — memory rules, profile, preferences, habits. No search. Sent on a session's first turn,
 *              again when it changes, and again after dsh compacts the conversation (which may drop it).
 *  2. pushed — memories about a name the user's own words mention, at most PUSH_LIMIT, each once per
 *              session. Nothing is pushed on a loose word overlap.
 *  3. pulled — everything else: the model calls `recall` with keywords of its own (tools.js).
 */
export const PUSH_LIMIT = 3
/** Pasted material (an email, a log) mentions everything; the user's own words around it say what they want. */
export const LONG_PROMPT_CHARS = 300
const INSTRUCTION_CHARS = 120
/** "那第二个呢", "继续": too short to name anything, so the previous question says what it is about. */
const FOLLOW_UP_CHARS = 6
const FOLLOW_UP_START = /^(那|这|那么|还有|继续|然后|再|另外|第[一二三四五六七八九十\d]+)/
/** Bounds the per-session list of pushed memories; older entries may be pushed again. */
const MAX_PUSHED_TRACKED = 200

export const initialSession = Object.freeze({
  /** What the fixed layer looked like when last sent, or null before the first turn. */
  fixedSignature: null,
  /** How many compactions the session had when the fixed layer was last sent. */
  epoch: 0,
  /** `id:updatedAt` of memories already pushed; an edited memory counts as new. */
  pushed: [],
  /** The previous question's own words, for follow-ups. */
  previous: '',
  /** The date last sent; a new day sends it again, so relative dates resolve right. */
  lastDate: null,
})

/** The user's own words: all of a short question, the first and last lines around pasted material. */
export function ownWords(question) {
  const text = String(question ?? '').trim()
  if (text.length <= LONG_PROMPT_CHARS) return text
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)
  if (lines.length === 1) return `${text.slice(0, INSTRUCTION_CHARS)}\n${text.slice(-INSTRUCTION_CHARS)}`
  return `${lines[0].slice(0, INSTRUCTION_CHARS)}\n${lines[lines.length - 1].slice(-INSTRUCTION_CHARS)}`
}

export const isFollowUp = (words) => words.length <= FOLLOW_UP_CHARS || FOLLOW_UP_START.test(words)

/** What layer 2 looks for names in: the question's own words, after the previous question's for a follow-up. */
export function retrievalBasis(question, previous = '') {
  const own = ownWords(question)
  return { own, basis: previous && isFollowUp(own) ? `${previous}\n${own}` : own }
}

const pushKey = (memory) => `${memory.id}:${memory.updatedAt}`

/** Why the fixed layer goes out this turn: 'first', 'compacted', 'changed', or null when the model has it. */
function fixedReason(session, signature, epoch) {
  if (session.fixedSignature === null) return 'first'
  if (session.epoch !== epoch) return 'compacted'
  if (session.fixedSignature !== signature) return 'changed'
  return null
}

/** Memories about the named keys, the ones naming more of them first, then the newer. */
function memoriesAbout(memories, named, lexicon) {
  const candidates = lexicon.filter((entry) => named.has(entry.key))
  return memories
    .map((memory) => {
      const about = namesOfMemory(memory, candidates)
      return { memory, names: [...named.keys()].filter((key) => about.has(key)).map((key) => named.get(key)) }
    })
    .filter(({ names }) => names.length > 0)
    .sort((a, b) => b.names.length - a.names.length || b.memory.updatedAt - a.memory.updatedAt)
}

/**
 * @param {typeof initialSession} session
 * @param {{
 *   question: string,
 *   fixedSignature: string,
 *   epoch: number,
 *   today: string,
 *   memories: Array<{ id: number, text: string, keywords?: string[], updatedAt: number }>,
 *   lexicon: import('./names.ts').NameEntry[],
 *   inFixed: Set<number>,
 * }} turn inFixed: ids of memories the fixed layer carries already (the preferences)
 * @returns {{
 *   session: typeof initialSession,
 *   fixed: null | 'first' | 'compacted' | 'changed',
 *   pushed: Array<{ memory: object, names: string[] }>,
 *   dated: boolean,
 * }} dated: whether the date goes out (with anything else sent, or alone on a new day)
 */
export function planTurn(session, { question, fixedSignature, epoch, today, memories, lexicon, inFixed }) {
  const fixed = fixedReason(session, fixedSignature, epoch)
  // A fresh or compacted context has lost what was pushed before, so pushing starts over.
  const alreadyPushed = new Set(fixed === 'first' || fixed === 'compacted' ? [] : session.pushed)
  const { own, basis } = retrievalBasis(question, session.previous)
  const named = namesIn(basis, lexicon)
  const pushed = named.size === 0 ? [] : memoriesAbout(memories, named, lexicon)
    .filter(({ memory }) => !inFixed.has(memory.id) && !alreadyPushed.has(pushKey(memory)))
    .slice(0, PUSH_LIMIT)
  const dated = Boolean(fixed) || pushed.length > 0 || session.lastDate !== today
  return {
    fixed,
    pushed,
    dated,
    session: {
      fixedSignature,
      epoch,
      lastDate: dated ? today : session.lastDate,
      pushed: [...alreadyPushed, ...pushed.map(({ memory }) => pushKey(memory))].slice(-MAX_PUSHED_TRACKED),
      previous: own,
    },
  }
}

import { recallMatches } from './match.js'
import { buildLexicon, namesIn, namesOfMemory } from './names.js'
import { MAX_EXTRACTED_CHANGES, MEMORY_KINDS } from './store.js'

/**
 * The background pass after each turn: a second model call reads what the user said and the answer,
 * next to the memories it might touch, and proposes changes. The model decides what to remember;
 * the code decides what it may do: only add, or mark one of the memories it was shown as no longer
 * true, never touching what the user wrote, all checked and applied as one batch (store.applyExtraction).
 */

/** Below this, a turn ("好的", "继续") says nothing worth keeping. */
const MIN_WORDS = 4
/**
 * Cheap pre-filter: the user saying something about themselves, their work or how they want answers.
 * A bare 「我」 is not enough: 「帮我算一下」 is a task, not a fact about the user.
 */
const SIGNALS = /我(?:是|在|叫|们|负责|喜欢|习惯|讨厌|希望|一般|通常|平时|不喜欢)|咱们|以后|今后|下次|每次|每[天周月]|总是|一直|别再|不要再|记得|记住|上级|同事|老板|团队|偏好|改成|换成|不再|调到|离职|入职|搬到/
const MAX_CANDIDATES = 10
const MAX_REPLY_CHARS = 1500

export const EXTRACT_SYSTEM = [
  '你是记忆整理员。读一轮对话（用户的话和助手的回答）以及若干条已有记忆，决定是否需要更新用户的长期记忆。',
  '只记录以后仍然有用、关于用户本人或其工作的信息：身份与职责、常打交道的人、在推进的项目、约定和决定、用户对回答方式的偏好，以及常住城市、所在时区这类稳定的个人情况。',
  'answers（如果有）是用户这一轮对助手提问的回答，和用户自己说的话同等可信；只回答了一次性任务细节的，不要记。',
  '不要记录：一次性的任务内容、助手自己的建议或推测、闲聊、密码密钥验证码证件号等敏感信息、画像或已有记忆里已经有的内容。',
  '每条记忆一句话，写清主语；日期写成具体日期（今天的日期在输入里）。keywords 只写这条记忆的核心对象（人名、项目名、系统名），1–3 个。',
  'kind：role 用户的身份、部门、职责；person 常打交道的人；project 在推进的事；preference 对回答方式的偏好；fact 其他。',
  '新信息和某条已有记忆矛盾时，新增一条，并在 replaces 里写那条旧记忆的 id；某条已有记忆明确不再成立且没有替代时，把 id 放进 invalidate。',
  `只输出一个 JSON 对象，不要任何解释：{"add":[{"text":"…","kind":"role|person|project|preference|fact","keywords":["…"],"replaces":null}],"invalidate":[]}。最多 ${MAX_EXTRACTED_CHANGES} 处改动；没有要改的就输出 {"add":[],"invalidate":[]}。`,
].join('\n')

/** Whether this turn is worth a model call at all. */
export function worthExtracting(userWords, lexicon) {
  const words = String(userWords ?? '').trim()
  if (words.length < MIN_WORDS) return false
  return SIGNALS.test(words) || namesIn(words, lexicon).size > 0
}

/** The memories the extractor sees, and so the only ones it may replace: about what the turn names, then by wording. */
export function candidatesFor(userWords, memories, lexicon) {
  const named = namesIn(userWords, lexicon)
  const entries = lexicon.filter((entry) => named.has(entry.key))
  const isAboutNamed = (memory) => [...namesOfMemory(memory, entries)].some((key) => named.has(key))
  const byName = named.size ? memories.filter(isAboutNamed) : []
  const byWords = recallMatches(memories, userWords, MAX_CANDIDATES)
  const unique = new Map([...byName, ...byWords].map((memory) => [memory.id, memory]))
  return [...unique.values()].slice(0, MAX_CANDIDATES)
}

/** Everything goes in as JSON, so nothing the user typed can pose as an instruction or a delimiter. */
export function extractionInput({ userWords, answers = [], reply, today, candidates, profile = {} }) {
  return JSON.stringify({
    today,
    profile: Object.fromEntries(Object.entries(profile).map(([field, entry]) => [field, entry.value])),
    user: userWords,
    ...(answers.length ? { answers } : {}),
    assistant: String(reply ?? '').slice(0, MAX_REPLY_CHARS),
    memories: candidates.map((memory) => ({ id: memory.id, text: memory.text, kind: memory.kind, writtenBy: memory.source })),
  })
}

const isId = (value) => Number.isSafeInteger(value) && value > 0
const isStringList = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string')

function checkAddition(item) {
  if (typeof item !== 'object' || item === null || typeof item.text !== 'string') throw new Error('add 里的每一项都要有 text')
  if (item.kind !== undefined && !MEMORY_KINDS.includes(item.kind)) throw new Error(`未知的 kind：${item.kind}`)
  if (item.keywords !== undefined && !isStringList(item.keywords)) throw new Error('keywords 必须是文本列表')
  if (item.replaces !== undefined && item.replaces !== null && !isId(item.replaces)) throw new Error('replaces 必须是记忆 id')
  return { text: item.text, kind: item.kind ?? 'fact', keywords: item.keywords ?? [], replaces: item.replaces ?? null }
}

/**
 * The model's answer as a checked change set. Anything off-shape throws, and the whole answer is dropped.
 * @returns {{ add: Array<{ text: string, kind: string, keywords: string[], replaces: number | null }>, invalidate: number[] }}
 */
export function parseExtraction(text) {
  const body = String(text ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  let value
  try {
    value = JSON.parse(body)
  } catch {
    throw new Error('输出不是 JSON')
  }
  if (typeof value !== 'object' || value === null || !Array.isArray(value.add ?? []) || !Array.isArray(value.invalidate ?? [])) {
    throw new Error('输出缺少 add / invalidate 列表')
  }
  const invalidate = value.invalidate ?? []
  if (!invalidate.every(isId)) throw new Error('invalidate 必须是记忆 id 列表')
  return { add: (value.add ?? []).map(checkAddition), invalidate }
}

/**
 * One background pass. `complete(system, input)` calls the model and resolves to its text.
 * `answers`: what the user answered to the agent's questions this turn ({ question, answer }).
 * @returns {Promise<null | { added: object[], invalidated: number[] }>} null when the turn was skipped
 * @throws when the model call fails or its answer is unusable; nothing has been written then
 */
export async function extractTurn({ db, userWords, answers = [], reply, today, complete }) {
  const memories = db.allMemories()
  const profile = db.getProfile()
  const lexicon = buildLexicon(profile, memories)
  // An answer to the agent's question is the user telling it something: always worth a look.
  if (answers.length === 0 && !worthExtracting(userWords, lexicon)) return null
  const said = [userWords, ...answers.map((item) => `${item.question} ${item.answer}`)].join('\n')
  const candidates = candidatesFor(said, memories, lexicon)
  const answer = await complete(EXTRACT_SYSTEM, extractionInput({ userWords, answers, reply, today, candidates, profile }))
  const changes = parseExtraction(answer)
  if (changes.add.length === 0 && changes.invalidate.length === 0) return { added: [], invalidated: [] }
  return db.applyExtraction({ ...changes, shown: new Set(candidates.map((memory) => memory.id)) })
}

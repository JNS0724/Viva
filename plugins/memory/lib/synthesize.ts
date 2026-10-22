import { MAX_SYNTHESIS_CHARS } from './store.ts'

/**
 * The periodic profile: now and then the agent's model rewrites what the valid memories say about the
 * user into one short profile. Memories stay the only source, and the synthesis is rebuilt from the
 * valid ones alone (never from the previous synthesis), so an invalidated memory drops out of the profile
 * at the next run. Between runs the fixed layer lists the memories written since (context.js), so nothing
 * waits for the next synthesis to count.
 */
export const SYNTHESIS_INTERVAL_MS = 24 * 60 * 60 * 1000
/** This many changes are worth a fresh synthesis before the interval is up. */
export const SYNTHESIS_MIN_CHANGES = 5
/** Profile memories are one-line facts; this many fit comfortably in one call. */
const SYNTHESIS_MEMORY_LIMIT = 150
export const SYNTHESIS_SECTIONS = Object.freeze(['身份与职责', '常打交道的人', '在推进的事', '偏好'])

export const SYNTHESIS_SYSTEM = [
  '你是画像整理员。根据用户自己填写的画像和长期记忆，写一份关于用户的简短画像，供另一个助手在对话开始时阅读。',
  `只用这几个小标题，每个占一行，按顺序：${SYNTHESIS_SECTIONS.map((section) => `【${section}】`).join('')}；没有内容的小标题省略。`,
  '每个小标题下写 1–5 行，每行以「- 」开头，一句话。只写记忆和画像里有的内容，不推测，不补充；记忆之间矛盾时以日期更新的为准。',
  `用户自己填写的画像优先，不要改写它的意思。总长度不超过 ${Math.floor(MAX_SYNTHESIS_CHARS * 0.6)} 字。只输出画像本身，不要任何解释。`,
].join('\n')

/**
 * Whether a new synthesis is due: something changed, and either there is none yet, it is old, much changed,
 * or a profile memory it may repeat stopped being true (a profile saying the old manager is wrong at once).
 */
export function synthesisDue({ latest, changes, invalidated = 0, now }) {
  if (changes === 0) return false
  if (!latest || invalidated > 0) return true
  return now - latest.createdAt >= SYNTHESIS_INTERVAL_MS || changes >= SYNTHESIS_MIN_CHANGES
}

const pad = (n) => String(n).padStart(2, '0')
const day = (ts) => {
  const date = new Date(ts)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** As JSON, so nothing in a memory can pose as an instruction. */
export function synthesisInput({ profile, memories }: { profile: Record<string, { value: string }>, memories: ReadonlyArray<{ updatedAt: number, kind: string, text: string }> }) {
  return JSON.stringify({
    userProfile: Object.fromEntries(Object.entries(profile).map(([field, entry]) => [field, entry.value])),
    memories: memories.map((memory) => ({ date: day(memory.updatedAt), kind: memory.kind, text: memory.text })),
  })
}

/**
 * The model's profile, accepted only in the agreed form: known headings in order, then "- " lines.
 * @throws when it is anything else; the previous synthesis stays in use then
 */
export function checkSynthesis(text) {
  const lines = String(text ?? '').trim().split('\n').map((line) => line.trim()).filter(Boolean)
  if (lines.length === 0) throw new Error('画像是空的')
  let lastSection = -1
  for (const line of lines) {
    const heading = /^【(.+)】$/.exec(line)
    if (!heading) {
      if (lastSection < 0 || !line.startsWith('- ')) throw new Error(`不是约定的格式：${line.slice(0, 20)}`)
      continue
    }
    const index = SYNTHESIS_SECTIONS.indexOf(heading[1])
    if (index <= lastSection) throw new Error(`小标题不对或顺序不对：${line}`)
    lastSection = index
  }
  return lines.join('\n')
}

/**
 * Rewrites the profile when it is due. `complete(system, input)` calls the model.
 * @returns {Promise<null | { id: number, text: string, createdAt: number }>} null when not due
 * @throws when the call fails or the answer is unusable; nothing is saved then
 */
export async function synthesizeProfile({ db, complete, now = Date.now() }) {
  const latest = db.latestSynthesis()
  const since = latest?.createdAt ?? 0
  if (!synthesisDue({ latest, changes: db.changesSince(since), invalidated: db.profileInvalidationsSince(since), now })) return null
  const input = synthesisInput({ profile: db.getProfile(), memories: db.profileMemories({ limit: SYNTHESIS_MEMORY_LIMIT }) })
  return db.saveSynthesis(checkSynthesis(await complete(SYNTHESIS_SYSTEM, input)))
}

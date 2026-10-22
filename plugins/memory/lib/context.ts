import { PROFILE_FIELDS } from '../../../src/shared/profile-fields.ts'

/**
 * The background sent ahead of a question: the fixed layer when it is due (rules, the profile the user
 * wrote, the profile the agent last synthesised from memories, the profile memories written since, habits),
 * and the memories pushed because the question named something. It is a separate text block of the
 * prompt, never shown in the thread. Nothing at all goes out on a turn with neither.
 */
export const CONTEXT_TAG = 'about-user'
/** Budget for the fixed layer; pushed memories (a few lines at most) come on top. */
export const MAX_CONTEXT_CHARS = 3200
/** Profile memories newer than the last synthesis that ride along with it, newest first. */
export const RECENT_LIMIT = 8
const FIELD_CHARS = 300
/** Only used once mail is connected; the model has no use for the address itself. */

const FIXED_INTRO = '以下是本机保存的用户画像和长期偏好，帮助你理解用户的背景。与当前请求无关的部分请忽略，也不必向用户复述。'
/** How to use the memory tools; sent with the fixed layer, so the model has it from a session's first turn. */
export const MEMORY_RULES = [
  '用户可以在「关于你」页面查看、修改和删除每一条记忆；【画像】由用户自己填写，你不能修改。',
  '用户透露了以后仍然有用的信息时，用 memory_remember 保存：身份、部门、职责用 kind=role，常打交道的人用 kind=person，',
  '在推进的项目用 kind=project，其他事实、约定、决定用 kind=fact；keywords 写这条记忆的核心对象（人名、项目名、系统名），1–3 个。',
  '记忆里的日期写成具体日期（今天的日期见【今天】），不要写「下周五」「明天」。',
  '用户对你以后怎么做提出要求（例如「以后先给结论」「表格对比方案」）时，也要用 memory_remember 保存，kind=preference；',
  '这类要求只记在对话里，下次就会忘。只有工具调用成功后才能说「记住了」，没有调用就不要这样说。',
  '不要保存密码、密钥、验证码、证件号等敏感信息，也不要保存一次性的闲聊或你自己的推测。保存后用一句话告诉用户你记住了什么。',
  '用户提到画像或记忆里的人和事时，系统会自动附上【相关记忆】，那已经是检索结果，够用就直接回答，不必再查；',
  '它们不够、或者涉及具体的人、项目、过去的约定或决定而你没有背景时，才用 memory_recall 查，查询写 2–4 个关键词；',
  '查不到就如实说不知道，不要编造。用户要求忘掉某件事时，先查到编号再用 memory_forget 让它失效。',
].join('')
const PUSHED_INTRO = '用户的话里提到了下面这些人或事，系统已按名称检索了长期记忆，结果如下；够用就直接用，不必再用 memory_recall 查同一件事，与问题无关的忽略。'

const WEEKDAYS = '日一二三四五六'

const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)
const pad = (n) => String(n).padStart(2, '0')
const day = (ts) => {
  const date = new Date(ts)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** "2026-10-18（周日）": what the model needs to turn 「下周五」 into a date. */
export function dateLine(date = new Date()) {
  return `${day(date.getTime())}（周${WEEKDAYS[date.getDay()]}）`
}

function profileLines(profile) {
  return PROFILE_FIELDS
    .filter(({ key }) => profile[key]?.value)
    .map(({ key, label }) => `${label}：${clip(profile[key].value.replace(/\n+/g, '；'), FIELD_CHARS)}`)
}

const memoryLine = (memory) => `- （${day(memory.updatedAt ?? memory.createdAt)}）${memory.text}`
const sectionTitle = (title) => `【${title}】`

/** The leading lines that fit in `room` characters (one newline each), so the block keeps its budget. */
function fitting(lines, room) {
  const kept: string[] = []
  let used = 0
  for (const line of lines) {
    if (used + line.length + 1 > room) break
    kept.push(line)
    used += line.length + 1
  }
  return kept
}

const section = (title, lines) => (lines.length ? [sectionTitle(title), ...lines] : [])
const sizeOf = (lines) => lines.reduce((total, line) => total + line.length + 1, 0)

const TAGS_CHARS = `<${CONTEXT_TAG}>`.length + `</${CONTEXT_TAG}>`.length + 2

/**
 * Each part in order of authority, as far as the budget goes: the rules always, then what the user
 * wrote, the synthesis, what was learned since it, and habits. A part goes in only with at least one line.
 */
function fixedLines({ profile, synthesis, recent, habits }) {
  const rules = section('记忆规则', [MEMORY_RULES])
  const parts = [
    section('画像', profileLines(profile)),
    section('助手整理的画像', synthesis ? synthesis.split('\n') : []),
    section('最近了解到的', recent.map(memoryLine)),
    section('使用习惯', habits ? [habits] : []),
  ]
  const { kept } = parts.reduce(({ kept: done, room }, lines) => {
    const fitted = lines.length && sizeOf(lines.slice(0, 2)) <= room ? fitting(lines, room) : []
    return { kept: [...done, ...fitted], room: room - sizeOf(fitted) }
  }, { kept: [] as string[], room: MAX_CONTEXT_CHARS - TAGS_CHARS - FIXED_INTRO.length - 1 - sizeOf(rules) })
  return [FIXED_INTRO, ...rules, ...kept]
}

const pushedLine = ({ memory, names }) => `${memoryLine(memory)}〔${names.join('、')}〕`

/**
 * @param {{
 *   fixed: null | {
 *     profile: Record<string, { value: string }>,
 *     synthesis?: string | null,
 *     recent?: Array<{ text: string, createdAt: number, updatedAt?: number }>,
 *     habits?: string,
 *   },
 *   pushed: Array<{ memory: { text: string, createdAt: number }, names: string[] }>,
 *   today?: string,
 * }} layers today: sent as 【今天】 when given
 * @returns {string} '' when there is nothing to tell
 */
export function buildContext({ fixed, pushed, today = '' }) {
  const lines = [
    ...(today ? section('今天', [today]) : []),
    ...(fixed ? fixedLines({ synthesis: null, recent: [], habits: '', ...fixed }) : []),
    ...(pushed.length ? [PUSHED_INTRO, ...section('相关记忆', pushed.map(pushedLine))] : []),
  ]
  return lines.length ? [`<${CONTEXT_TAG}>`, ...lines, `</${CONTEXT_TAG}>`].join('\n') : ''
}

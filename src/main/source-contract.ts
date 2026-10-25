import { z } from 'zod'

/**
 * The message-source contract (source@1): what a source folder declares in viva-source.json, what it is asked
 * on stdin and what it answers on stdout. A source is a program of any language that the app runs for one
 * answer at a time (source-run.ts); it never reaches the model, its tools or its context. Everything it says is
 * data and is checked here before anything else looks at it. docs/sources.md is the developer's side of this.
 */
export const SOURCE_CONTRACT = 1
export const MANIFEST_FILE = 'viva-source.json'

export const LIMITS = Object.freeze({
  idChars: 200,
  fromChars: 200,
  titleChars: 300,
  textChars: 8000,
  linkChars: 2000,
  levelChars: 20,
  threadChars: 200,
  cursorChars: 4000,
  messagesPerPoll: 200,
  problemChars: 500,
  configFields: 20,
  configValueChars: 4000,
  runParts: 20,
})

const MIN_EVERY_MINUTES = 1
const MAX_EVERY_MINUTES = 24 * 60
export const DEFAULT_EVERY_MINUTES = 5
const SOURCE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/
const FIELD_KEY = /^[A-Za-z][A-Za-z0-9_]{0,39}$/
const LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])
export const SOURCE_KINDS = Object.freeze(['mail', 'alert', 'chat', 'other'] as const)

const title = z.string().trim().min(1).max(40)
const help = z.string().max(200).optional()

const fieldSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('string'), title, help, required: z.boolean().optional(), default: z.string().max(LIMITS.configValueChars).optional() }),
  z.object({ type: z.literal('secret'), title, help, required: z.boolean().optional() }),
  z.object({ type: z.literal('number'), title, help, required: z.boolean().optional(), default: z.number().finite().optional() }),
  z.object({ type: z.literal('boolean'), title, help, default: z.boolean().optional() }),
  z.object({ type: z.literal('enum'), title, help, values: z.array(z.string().min(1).max(100)).min(1).max(50), default: z.string().optional() }),
])

const runSchema = z.array(z.string().min(1).max(1000)).min(1).max(LIMITS.runParts)

const manifestSchema = z.object({
  contract: z.literal(SOURCE_CONTRACT),
  id: z.string().regex(SOURCE_ID, 'id 只能用小写字母、数字和连字符，最多 40 个字符'),
  name: z.string().trim().min(1).max(40),
  kind: z.enum(SOURCE_KINDS),
  run: runSchema,
  /** `run` for one platform instead, where the program is called otherwise (`py` on Windows, `python3` elsewhere). */
  runOn: z.object({ win32: runSchema.optional(), darwin: runSchema.optional(), linux: runSchema.optional() }).optional(),
  reads: z.string().trim().min(1).max(200),
  everyMinutes: z.number().int().min(MIN_EVERY_MINUTES).max(MAX_EVERY_MINUTES).default(DEFAULT_EVERY_MINUTES),
  config: z.record(z.string(), fieldSchema).default({}),
})

export type ConfigField = z.infer<typeof fieldSchema>
export type SourceManifest = z.infer<typeof manifestSchema>
export type ConfigValue = string | number | boolean
export type ConfigValues = Readonly<Record<string, ConfigValue>>

/** What a source hands in, once checked: `at` in ms, optional fields left out when absent. */
export interface SourceMessage {
  id: string
  at: number
  from?: string
  title?: string
  text?: string
  link?: string
  level?: string
  thread?: string
}

export type Checked<K extends string, T> = ({ [key in K]: T } & { problem?: undefined }) | { problem: string }

export const MIN_EVERY = MIN_EVERY_MINUTES
export const MAX_EVERY = MAX_EVERY_MINUTES

/** The first issue zod found, said with where it is. */
function issueText(error: z.ZodError): string {
  const issue = error.issues[0]
  return `${issue.path.length ? `${issue.path.join('.')}：` : ''}${issue.message}`
}

/** A manifest as read from viva-source.json: its contract version first, so a newer one says so plainly. */
export function checkManifest(input: unknown): Checked<'manifest', SourceManifest> {
  const contract = (input as { contract?: unknown } | null)?.contract
  if (typeof contract === 'number' && contract > SOURCE_CONTRACT) {
    return { problem: `需要更新 Viva：这个消息源按第 ${contract} 版约定写成，当前只支持第 ${SOURCE_CONTRACT} 版` }
  }
  const result = manifestSchema.safeParse(input)
  if (!result.success) return { problem: `${MANIFEST_FILE} 不对：${issueText(result.error)}` }
  const manifest = result.data
  if (Object.keys(manifest.config).length > LIMITS.configFields) return { problem: `配置项最多 ${LIMITS.configFields} 个` }
  for (const [key, field] of Object.entries(manifest.config)) {
    if (!FIELD_KEY.test(key)) return { problem: `配置项名只能用英文字母、数字和下划线：${key.slice(0, 40)}` }
    if (field.type === 'enum' && field.default !== undefined && !field.values.includes(field.default)) return { problem: `配置项 ${key} 的默认值不在可选值里` }
  }
  return { manifest }
}

const optionalText = (max: number) => z.string().max(max).optional()

const messageSchema = z.object({
  id: z.string().min(1).max(LIMITS.idChars),
  at: z.union([z.number().finite().nonnegative(), z.string().min(1).max(100)]),
  from: optionalText(LIMITS.fromChars),
  title: optionalText(LIMITS.titleChars),
  text: optionalText(LIMITS.textChars),
  link: optionalText(LIMITS.linkChars),
  level: optionalText(LIMITS.levelChars),
  thread: optionalText(LIMITS.threadChars),
})

function linkProblem(link: string): string | null {
  try {
    return LINK_PROTOCOLS.has(new URL(link).protocol) ? null : 'link 只能是 http、https 或 mailto 链接'
  } catch {
    return 'link 不是有效的链接'
  }
}

/** One message, field by field; its time as ms whether it came as ms or as an ISO date. */
export function checkMessage(input: unknown): Checked<'message', SourceMessage> {
  const result = messageSchema.safeParse(input)
  if (!result.success) return { problem: issueText(result.error) }
  const { at: rawAt, ...rest } = result.data
  const at = typeof rawAt === 'number' ? rawAt : Date.parse(rawAt)
  if (!Number.isFinite(at)) return { problem: 'at：不是有效的时间' }
  if (!rest.title && !rest.text) return { problem: 'title 和 text 至少要有一个' }
  if (rest.link) {
    const problem = linkProblem(rest.link)
    if (problem) return { problem }
  }
  const present = Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined && value !== ''))
  return { message: { ...present, id: rest.id, at } }
}

export interface PollResult {
  cursor: string | null
  messages: SourceMessage[]
  /** Messages that did not fit, each with its id when it had one and why: dropped, and said in settings. */
  dropped: string[]
}

const pollSchema = z.object({
  cursor: z.string().max(LIMITS.cursorChars).nullable(),
  messages: z.array(z.unknown()).max(LIMITS.messagesPerPoll),
})

function droppedLine(raw: unknown, problem: string): string {
  const id = (raw as { id?: unknown } | null)?.id
  return `${typeof id === 'string' && id ? `消息 ${id.slice(0, 60)}` : '一条消息'}：${problem}`
}

/** A poll's answer: a bad cursor or list fails the whole poll; a bad message is dropped and the rest kept. */
export function checkPollResult(input: unknown): Checked<'result', PollResult> {
  const result = pollSchema.safeParse(input)
  if (!result.success) return { problem: `poll 的结果不对：${issueText(result.error)}` }
  const messages: SourceMessage[] = []
  const dropped: string[] = []
  for (const raw of result.data.messages) {
    const checked = checkMessage(raw)
    if (checked.problem === undefined) messages.push(checked.message)
    else dropped.push(droppedLine(raw, checked.problem))
  }
  return { result: { cursor: result.data.cursor, messages, dropped } }
}

const checkSchema = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), problem: z.string().min(1).max(LIMITS.problemChars) }),
])

export type CheckResult = z.infer<typeof checkSchema>

/** A check's answer: ok, or what is wrong in the source's own words. */
export function checkCheckResult(input: unknown): Checked<'result', CheckResult> {
  const result = checkSchema.safeParse(input)
  if (!result.success) return { problem: `check 的结果不对：${issueText(result.error)}` }
  return { result: result.data }
}

/** One value as the field takes it, or why not. */
function valueProblem(field: ConfigField, value: unknown): string | null {
  switch (field.type) {
    case 'string':
    case 'secret':
      return typeof value === 'string' && value.length <= LIMITS.configValueChars ? null : '要填文本'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? null : '要填数字'
    case 'boolean':
      return typeof value === 'boolean' ? null : '要选是或否'
    case 'enum':
      return typeof value === 'string' && field.values.includes(value) ? null : `只能选：${field.values.join('、')}`
  }
}

/** The values of `fields` with defaults filled in: unknown keys refused, each value of its field's type. */
export function checkConfigValues(fields: SourceManifest['config'], values: Readonly<Record<string, unknown>>): Checked<'values', ConfigValues> {
  for (const key of Object.keys(values)) if (!Object.hasOwn(fields, key)) return { problem: `没有这个配置项：${key.slice(0, 40)}` }
  const entries: Array<[string, ConfigValue]> = []
  for (const [key, field] of Object.entries(fields)) {
    const value = values[key] ?? ('default' in field ? field.default : undefined)
    if (value === undefined || value === '') continue
    const problem = valueProblem(field, value)
    if (problem) return { problem: `「${field.title}」${problem}` }
    entries.push([key, value as ConfigValue])
  }
  return { values: Object.fromEntries(entries) }
}

/** Titles of the required fields still without a value: the source cannot be switched on until they are filled. */
export function missingFields(fields: SourceManifest['config'], values: ConfigValues): string[] {
  return Object.entries(fields)
    .filter(([key, field]) => 'required' in field && field.required === true && (values[key] === undefined || values[key] === ''))
    .map(([, field]) => field.title)
}

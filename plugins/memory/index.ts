/**
 * viva-memory: the app's long-term memory as a dsh plugin. Loaded by the app's own dsh profile
 * (src/main/dsh-profile.js) with `config.file` = the memory.db the app's "关于你" page also edits.
 *
 * - Before the first step of each user turn it adds the retrieval layers (lib/layers.js) as one
 *   source-attributed user message: today's date, rules and profile when due, and memories about names
 *   the user mentioned.
 * - It registers the memory tools (lib/tools.js), which the model uses when the user asks it to remember.
 * - After each turn, in the background, a second model call proposes what else to keep (lib/extract.js),
 *   from what the user said, including answers to the agent's questions (ask_user_question);
 *   the store applies it all or nothing, and never over what the user wrote. Then, when it is due
 *   (a day old, or enough has changed), the profile is synthesised again from the valid memories
 *   (lib/synthesize.js). Both reuse the agent's own model route.
 * - It counts compactions in a session projection, so the fixed layer is sent again once dsh has
 *   summarised it away.
 *
 * Swapping the memory design means swapping this plugin; the app only depends on the memory.db contract.
 */
import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
// What dsh adds to the context and the session log: ctx.sessionProjections, the compaction/end event.
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-compaction'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { z as zod } from 'zod'
import { dateLine } from './lib/context.ts'
import { extractTurn } from './lib/extract.ts'
import { contextForTurn } from './lib/inject.ts'
import { ownWords } from './lib/layers.ts'
import { openMemoryDb } from './lib/store.ts'
import type { MemoryDb } from './lib/store.ts'
import { synthesizeProfile } from './lib/synthesize.ts'
import { memoryTools } from './lib/tools.ts'

export const name = 'viva-memory'
export const inject = ['agents', 'tools', 'sessionProjections', 'llm']
export const Config = z.object({ file: z.string(), extract: z.boolean(), synthesize: z.boolean() })

const PROJECTION = 'vivaMemory'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** How many times dsh has compacted the session: the fixed layer goes out again after each. */
    vivaMemory: { compactions: number }
  }
}
/** The work after a turn (extraction, then maybe a synthesis) gives up after this. */
const AFTER_TURN_TIMEOUT_MS = 120_000
const EXTRACT_MAX_TOKENS = 800
const SYNTHESIS_MAX_TOKENS = 1200
const log = (message: string) => process.stderr.write(`[${name}] ${message}\n`)
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** An event of the session log; what each kind carries is dsh's log format, read here as the trace plugin reads it. */
type LoggedEvent = { type: string, data: any }
/** A message as far as its text and who said it are read. */
type Message = { content?: ReadonlyArray<{ type: string, text?: string }>, source?: { kind?: string } }

type MessageSource = Parameters<typeof createUserMessage>[0]['source']
/**
 * This plugin's messages say they come from it (`source.kind`), and dsh keeps that as given; its types list
 * only dsh's own kinds, so the plugin's own one is cast here, in one place.
 */
const ownSource = (source: { kind: string, [field: string]: unknown }) => source as unknown as MessageSource
/** The same for what a model call is for: dsh's types list its own purposes only, and it passes ours through. */
const EXTRACT_PURPOSE = 'memory-extract' as unknown as NonNullable<Parameters<Context['llm']['stream']>[0]['purpose']>

const textOf = (message: Message | undefined) => (message?.content ?? []).filter((part) => part.type === 'text').map((part) => part.text ?? '').join('\n')
const isFromUser = (message: Message | undefined) => message?.source?.kind === 'user'

/** The session's events of `turn`, oldest first (the turn is the latest one). */
function turnEvents(agent: Agent, turn: number): LoggedEvent[] {
  const events: LoggedEvent[] = []
  for (let seq = agent.session.seq - 1; seq >= 0; seq -= 1) {
    const event = agent.session.eventAt(SessionSeq(seq))
    if (event?.type === 'turn/start' && event.data.turn === turn) break
    if (event) events.push(event)
  }
  return events.reverse()
}

/** What the user typed this turn: entered messages from the session log, then the proposed ones. */
function userWords(agent: Agent, turn: number, proposed: readonly Message[]) {
  const entered = turnEvents(agent, turn).filter((event) => event.type === 'user/message').map((event) => event.data)
  return [...entered, ...proposed].filter(isFromUser).map(textOf).join('\n')
}

const ASK_TOOL = 'ask_user_question'

const argumentsOf = (block: { arguments?: unknown }): Record<string, any> => {
  if (typeof block.arguments !== 'string') return block.arguments ?? {}
  try {
    return JSON.parse(block.arguments)
  } catch {
    return {}
  }
}

/** One answer of ask_user_question's result, as the user would say it. */
const saidOf = (answer: { selected?: string[], custom?: string }) => [...(answer.selected ?? []), answer.custom].filter(Boolean).join('、')

/**
 * What the user answered this turn when the agent asked (ask_user_question): each question with its answer.
 * The question is in the agent's tool call, the answer in the tool's result.
 */
function answersOf(agent: Agent, turn: number): Array<{ question: string, answer: string }> {
  const events = turnEvents(agent, turn)
  const asked = new Map<string, Array<{ id: string, question: string }>>(events
    .filter((event) => event.type === 'assistant/message')
    .flatMap((event) => event.data.message?.content ?? [])
    .filter((block: any) => block.type === 'tool-call' && block.name === ASK_TOOL)
    .map((block: any) => [block.id, argumentsOf(block).questions ?? []]))
  return events
    .filter((event) => event.type === 'tool/result' && asked.has(event.data.message?.toolCallId) && !event.data.message.isError)
    .flatMap((event) => {
      // The tool's result, in dsh-tool-ask-user's shape: { answers: [{ id, selected, custom? }] }.
      let result: { answers?: Array<{ id: string, selected?: string[], custom?: string }> }
      try {
        result = JSON.parse(textOf(event.data.message))
      } catch {
        return []
      }
      const questions = asked.get(event.data.message.toolCallId) ?? []
      return (result.answers ?? []).map((answer) => ({
        question: questions.find((item) => item.id === answer.id)?.question ?? '',
        answer: saidOf(answer),
      })).filter((item) => item.answer)
    })
}

/** dsh logs an assistant message as `{ turn, step, message }`, unlike a user message, which is the message itself. */
const replyOf = (agent: Agent, turn: number) => turnEvents(agent, turn)
  .filter((event) => event.type === 'assistant/message')
  .map((event) => textOf(event.data.message))
  .join('\n')

function registerTools(ctx: Context, db: MemoryDb) {
  for (const tool of memoryTools(db)) {
    ctx.tools.register(defineTool({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      // A refusal (a secret, a full store) throws a readable message that dsh hands back to the model.
      execute: async (args) => ({ text: tool.run(args) }),
    }))
  }
}

/** One text-only model call on the agent's own route, for the background pass. */
async function complete(ctx: Context, agent: Agent, { system, input, signal, maxTokens }: {
  system: string, input: string, signal: AbortSignal, maxTokens: number,
}): Promise<string> {
  const { provider, model } = agent.options
  if (!provider || !model) throw new Error('the agent has no model route to reuse')
  const assembler = new BlockAssembler()
  const stream = ctx.llm.stream({
    provider,
    model,
    system,
    messages: [createUserMessage({ content: [{ type: 'text', text: input }], source: ownSource({ kind: name }) })],
    maxTokens,
    sessionId: agent.session.id,
    purpose: EXTRACT_PURPOSE,
    signal,
  })
  for await (const chunk of stream) assembler.push(chunk)
  if (assembler.finish?.kind !== 'stop') throw new Error(`the model stopped with ${assembler.finish?.kind ?? 'nothing'}`)
  return assembler.blocks().filter((block) => block.type === 'text').map((block) => block.text).join('')
}

/**
 * After each turn, in the background and one after the other: extraction, then the profile synthesis
 * when due, so it sees what extraction just wrote. Turns are never held up; unloading aborts the work.
 */
function registerAfterTurn(ctx: Context, db: MemoryDb, enabled: { extract: boolean, synthesize: boolean }) {
  /** The user's own words per session, kept from the turn's first step until the turn stops. */
  const turns = new Map<string, { turn: number, text: string }>()
  const running = new Set<AbortController>()
  ctx.effect(() => () => running.forEach((controller) => controller.abort()), 'memory extraction')

  ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    const sessionId = String(agent.session.id)
    const words = turns.get(sessionId)
    turns.delete(sessionId)
    if (!words || words.turn !== turn) return
    const controller = new AbortController()
    running.add(controller)
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(AFTER_TURN_TIMEOUT_MS)])
    const call = (maxTokens: number) => (system: string, input: string) => complete(ctx, agent, { system, input, signal, maxTokens })
    const extract = () => extractTurn({
      db, userWords: words.text, answers: answersOf(agent, turn), reply: replyOf(agent, turn), today: dateLine(), complete: call(EXTRACT_MAX_TOKENS),
    })
      .catch((err) => log(`background extraction skipped: ${messageOf(err)}`))
    const synthesize = () => synthesizeProfile({ db, complete: call(SYNTHESIS_MAX_TOKENS) })
      .catch((err) => log(`profile synthesis skipped: ${messageOf(err)}`))
    Promise.resolve()
      .then(() => enabled.extract && extract())
      .then(() => enabled.synthesize && !signal.aborted && synthesize())
      .finally(() => running.delete(controller))
  })

  return (sessionId: string, turn: number, question: string) => turns.set(sessionId, { turn, text: ownWords(question) })
}

/** @param config extract / synthesize: the background passes after each turn (each on unless false) */
export function apply(ctx: Context, config: { file: string, extract?: boolean, synthesize?: boolean }) {
  if (!config?.file) throw new Error(`${name}: config.file (the memory.db path) is required`)
  const db = openMemoryDb({ file: config.file })
  ctx.effect(() => () => db.close(), 'memory.db')
  db.markPluginStarted()
  const enabled = { extract: config.extract !== false, synthesize: config.synthesize !== false }
  const noteTurn = enabled.extract || enabled.synthesize ? registerAfterTurn(ctx, db, enabled) : () => {}

  ctx.sessionProjections.register({
    key: PROJECTION,
    stateVersion: 1,
    stateSchema: zod.object({ compactions: zod.number() }),
    init: () => ({ compactions: 0 }),
    apply: (state, event) => (event.type === 'compaction/end' ? { compactions: state.compactions + 1 } : state),
  })

  ctx.on('agent/pre-step', async ({ agent, turn, step, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted || step !== 1) return decision
    // Only turns the user started: subagents and the plugin's own messages get nothing.
    const question = userWords(agent, turn, decision.messages)
    if (!question) return decision
    const sessionId = String(agent.session.id)
    noteTurn(sessionId, turn, question)
    try {
      const text = contextForTurn(db, {
        sessionId,
        turn,
        question,
        epoch: ctx.sessionProjections.stateOf(agent.session, PROJECTION)?.compactions ?? 0,
      })
      if (!text) return decision
      const message = createUserMessage({
        content: [{ type: 'text', text }],
        source: ownSource({ kind: name, form: 'snapshot', sections: [{ name, text }] }),
      })
      return { ...decision, messages: [...decision.messages, message] }
    } catch (err) {
      // Memory must never stop a turn: the question goes on without it.
      log(`could not prepare the context: ${messageOf(err)}`)
      return decision
    }
  }, { prepend: true })

  registerTools(ctx, db)
}

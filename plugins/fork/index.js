/**
 * viva-fork (prototype): a new session from an earlier point of the current one, optionally in another working
 * directory. dsh forks a live session at an exact event (`ctx.sessions.fork`) but keeps the parent's cwd and does
 * not offer forking over ACP; so the app asks here, over its IPC channel, and then resumes the child over ACP.
 * The child is made by dsh's agent factory (which stores it) and let go, so ACP's session/resume finds it as any
 * saved session. Prototype for the "go back" and working-directory designs; see test/fork-plugin.test.js.
 */
import { randomUUID } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import { buildForkSeed } from '@deepseek-ai/dsh-session/fork'
import { createForkChannel, REASONS } from './lib/channel.js'

export const name = 'viva-fork'
export const inject = ['sessions', 'agents']
export const Config = z.object({})

const log = (message) => process.stderr.write(`[${name}] ${message}\n`)
const refuse = (reason, message) => Object.assign(new Error(message), { reason })
const DELIVERY_MARKER = 'session-log-deepseek/delivery-accepted'

/**
 * Storage accepts inherited delivery markers that name another session only in a child (`parentSession`), which
 * ACP will not resume; so the copied markers are made the new session's own. A log-only record, not something
 * the model sees. PROTOTYPE: the real fix is in dsh (resume a seeded top-level session, or fork with a cwd).
 */
const ownMarkers = (events, sourceId, childId) => events.map((event) => (
  event.type === DELIVERY_MARKER && event.data?.sessionId === sourceId ? { ...event, data: { ...event.data, sessionId: childId } } : event))

/**
 * The last event before the `before`-th turn (each turn is one thing the user said, with the context dsh adds to
 * it as further user messages), or the last event; undefined for an empty prefix.
 */
function boundaryOf(events, before) {
  if (before === undefined) return events.at(-1)?.seq
  const turns = events.filter((event) => event.type === 'turn/start')
  if (before > turns.length) throw refuse(REASONS.invalid, `only ${turns.length} turns`)
  const cut = turns[before]
  if (!cut) return events.at(-1)?.seq
  // The user's words reach the agent's inbox just before their turn starts: the cut goes before that too.
  let start = cut.seq
  while (start > 0 && events[start - 1].type === 'agent/inbox/spliced') start -= 1
  return start === 0 ? undefined : start - 1
}

const WORD_EVENTS = new Set(['agent/inbox/spliced', 'user/message'])

/**
 * The turn each of the user's words belongs to: what reaches the inbox just before a turn starts is that turn's,
 * anything else the turn under way's (words said while it works, the context dsh adds).
 * @returns {string[]} per turn, its words' events as JSON
 */
function wordsByTurn(events) {
  const turns = []
  let current = -1
  events.forEach((event, i) => {
    if (event.type === 'turn/start') current += 1
    if (!WORD_EVENTS.has(event.type)) return
    let next = i + 1
    while (events[next]?.type === 'agent/inbox/spliced') next += 1
    const turn = event.type === 'agent/inbox/spliced' && events[next]?.type === 'turn/start' ? current + 1 : current
    if (turn >= 0) turns[turn] = `${turns[turn] ?? ''}${JSON.stringify(event.data)}`
  })
  return turns
}

/** The index of the `occurrence`-th turn from the end in which the user said `words`. */
function turnWithWords(events, words, occurrence) {
  const needle = JSON.stringify(words).slice(1, -1)
  const matches = wordsByTurn(events).flatMap((json, turn) => (json?.includes(needle) ? [turn] : []))
  const turn = matches.at(-1 - occurrence)
  if (turn === undefined) throw refuse(REASONS.invalid, 'no turn with those words')
  return turn
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} _config
 * @param {NodeJS.Process} [port]
 */
export function apply(ctx, _config, port = process) {
  if (typeof port.send !== 'function') {
    log('dsh was not started by the app: nothing to fork for')
    return
  }
  async function fork({ sessionId, before, words, occurrence = 0, cwd }) {
    const source = ctx.sessions.get(sessionId)
    if (!source) throw refuse(REASONS.missing, `no live session ${sessionId}`)
    const events = source.snapshotEvents()
    const boundary = boundaryOf(events, words === undefined ? before : turnWithWords(events, words, occurrence))
    const childId = `fork-${randomUUID()}`
    const seed = boundary === undefined ? [] : ownMarkers(buildForkSeed(events, boundary), source.id, childId)
    // Made by dsh's agent factory, which stores a seeded session as its own fork children are stored, then let go
    // at once: the app resumes it over ACP.
    const handle = await ctx.agents.create({
      sessionId: childId,
      seed,
      inheritedEventCount: boundary === undefined ? 0 : boundary + 1,
      // No parentSession: dsh's ACP front end resumes only top-level sessions, so the app keeps the link itself.
      meta: { cwd: cwd ?? source.header.cwd, isSeeded: boundary !== undefined },
    })
    await ctx.sessions.flush(handle.agent.session)
    await handle.dispose()
    return childId
  }
  const channel = createForkChannel(port, fork, log)
  port.channel?.unref?.()
  ctx.effect(() => () => channel.close(), 'fork channel')
}

import { SessionLogOffset, type Session } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { createRemoteMemoryOwner } from './remote-owner.ts'
import { resolveMemoryProject } from '../../../src/memory/node/project-scope.ts'

type Owner = Pick<ReturnType<typeof createRemoteMemoryOwner>, 'epoch' | 'inEpoch' | 'bindIntakeSession' | 'receiveSource' | 'completeTurn'
  | 'intakeWatermark' | 'advanceIntake'>
type Replay = {
  epoch: string | undefined
  session: Session
  nextSeq: number | null
  turn: number
  step: number
  sources: Set<string>
  assistant: string[]
  project: string | undefined
  work: Promise<void>
}
const textOf = (message: { content: readonly { type: string, text?: string }[] }) =>
  message.content.flatMap(part => part.type === 'text' && typeof part.text === 'string' ? [part.text] : []).join('\n')
const timezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone

export function humanMessages(messages: readonly UserMessage[]) {
  return messages.filter(message => message.source.kind === 'user').map(message => ({ id: message.id, text: textOf(message) }))
}

/** The owner remembers committed turn boundaries. An interrupted scan can replay
 * incomplete work, with the native message ID identifying the same original. */
export function createSessionIngestion(owner: Owner, flush: (session: Session) => Promise<unknown>, requiresAlias: boolean) {
  const sessions = new Map<string, Replay>()

  function enqueue(session: Session, action: (state: Replay) => Promise<void>) {
    let state = sessions.get(session.id)
    if (!state || state.session !== session || state.epoch !== owner.epoch) {
      state = { epoch: owner.epoch, session, nextSeq: null, turn: 0, step: 0, sources: new Set(),
        assistant: [], project: undefined, work: state?.work.catch(() => {}) ?? Promise.resolve() }
      sessions.set(session.id, state)
    }
    const entry = state
    entry.work = entry.work.catch(() => {}).then(() => owner.inEpoch(entry.epoch, () => action(entry)))
    return entry.work
  }

  async function original(state: Replay, message: UserMessage, at: number, live: boolean) {
    if (message.source.kind !== 'user') return
    const resolved = resolveMemoryProject(state.session.header.cwd)
    const project = resolved.status === 'project' ? resolved.project.id : resolved.status
    if (state.project !== project) {
      await owner.bindIntakeSession(String(state.session.id), state.session.header.cwd, state.session.header.origin === 'subagent')
      state.project = project
    }
    const text = textOf(message)
    if (!text.trim() && !message.content.some(part => part.type === 'image' || part.type === 'file')) return
    return owner.receiveSource({ sessionId: String(state.session.id), messageId: message.id, text, at, timezone: timezone(),
      turn: state.turn, step: state.step, live, admitted: true, inherited: false, requiresAlias,
      unknownProject: resolved.status === 'unknown', derived: state.session.header.origin === 'subagent'
        && !('rpcId' in message.source && typeof message.source.rpcId === 'string') })
  }

  async function scan(state: Replay, end: SessionLogOffset, persisted: Promise<unknown>) {
    if (await persisted !== true) return
    const session = String(state.session.id)
    const inherited = state.session.inheritedEventCount
    if (state.nextSeq === null) {
      const { createdAt, nextSeq } = await owner.intakeWatermark(session)
      if (nextSeq === null) {
        const first = state.session.snapshotEvents(inherited, end).find(event => event.time >= createdAt)
        const start = first?.seq ?? end
        await owner.advanceIntake(session, start)
        state.nextSeq = start
      } else state.nextSeq = nextSeq
    }
    const from = Math.max(inherited, state.nextSeq)
    if (from >= end) return
    const events = state.session.snapshotEvents(SessionLogOffset(from), end)
    for (const event of events) {
      if (event.type === 'turn/start') {
        state.turn = event.data.turn
        state.step = 0
        state.sources.clear()
        state.assistant = []
      }
      if (event.type === 'step/start') { state.turn = event.data.turn; state.step = event.data.step }
      if (event.type === 'user/message') {
        const receipt = await original(state, event.data, event.time, false)
        if (receipt && !receipt.handledIntent) state.sources.add(receipt.sourceId)
      }
      if (event.type === 'assistant/message' && !event.data.interrupted) state.assistant.push(textOf(event.data.message))
      if (event.type === 'turn/end') {
        await owner.completeTurn({ sessionId: session, turn: event.data.turn, eventSeq: event.seq,
          sourceIds: [...state.sources], assistant: state.assistant.join('\n'), completed: event.data.reason.kind === 'completed',
          at: event.time, timezone: timezone() })
      }
      state.nextSeq = event.seq + 1
    }
  }

  function synchronize(session: Session, current?: { messages: readonly UserMessage[], turn: number, step: number }) {
    const end = session.seq
    const persisted = flush(session)
    void persisted.catch(() => {})
    return enqueue(session, async state => {
      await scan(state, end, persisted)
      if (!current) return
      state.turn = current.turn
      state.step = current.step
      for (const message of current.messages) await original(state, message, Date.now(), true)
    })
  }
  return {
    synchronize,
    receive(session: Session, messages: readonly UserMessage[], turn: number, step: number) {
      return synchronize(session, { messages, turn, step })
    },
    release(session: Session) {
      if (sessions.get(session.id)?.session === session) sessions.delete(session.id)
    },
    async drain() { await Promise.allSettled([...sessions.values()].map(state => state.work)) },
  }
}

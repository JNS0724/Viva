import { t } from '../shared/i18n/translate.ts'
import type { Conversation, openHistoryDb } from './history-db.ts'
import { ResumeError } from './resume-failure.ts'
import { sessionTiming } from './session-timing.ts'
import type { ConversationContext } from '../shared/conversation-context.ts'

/** The selected session's view; transport-specific fields travel through without being interpreted here. */
export interface ConversationInfo {
  mode: string
  model: string
  cwd: string
  sessionId?: string | null
  resumed?: boolean
  remembersHistory?: boolean
  conversationId?: string
  modelValue?: string
  models?: ReadonlyArray<{ value: string }>
  [field: string]: unknown
}
export interface StartedConversation extends ConversationInfo { sessionId: string | null }
interface ConversationAgent {
  newSession(): Promise<StartedConversation>
  reloadSession(): Promise<StartedConversation>
  setConfig(id: string, value: string): Promise<StartedConversation>
  switchSession(id: string | null, cwd?: string, options?: { exactly?: boolean }): Promise<StartedConversation>
  fork(request: { cwd?: string, words?: string, occurrence?: number }): Promise<
    { ok: true, info: StartedConversation } | { ok: false, reason: string }
  >
}
type History = Pick<ReturnType<typeof openHistoryDb>, 'get' | 'create' | 'latest'>

/** Owns the selected segment, directory, carried records and session transitions, never the dsh process. */
export function createConversationSession({ history, agent, info, setInfo, isBusy, folderExists, selectedModel, changed }: {
  history: () => History
  agent: () => ConversationAgent | null
  info: () => ConversationInfo
  setInfo: (info: ConversationInfo) => void
  isBusy: () => boolean
  folderExists: (dir: string) => boolean
  selectedModel: () => string | null
  changed: () => void
}) {
  let selected: Conversation | null = null
  let directory: string | null = null, defaultDirectory: string | null = null
  let carry: { conversationId: string, text: string } | null = null
  let changing = false, uncommitted = false, newTopicPending: Promise<ConversationInfo> | null = null
  let selectionToken = {}

  const current = (): Conversation => {
    if (!selected) throw new Error('conversation session has not been opened')
    return selected
  }
  const cwd = () => directory ?? defaultDirectory
  const preparing = () => new Error(t('main.main.preparing.a.new.topic.please.wait'))
  const unavailable = () => new Error(t('main.main.the.assistant.is.not.connected.yet'))
  function requireIdle() {
    if (isBusy()) throw new Error(t('main.main.wait.for.this.turn.to.finish.before.2'))
  }
  const requireCurrent = (runtime: ConversationAgent, token: object) => { if (agent() !== runtime || selectionToken !== token) throw unavailable() }
  async function transition<T>(work: () => Promise<T>): Promise<T> {
    if (changing) throw preparing()
    changing = true
    try { return await work() } finally { changing = false; changed() }
  }

  function open(defaultCwd: string) {
    selectionToken = {}
    defaultDirectory = defaultCwd
    selected = history().latest()?.conversation ?? history().create({ cwd: defaultCwd })
  }
  /** Stores may replace the object while saving; the identity is still its id/sessionId. */
  function select(next: Conversation) { selected = next; changed() }
  function commitSelection(next: Conversation) { selected = next; setInfo({ ...info(), conversationId: next.id }); uncommitted = false; changed() }
  function reset() {
    if (agent()) throw new Error('stop the runtime before resetting the selected conversation')
    selectionToken = {}
    selected = history().create({ cwd: cwd() }); uncommitted = false
    setInfo({ ...info(), sessionId: null, conversationId: selected.id })
  }
  function startingIn(fallback: string) {
    const saved = current()
    directory = saved.cwd && folderExists(saved.cwd) ? saved.cwd : fallback
    return { cwd: directory, resumeSessionId: saved.sessionId }
  }
  function ready(started: StartedConversation, dir: string) {
    selectionToken = {}
    const remembersHistory = started.resumed || !history().get(current().id)
    directory = dir
    selected = { ...current(), sessionId: started.sessionId, cwd: dir }
    uncommitted = false
    return { ...started, remembersHistory, conversationId: selected.id }
  }

  function newTopic(): Promise<ConversationInfo> {
    if (newTopicPending) return newTopicPending
    requireIdle()
    const measure = sessionTiming()
    newTopicPending = transition(() => measure('new-topic.total', async () => {
      const runtime = agent(), token = selectionToken
      if (!runtime) { reset(); return info() }
      // Acquisition may already have changed the runtime even if later model matching fails.
      // Retain the gate until a retry or an explicit selection commits a matching segment.
      uncommitted = true
      const opened = await runtime.newSession()
      requireCurrent(runtime, token)
      const started = await measure('new-topic.model', async () => {
        const picked = selectedModel()
        if (!picked || opened.modelValue === picked || !opened.models?.some(model => model.value === picked)) return opened
        return { ...opened, ...await runtime.setConfig('model', picked) }
      })
      requireCurrent(runtime, token)
      selected = history().create({ sessionId: started.sessionId, cwd: cwd() })
      const next = { ...started, remembersHistory: true, conversationId: selected.id }
      setInfo(next)
      uncommitted = false
      return next
    })).finally(() => { newTopicPending = null })
    return newTopicPending
  }

  /** Exactly resumes first, then commits the directory; a failed resume keeps the selected segment. */
  async function switchAgent(id: string | null, targetCwd?: string | null, { exactly = false } = {}): Promise<StartedConversation> {
    if (exactly && !(targetCwd && folderExists(targetCwd))) throw new ResumeError('missing-dir', t('resume.missing.directory', { cwd: targetCwd ?? t('resume.folder.unrecorded') }))
    const runtime = agent(), token = selectionToken
    if (exactly && !runtime) throw new ResumeError('unavailable', unavailable().message)
    const target = targetCwd && folderExists(targetCwd) ? targetCwd : cwd()
    if (!runtime) {
      directory = target
      uncommitted = true
      return { ...info(), sessionId: id, cwd: target ?? info().cwd, resumed: false }
    }
    const previousUncommitted = uncommitted
    uncommitted = true
    try {
      const started = await runtime.switchSession(id, target ?? undefined, { exactly })
      requireCurrent(runtime, token)
      directory = target
      setInfo({ ...started, remembersHistory: started.resumed })
      return started
    } catch (error) {
      if (agent() === runtime && selectionToken === token && error instanceof ResumeError && error.info) {
        setInfo({ ...info(), ...error.info, remembersHistory: Boolean(error.info.resumed) })
        if (error.info.sessionId && error.info.sessionId !== current().sessionId) selected = { ...current(), sessionId: error.info.sessionId }
        uncommitted = false
      } else if (agent() === runtime && selectionToken === token && error instanceof ResumeError) {
        // Exact resume failures leave the original runtime session untouched.
        uncommitted = previousUncommitted
      }
      throw error
    }
  }

  function switchDirectory(dir: string) {
    requireIdle()
    if (uncommitted) throw preparing()
    return transition(async () => {
      const previous = current(), stored = Boolean(history().get(previous.id)), runtime = agent(), token = selectionToken
      if (!runtime) {
        directory = dir
        selected = history().create({ cwd: dir, parentId: stored ? previous.id : null })
        uncommitted = false
        const view = { ...info(), cwd: dir, conversationId: selected.id }
        setInfo(view)
        return view
      }
      const previousUncommitted = uncommitted
      uncommitted = true
      const forked = await runtime.fork({ cwd: dir })
      requireCurrent(runtime, token)
      if (!forked.ok) {
        uncommitted = previousUncommitted
        const problem = forked.reason === 'unavailable' ? t('main.main.this.assistant.version.cannot.change.working.directories')
          : forked.reason === 'missing' ? t('main.main.this.conversation.has.ended.try.again.later')
            : t('main.main.could.not.change.working.directory', { reason: forked.reason })
        throw new Error(problem)
      }
      directory = dir
      const next = { ...forked.info, remembersHistory: true }
      selected = history().create({ sessionId: next.sessionId, mode: next.mode, model: next.model, cwd: dir, parentId: stored ? previous.id : null })
      const view = { ...next, conversationId: selected.id }
      setInfo(view)
      uncommitted = false
      return view
    })
  }

  async function forkBack(request: { words: string, occurrence: number }) {
    if (uncommitted) throw preparing()
    const runtime = agent(), token = selectionToken
    if (!runtime) return { ok: false as const, reason: 'unavailable' }
    const previousUncommitted = uncommitted
    uncommitted = true
    const forked = await runtime.fork(request)
    requireCurrent(runtime, token)
    if (forked.ok) { setInfo({ ...forked.info, remembersHistory: true }); uncommitted = true }
    else uncommitted = previousUncommitted
    return forked
  }

  async function reloadAgent() {
    const runtime = agent(), token = selectionToken
    if (!runtime) throw unavailable()
    uncommitted = true
    const started = await runtime.reloadSession()
    requireCurrent(runtime, token)
    selected = { ...current(), sessionId: started.sessionId }
    const view = { ...started, conversationId: selected.id, remembersHistory: Boolean(started.resumed || !history().get(selected.id)) }
    setInfo(view)
    uncommitted = false
    return view
  }

  /** Hold admission through the caller's history/rewind writes and select(), including same-session segments. */
  function withSelection<T>(work: (ops: { switchAgent: typeof switchAgent, forkAgent: typeof forkBack, reloadAgent: typeof reloadAgent, select: typeof commitSelection }) => Promise<T>): Promise<T> {
    requireIdle()
    return transition(async () => {
      const runtime = agent(), token = selectionToken
      let active = true
      const check = () => { if (!active || agent() !== runtime || selectionToken !== token) throw unavailable() }
      try {
        const result = await work({
          switchAgent: (...args) => { check(); return switchAgent(...args) },
          forkAgent: request => { check(); return forkBack(request) },
          reloadAgent: () => { check(); return reloadAgent() },
          select: next => { check(); commitSelection(next) },
        })
        check()
        return result
      } finally { active = false }
    })
  }

  return {
    open, current, select, reset, cwd, startingIn, ready, newTopic, switchDirectory, withSelection,
    isChanging: () => changing || uncommitted,
    context: (): ConversationContext => ({ conversationId: current().id, sessionId: current().sessionId }),
    carryNext: (conversationId: string, text: string) => { carry = { conversationId, text } },
    takeCarried: () => {
      const text = carry?.conversationId === current().id ? carry.text : null
      carry = null
      return text
    },
  }
}

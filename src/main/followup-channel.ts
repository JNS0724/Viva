import { t } from '../shared/i18n/translate.ts'
/**
 * The app's side of the followups contract (plugins/followups/lib/channel.ts), held by acp-bridge.ts: proposals
 * the model makes in a conversation go to the window as `followup_propose` events, checked first; background
 * preparation asks the plugin for one model call with no tools and waits for its text. Everything from the
 * plugin is checked here: it is what a model wrote.
 */
const MAX_ID_CHARS = 100
const MAX_TITLE_CHARS = 60
const MAX_ASK_CHARS = 2000
const MAX_TIME_CHARS = 60
const MAX_FILES = 5
const MAX_PATH_CHARS = 1000
const MAX_TEXT_CHARS = 40_000
const MAX_PROBLEM_CHARS = 500
/** Longer than the plugin's own limit, so its answer comes first when it can. */
export const PREPARE_TIMEOUT_MS = 4 * 60 * 1000

/** What the model proposed, as the card shows it; times as the model wrote them, checked when accepted. */
export interface ProposalView { title: string, ask: string, remindAt: string | null, prepareBy: string | null, files: string[], watchFile: string | null }
export interface PrepareCall { provider: string, model: string, system: string, input: string, maxTokens: number, requireComplete?: boolean }
/** `called: false`: no model was asked (the agent down, no model, stopped before sending); it costs no call. */
export type Prepared = { ok: true, text: string } | { ok: false, problem: string, called?: false }

const text = (value: unknown, max: number): string | null => (typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : null)

/** A proposal from the plugin, its fields checked; null when it is not one worth a card. */
export function proposalOf(raw: any): ProposalView | null {
  const title = text(raw?.title, MAX_TITLE_CHARS)
  const ask = text(raw?.ask, MAX_ASK_CHARS)
  if (!title || !ask) return null
  const remindAt = text(raw?.remindAt, MAX_TIME_CHARS)
  const prepareBy = text(raw?.prepareBy, MAX_TIME_CHARS)
  const watchFile = text(raw?.watchFile, MAX_PATH_CHARS)
  if (!remindAt && !prepareBy && !watchFile) return null
  const files = Array.isArray(raw?.files)
    ? raw.files.map((file: unknown) => text(file, MAX_PATH_CHARS)).filter((file: string | null): file is string => file !== null).slice(0, MAX_FILES)
    : []
  return { title, ask, remindAt, prepareBy, files, watchFile }
}

type Emit = (event: { type: string, [field: string]: unknown }) => void
type Timer = ReturnType<typeof setTimeout>

export function createFollowupDesk({ send, emit, setTimer = setTimeout, clearTimer = clearTimeout }: {
  send: (message: object) => void
  emit: Emit
  setTimer?: (fn: () => void, ms: number) => Timer
  clearTimer?: (timer: Timer) => void
}) {
  const waiting = new Map<string, { resolve: (result: Prepared) => void, timer: Timer }>()
  let seq = 0

  function settle(id: string, result: Prepared) {
    const entry = waiting.get(id)
    if (!entry) return
    waiting.delete(id)
    clearTimer(entry.timer)
    entry.resolve(result)
  }

  function receive(message: any) {
    if (message?.type === 'followup_propose') {
      const proposal = proposalOf(message.proposal)
      const id = text(message.id, MAX_ID_CHARS)
      if (proposal && id) emit({ type: 'followup_propose', proposalId: id, sessionId: String(message.sessionId ?? ''), proposal })
      return
    }
    if (message?.type !== 'prepare_result') return
    const id = String(message.id ?? '')
    if (typeof message.ok !== 'boolean' || typeof message.text !== 'string') return settle(id, { ok: false, problem: t("main.followup-channel.preparation.result.is.incomplete") })
    settle(id, message.ok ? { ok: true, text: message.text.slice(0, MAX_TEXT_CHARS) } : { ok: false, problem: message.text.slice(0, MAX_PROBLEM_CHARS) })
  }

  /** One model call with no tools; `signal` stops it (the user came back). */
  function prepare(call: PrepareCall, signal?: AbortSignal): Promise<Prepared> {
    const id = `prep${++seq}-${Date.now().toString(36)}`
    return new Promise<Prepared>((resolve) => {
      if (signal?.aborted) return resolve({ ok: false, problem: t("main.followup-channel.stopped.for.now"), called: false })
      const stop = (problem: string) => {
        send({ type: 'prepare_cancel', id })
        settle(id, { ok: false, problem })
      }
      const timer = setTimer(() => stop(t("main.followup-channel.preparation.timed.out")), PREPARE_TIMEOUT_MS)
      waiting.set(id, { resolve, timer })
      signal?.addEventListener('abort', () => stop(t("main.followup-channel.stopped.for.now")), { once: true })
      send({ type: 'prepare', id, ...call })
    })
  }

  /** dsh is going away: nothing will answer what still waits. */
  function close() {
    for (const id of [...waiting.keys()]) settle(id, { ok: false, problem: t("main.followup-channel.assistant.disconnected.preparation.will.retry.later") })
  }

  return { receive, prepare, close }
}

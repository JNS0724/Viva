import { t } from '../shared/i18n/translate.ts'
import { MAX_MESSAGE_CHARS, MESSAGE_TOO_LONG } from '../shared/text-limits.ts'
import type { QuestionAnswer } from '../shared/question-answer.ts'
import { isBusy } from './state.ts'
import { setupView } from './selectors.ts'
import { sameContext, type ConversationContext } from '../shared/conversation-context.ts'

/** Conversation effects; the page supplies state and UI callbacks, never a document or the app entry. */
type ConversationDeps = Pick<ActionDeps, 'getState' | 'dispatch' | 'errorMessage' | 'showToast'> & {
  api: Pick<AgentApi, 'prompt' | 'steer' | 'answerQuestion' | 'provideSecrets'>
  beforePrompt: () => void
  keepPicture: (id: string) => void
  now?: () => number
}

export function createConversationActions({ api, getState, dispatch, errorMessage, showToast, beforePrompt, keepPicture, now = Date.now }: ConversationDeps) {
  const steerLost = () => t("app.your.message.did.not.reach.the.assistant")
  const context = (): ConversationContext => ({ conversationId: getState().conversationId ?? getState().info.conversationId ?? null, sessionId: getState().info.sessionId ?? null })
  const belongsHere = (origin: ConversationContext) => sameContext(origin, context())
  const selectionPending = () => getState().newTopicPending || getState().switching || getState().workDir.switching || getState().rewind.busy || getState().settings.busy
  const canReply = (origin: ConversationContext, epoch: number) => belongsHere(origin) && epoch === sendEpoch
    && !selectionPending()
  const promptFailed = (origin: ConversationContext, epoch: number) => (error: unknown) => {
    if (canReply(origin, epoch)) dispatch({ type: 'error', message: errorMessage(error) })
  }
  /**
   * Sends `text` as the user's next question, or, while the agent works, into the turn it is on;
   * `via: 'island'` when it was asked on the desktop island; `images`: pictures pasted with it, which go only
   * as a new question (not into a running turn).
   * @returns {boolean} false when the agent can't take it now
   */
  function ask(text: string, { via = null as string | null, images = [] as Array<{ id: string }>, sourceId, newSource = false, feedItemId, admitted }: {
    via?: string | null, images?: Array<{ id: string }>, sourceId?: string, newSource?: boolean, feedItemId?: string,
    admitted?: (accepted: boolean, problem?: string) => void,
  } = {}): boolean {
    if (text.length > MAX_MESSAGE_CHARS) {
      showToast(MESSAGE_TOO_LONG)
      return false
    }
    if ((!text && !images.length) || setupView(getState().info) || selectionPending()) return false
    if (feedItemId && getState().feed.erasedIds.includes(feedItemId)) return false
    if (feedItemId && isBusy(getState())) {
      showToast(t('feed.continue.wait'))
      return false
    }
    if (feedItemId) return sendNewPrompt(text, images, via, { id: feedItemId, admitted })
    if (images.length) return askWithImages(text, images, via)
    if (isBusy(getState())) return sourceId && !newSource ? false : steer(text, via, sourceId)
    const origin = context(), epoch = ++sendEpoch
    beforePrompt()
    const operation = sourceId ?? globalThis.crypto.randomUUID()
    dispatch({ type: 'user_prompt', text, at: now(), via, sourceId: operation })
    api.prompt(text, undefined, sourceId && !newSource ? [sourceId] : operation).catch(promptFailed(origin, epoch))
    return true
  }

  /** A question with pictures: only as the next question of the conversation on screen. */
  function askWithImages(text: string, images: Array<{ id: string }>, via: string | null) {
    if (isBusy(getState())) {
      showToast(t("app.the.assistant.is.working.send.images.after"))
      return false
    }
    return sendNewPrompt(text, images, via)
  }

  function sendNewPrompt(text: string, images: Array<{ id: string }>, via: string | null,
    feed?: { id: string, admitted?: (accepted: boolean, problem?: string) => void }) {
    beforePrompt()
    const origin = context(), epoch = ++sendEpoch
    // Kept just now (here, or on the desktop island): shown even if the folder was emptied earlier.
    for (const { id } of images) keepPicture(id)
    const operation = globalThis.crypto.randomUUID()
    dispatch({ type: 'user_prompt', text, at: now(), via, images, sourceId: operation, pending: Boolean(feed), ...(feed ? { feedItemId: feed.id } : {}) })
    if (feed) {
      // The same conversation can replace its DSH session before a send. Resolve the message by its operation.
      const pendingHere = () => getState().messages.some(message => message.pending && message.sourceId === operation)
      api.prompt(text, images, operation, feed.id).then(() => {
        const accepted = !getState().feed.erasedIds.includes(feed.id)
        if (pendingHere()) dispatch({ type: 'prompt_admitted', sourceId: operation, accepted })
        feed.admitted?.(accepted)
      }, error => {
        const message = errorMessage(error)
        if (pendingHere()) {
          dispatch({ type: 'prompt_admitted', sourceId: operation, accepted: false })
          if (epoch === sendEpoch && !selectionPending()) dispatch({ type: 'error', message })
        }
        feed.admitted?.(false, message)
      })
    } else api.prompt(text, images, operation).catch(promptFailed(origin, epoch))
    return true
  }

  /** Words said as a turn was ending: sent as the next question once it has ended. */
  let afterTurn: Array<{ text: string, id: string | undefined, operation: string, origin: ConversationContext, epoch: number }> = []
  let sendEpoch = 0

  function clearAfterTurn() {
    sendEpoch++
    for (const { id, origin } of afterTurn) if (belongsHere(origin)) dispatch({ type: 'steer_failed', id })
    afterTurn = []
  }

  /**
   * Said while the agent works: into the running turn, which reads it at its next step (the viva-steer plugin).
   * Should that turn have just ended, the words go as the next question; should they not get through at all,
   * they stay in the thread marked as not sent.
   */
  function steer(text: string, via: string | null, operation: string = globalThis.crypto.randomUUID()) {
    dispatch({ type: 'user_steer', text, via, sourceId: operation })
    // The words just said, the last message now (user_steer above).
    const id = getState().messages.at(-1)?.id
    const epoch = sendEpoch, origin = context()
    api.steer(text, operation)
      .then((result) => {
        if (result.ok) return
        if (!canReply(origin, epoch)) throw new Error(steerLost())
        if (result.reason !== 'idle') throw new Error(steerLost())
        if (isBusy(getState())) afterTurn = [...afterTurn, { text, id, operation, origin, epoch }]
        else resend(text, [operation])
      })
      .catch((err) => {
        if (!belongsHere(origin)) return
        dispatch({ type: 'steer_failed', id })
        if (canReply(origin, sendEpoch)) showToast(errorMessage(err) || steerLost())
      })
    return true
  }

  function resend(text: string, operation: string[]) {
    const origin = context(), epoch = ++sendEpoch
    dispatch({ type: 'steer_resent', at: now() })
    api.prompt(text, undefined, operation).catch(promptFailed(origin, epoch))
  }

  function sendAfterTurn(stopReason?: string) {
    // A cancelled turn may be retiring its dsh instance. Neither queued words nor a late idle
    // receipt may start another prompt against that instance or its replacement.
    if (stopReason === 'cancelled') return clearAfterTurn()
    if (!afterTurn.length) return
    const pending = afterTurn.filter(item => canReply(item.origin, item.epoch))
    const text = pending.map(item => item.text).join('\n\n')
    afterTurn = []
    if (text) resend(text, pending.map(item => item.operation))
  }

  /** What the user answers to each question: the options picked, and words of their own. */
  type Answers = QuestionAnswer[]

  /** The backend publishes the reply once the question and its answer are still valid. */
  function answer(answers: Answers) {
    const question = getState().question
    if (!question) return
    const origin = context(), epoch = sendEpoch
    const operation = globalThis.crypto.randomUUID()
    api.answerQuestion(question.questionId, answers, operation)
      .then((accepted) => accepted || (canReply(origin, epoch) && showToast(t("app.this.question.has.ended.your.answer.was"))))
      .catch(promptFailed(origin, epoch))
  }

  async function provideSecrets(values: Record<string, string> | null) {
    const secret = getState().secret
    if (!secret) return
    const origin = context(), epoch = sendEpoch
    try {
      const accepted = await api.provideSecrets(secret.requestId, values)
      if (!canReply(origin, epoch)) return
      if (!accepted) showToast(t("app.this.connection.request.has.ended"))
      dispatch({ type: 'secret_resolved', requestId: secret.requestId, provided: values !== null, at: now() })
    } catch (err) {
      if (canReply(origin, epoch)) showToast(errorMessage(err))
    }
  }

  return { ask, answer, provideSecrets, sendAfterTurn, clearAfterTurn }
}

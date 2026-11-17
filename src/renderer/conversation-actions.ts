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
  const promptFinished = (origin: ConversationContext, epoch: number, sources: readonly string[]) =>
    (result: Awaited<ReturnType<AgentApi['prompt']>>) => {
      if (result?.accepted !== false) return
      // Only the backend's negative admission receipt proves these words never
      // reached native dispatch. Keep the marker when a report clears the error.
      for (const message of getState().messages) if (message.sourceId && sources.includes(message.sourceId) && result.sourceIds.includes(message.sourceId)) {
        dispatch({ type: 'steer_failed', id: message.id })
      }
      promptFailed(origin, epoch)(new Error(result.message))
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
    api.prompt(text, undefined, sourceId && !newSource ? [sourceId] : operation)
      .then(promptFinished(origin, epoch, [operation]), promptFailed(origin, epoch))
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
      const refused = (message: string) => {
        if (pendingHere()) {
          dispatch({ type: 'prompt_admitted', sourceId: operation, accepted: false })
          if (epoch === sendEpoch && !selectionPending()) dispatch({ type: 'error', message })
        }
        feed.admitted?.(false, message)
      }
      api.prompt(text, images, operation, feed.id).then(result => {
        if (result?.accepted === false) { refused(result.message); return }
        const accepted = !getState().feed.erasedIds.includes(feed.id)
        if (pendingHere()) dispatch({ type: 'prompt_admitted', sourceId: operation, accepted })
        feed.admitted?.(accepted)
      }, error => refused(errorMessage(error)))
    } else api.prompt(text, images, operation)
      .then(promptFinished(origin, epoch, [operation]), promptFailed(origin, epoch))
    return true
  }

  /** Words said as a turn was ending: sent as the next question once it has ended. */
  let afterTurn: Array<{ text: string, id: string | undefined, operation: string, origin: ConversationContext, epoch: number, firstDelivery: boolean }> = []
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
    let delivery: 'pending' | 'not-sent' | 'sent' = 'pending'
    api.steer(text, operation)
      .then((result) => {
        delivery = result.delivery ?? (result.ok ? 'sent' : result.reason === 'idle' ? 'not-sent' : 'pending')
        if (result.ok) { dispatch({ type: 'steer_delivery', sourceId: operation, delivery }); return }
        if (!canReply(origin, epoch)) throw new Error(steerLost())
        if (result.reason !== 'idle') throw new Error(result.message || steerLost())
        // An explicit host not-sent receipt authorizes the original alias's
        // first native delivery; accepted sources retain canonical replay.
        const firstDelivery = result.delivery === 'not-sent'
        if (isBusy(getState())) afterTurn = [...afterTurn, { text, id, operation, origin, epoch, firstDelivery }]
        else resend(text, firstDelivery ? operation : [operation])
      })
      .catch((err) => {
        const retained = getState().messages.find(message => message.sourceId === operation)
        if (retained) dispatch({ type: 'steer_delivery', sourceId: operation, delivery })
        if (!belongsHere(origin)) return
        if (canReply(origin, sendEpoch)) showToast(delivery === 'pending' ? t('app.message.delivery.unknown') : errorMessage(err) || steerLost())
      })
    return true
  }

  function resend(text: string, operation: string | string[], origin = context(), epoch = ++sendEpoch) {
    dispatch({ type: 'steer_resent', at: now() })
    if (typeof operation === 'string') dispatch({ type: 'steer_delivery', sourceId: operation, delivery: 'pending' })
    api.prompt(text, undefined, operation)
      .then(result => {
        const sources = typeof operation === 'string' ? [operation] : operation
        promptFinished(origin, epoch, sources)(result)
        if (result?.accepted !== false && typeof operation === 'string') dispatch({ type: 'steer_delivery', sourceId: operation, delivery: 'sent' })
      }, promptFailed(origin, epoch))
  }

  function sendAfterTurn(stopReason?: string) {
    // A cancelled turn may be retiring its dsh instance. Neither queued words nor a late idle
    // receipt may start another prompt against that instance or its replacement.
    if (stopReason === 'cancelled') return clearAfterTurn()
    if (!afterTurn.length) return
    const pending = afterTurn.filter(item => canReply(item.origin, item.epoch))
    afterTurn = []
    if (!pending.length) return
    const origin = context(), epoch = ++sendEpoch
    // Register every following question before returning control to new input.
    // The backend retains their FIFO position until each native turn settles.
    for (let index = 0; index < pending.length;) {
      const next = pending[index]!
      if (next.firstDelivery) {
        resend(next.text, next.operation, origin, epoch)
        index++
      } else {
        const end = pending.findIndex((item, at) => at > index && item.firstDelivery)
        const group = pending.slice(index, end < 0 ? pending.length : end)
        resend(group.map(item => item.text).join('\n\n'), group.map(item => item.operation), origin, epoch)
        index += group.length
      }
    }
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

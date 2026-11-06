import { t } from '../shared/i18n/translate.ts'
import { MAX_MESSAGE_CHARS, MESSAGE_TOO_LONG } from '../shared/text-limits.ts'
import type { QuestionAnswer } from '../shared/question-answer.ts'
import { isBusy } from './state.ts'
import { setupView } from './selectors.ts'

/** Conversation effects; the page supplies state and UI callbacks, never a document or the app entry. */
type ConversationDeps = Pick<ActionDeps, 'getState' | 'dispatch' | 'errorMessage' | 'showToast'> & {
  api: Pick<AgentApi, 'prompt' | 'steer' | 'answerQuestion' | 'provideSecrets'>
  beforePrompt: () => void
  keepPicture: (id: string) => void
  now?: () => number
}

export function createConversationActions({ api, getState, dispatch, errorMessage, showToast, beforePrompt, keepPicture, now = Date.now }: ConversationDeps) {
  const steerLost = () => t("app.your.message.did.not.reach.the.assistant")
  /**
   * Sends `text` as the user's next question, or, while the agent works, into the turn it is on;
   * `via: 'island'` when it was asked on the desktop island; `images`: pictures pasted with it, which go only
   * as a new question (not into a running turn).
   * @returns {boolean} false when the agent can't take it now
   */
  function ask(text: string, { via = null as string | null, images = [] as Array<{ id: string }> } = {}): boolean {
    if (text.length > MAX_MESSAGE_CHARS) {
      showToast(MESSAGE_TOO_LONG)
      return false
    }
    if ((!text && !images.length) || setupView(getState().info) || getState().switching || getState().newTopicPending) return false
    if (images.length) return askWithImages(text, images, via)
    if (isBusy(getState())) return steer(text, via)
    beforePrompt()
    dispatch({ type: 'user_prompt', text, at: now(), via })
    api.prompt(text).catch((err) => dispatch({ type: 'error', message: errorMessage(err) }))
    return true
  }

  /** A question with pictures: only as the next question of the conversation on screen. */
  function askWithImages(text: string, images: Array<{ id: string }>, via: string | null) {
    if (isBusy(getState())) {
      showToast(t("app.the.assistant.is.working.send.images.after"))
      return false
    }
    beforePrompt()
    // Kept just now (here, or on the desktop island): shown even if the folder was emptied earlier.
    for (const { id } of images) keepPicture(id)
    dispatch({ type: 'user_prompt', text, at: now(), via, images })
    api.prompt(text, images).catch((err) => dispatch({ type: 'error', message: errorMessage(err) }))
    return true
  }

  /** Words said as a turn was ending: sent as the next question once it has ended. */
  let afterTurn: string[] = []

  /**
   * Said while the agent works: into the running turn, which reads it at its next step (the viva-steer plugin).
   * Should that turn have just ended, the words go as the next question; should they not get through at all,
   * they stay in the thread marked as not sent.
   */
  function steer(text: string, via: string | null) {
    dispatch({ type: 'user_steer', text, via })
    // The words just said, the last message now (user_steer above).
    const id = getState().messages.at(-1)?.id
    api.steer(text)
      .then((result) => {
        if (result.ok) return
        if (result.reason !== 'idle') throw new Error(steerLost())
        if (isBusy(getState())) afterTurn = [...afterTurn, text]
        else resend(text)
      })
      .catch((err) => {
        dispatch({ type: 'steer_failed', id })
        showToast(errorMessage(err) || steerLost())
      })
    return true
  }

  function resend(text: string) {
    dispatch({ type: 'steer_resent', at: now() })
    api.prompt(text).catch((err) => dispatch({ type: 'error', message: errorMessage(err) }))
  }

  function sendAfterTurn() {
    if (!afterTurn.length) return
    const text = afterTurn.join('\n\n')
    afterTurn = []
    resend(text)
  }

  /** What the user answers to each question: the options picked, and words of their own. */
  type Answers = QuestionAnswer[]

  /** Answers the agent's open question; the reply shows at once, like an approval. */
  function answer(answers: Answers) {
    const question = getState().question
    if (!question) return
    dispatch({ type: 'question_answered', questionId: question.questionId, answers, at: now() })
    api.answerQuestion(question.questionId, answers)
      .then((accepted) => accepted || showToast(t("app.this.question.has.ended.your.answer.was")))
      .catch((err) => dispatch({ type: 'error', message: errorMessage(err) }))
  }

  async function provideSecrets(values: Record<string, string> | null) {
    const secret = getState().secret
    if (!secret) return
    try {
      const accepted = await api.provideSecrets(secret.requestId, values)
      if (!accepted) showToast(t("app.this.connection.request.has.ended"))
      dispatch({ type: 'secret_resolved', requestId: secret.requestId, provided: values !== null, at: now() })
    } catch (err) {
      showToast(errorMessage(err))
    }
  }

  return { ask, answer, provideSecrets, sendAfterTurn, clearAfterTurn: () => { afterTurn = [] } }
}

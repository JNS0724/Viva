import { matchesFeedContinuation } from '../shared/feed-continuation.ts'
import { t } from '../shared/i18n/translate.ts'
import type { FeedStore } from './feed-store.ts'

type Continuation = NonNullable<ReturnType<FeedStore['continuation']>> & { current(): boolean }

/** Validate the current draft and keep its delivery bound to the selected recipient. */
export async function admitFeedContinuation({ text, read, current }: {
  text: string
  read(): Promise<Continuation>
  current(): boolean
}) {
  const unavailable = () => new Error(t('main.feed.memory.unavailable'))
  if (!current()) throw unavailable()
  const continuation = await read()
  const held = () => current() && continuation.current()
  if (!held()) throw unavailable()
  if (!matchesFeedContinuation(continuation.item, text)) throw new Error(t('main.feed.edit.continuation'))
  return held
}

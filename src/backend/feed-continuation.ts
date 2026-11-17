import { matchesFeedContinuation } from '../shared/feed-continuation.ts'
import { t } from '../shared/i18n/translate.ts'
import type { FeedStore } from './feed-store.ts'

type Continuation = NonNullable<ReturnType<FeedStore['continuation']>> & { current(): boolean }

/** A continuation's evidence and delivery must reach the same selected recipient. */
export async function admitFeedContinuation({ text, read, current, transfer, record }: {
  text: string
  read(): Promise<Continuation>
  current(): boolean
  transfer(memory: Continuation['memory']): Promise<boolean>
  record(): Promise<void>
}) {
  const unavailable = () => new Error(t('main.feed.memory.unavailable'))
  if (!current()) throw unavailable()
  const continuation = await read()
  const held = () => current() && continuation.current()
  if (!held()) throw unavailable()
  if (!matchesFeedContinuation(continuation.item, text)) throw new Error(t('main.feed.edit.continuation'))
  if (!await transfer(continuation.memory) || !held()) throw unavailable()
  await record()
  if (!held()) throw unavailable()
  return held
}

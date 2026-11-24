import { extractFeedContinuationSupplement } from '../shared/feed-continuation.ts'
import { t } from '../shared/i18n/translate.ts'
import type { FeedStore } from './feed-store.ts'

type Continuation = NonNullable<ReturnType<FeedStore['continuation']>> & { current(): boolean }
export type AdmittedFeedContinuation = (() => boolean) & { readonly supplement: string }

/** Validate the current draft and keep its delivery bound to the selected recipient. */
export async function admitFeedContinuation({ text, read, current }: {
  text: string
  read(): Promise<Continuation>
  current(): boolean
}): Promise<AdmittedFeedContinuation> {
  const unavailable = () => new Error(t('main.feed.memory.unavailable'))
  if (!current()) throw unavailable()
  const continuation = await read()
  const held = () => current() && continuation.current()
  if (!held()) throw unavailable()
  const supplement = extractFeedContinuationSupplement(continuation.item, text)
  if (supplement === null) throw new Error(t('main.feed.edit.continuation'))
  return Object.assign(held, { supplement })
}

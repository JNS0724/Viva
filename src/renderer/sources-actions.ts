import { t } from '../shared/i18n/translate.ts'
import type { SourceView } from './capability-types.ts'

/**
 * 消息源 from the window (sources-state.ts): the list loaded, one paused, resumed or deleted by hand. Adding one is
 * the conversation's (viva-sources' tools, with the user's confirmation there): 添加消息源 only puts a sentence in the
 * input for the user to finish and send.
 */
export function createSourceActions({ api, getState, dispatch, errorMessage, fillComposer }: Pick<ActionDeps, 'api' | 'getState' | 'dispatch' | 'errorMessage'> & {
  /** Puts `text` in the input, the conversation in front. */
  fillComposer: (text: string) => void
}) {
  const fail = (err: unknown) => dispatch({ type: 'sources_failed', message: errorMessage(err) })

  async function loadSources() {
    try {
      dispatch({ type: 'sources_loaded', list: await api.listSources() as readonly SourceView[] })
    } catch (err) {
      fail(err)
    }
  }

  /** One change at a time; the list comes back as it is after it. */
  async function change(request: () => Promise<unknown>) {
    if (getState().sources.busy) return
    dispatch({ type: 'sources_busy' })
    try {
      dispatch({ type: 'sources_loaded', list: await request() as readonly SourceView[] })
    } catch (err) {
      fail(err)
    }
  }

  return {
    loadSources,
    pauseSource: (id: string, paused: boolean) => change(() => api.pauseSource(id, paused)),
    deleteSource: (id: string) => change(() => api.deleteSource(id)),
    addSource: () => fillComposer(t('sources.prompt')),
  }
}

import { t } from '../shared/i18n/translate.ts'
import type { traceItems } from './selectors.ts'

type TraceItem = ReturnType<typeof traceItems>[number]

export function createTraceActions({ api, getState, dispatch, errorMessage, showToast, copyText = text => navigator.clipboard.writeText(text) }: Pick<ActionDeps, 'getState' | 'dispatch' | 'errorMessage' | 'showToast'> & {
  api: Pick<AgentApi, 'loadModelRequest'>
  copyText?: (text: string) => Promise<void>
}) {
  async function open(item: TraceItem, ownerId?: string) {
    const conversationId = ownerId ?? getState().conversationId
    if (!conversationId) return
    const entry = item.entry
    dispatch({ type: 'open_drawer', tab: 'trace' })
    dispatch({ type: 'trace_detail_open', key: item.key, conversationId, loading: entry.kind === 'model' })
    if (entry.kind !== 'model') return
    const call = getState().modelCalls[entry.ref]
    if (!call) {
      dispatch({ type: 'trace_detail_failed', key: item.key, conversationId, message: t('trace.detail.unavailable') })
      return
    }
    const revision = getState().traceRevision
    try {
      const request = await api.loadModelRequest(conversationId, call.sessionId, call.turn, call.step)
      if (getState().traceRevision !== revision) return
      dispatch({ type: 'trace_detail_loaded', key: item.key, conversationId, request })
    } catch (error) {
      if (getState().traceRevision !== revision) return
      dispatch({ type: 'trace_detail_failed', key: item.key, conversationId, message: errorMessage(error) })
    }
  }

  return {
    open,
    close() { dispatch({ type: 'trace_detail_close' }) },
    async copy(text: string) {
      try {
        await copyText(text)
        showToast(t('trace.copied'))
      } catch (error) {
        showToast(`${t('trace.copy.failed')}: ${errorMessage(error)}`)
      }
    },
  }
}

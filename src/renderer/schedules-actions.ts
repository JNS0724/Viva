/**
 * IPC and side effects for the 定时任务 hub sub-page (schedules-state.ts, view/schedules-page.ts).
 */
export function createScheduleActions({ api, dispatch, errorMessage }: Pick<ActionDeps, 'dispatch' | 'errorMessage'> & {
  api: Partial<Pick<AgentApi, 'listSchedules' | 'pauseSchedule' | 'deleteSchedule'>>,
}) {
  let busy = false
  let loadSeq = 0

  async function loadSchedules() {
    if (!api.listSchedules) return
    const seq = ++loadSeq
    try {
      const schedules = await api.listSchedules()
      if (seq !== loadSeq) return
      dispatch({ type: 'schedules_loaded', schedules })
    } catch (err) {
      if (seq !== loadSeq) return
      dispatch({ type: 'schedules_failed', message: errorMessage(err) })
    }
  }

  function openSchedules(id: string | null = null) {
    dispatch({ type: 'schedules_open', id })
    void loadSchedules()
  }

  async function actOnSchedule(work: () => Promise<unknown>, { clearExplicit = false } = {}) {
    if (busy || !api.listSchedules) return
    busy = true
    loadSeq += 1
    dispatch({ type: 'schedules_busy' })
    let mutated = false
    let refreshSeq = 0
    try {
      await work()
      mutated = true
      refreshSeq = ++loadSeq
      const schedules = await api.listSchedules()
      if (refreshSeq === loadSeq) {
        dispatch({ type: 'schedules_loaded', schedules, ...(clearExplicit ? { clearExplicit: true } : {}) })
      }
      dispatch({ type: 'schedules_done' })
    } catch (err) {
      if (mutated && refreshSeq !== loadSeq) dispatch({ type: 'schedules_done' })
      else dispatch({ type: 'schedules_failed', message: errorMessage(err) })
    } finally {
      busy = false
    }
  }

  return {
    loadSchedules,
    openSchedules,
    pauseSchedule: (id: string, paused: boolean) => (api.pauseSchedule ? actOnSchedule(() => api.pauseSchedule!(id, paused)) : Promise.resolve()),
    deleteSchedule: (id: string) => (api.deleteSchedule ? actOnSchedule(() => api.deleteSchedule!(id), { clearExplicit: true }) : Promise.resolve()),
  }
}

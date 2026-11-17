import { reportId } from '../../src/shared/task-report.ts'
import { run, until, type SmokeWindow } from './smoke-kit.ts'

/** A task card can finish before its gathered report starts a foreground turn. */
export async function taskRunOf(win: SmokeWindow, taskId: string): Promise<string> {
  const runId: unknown = await run(win, `(async () => {
    const task = (await window.agent.finishedTasks()).find(entry => entry.task.id === ${JSON.stringify(taskId)})
    return task?.mark?.runId
  })()`)
  if (typeof runId !== 'string' || !runId) throw new Error('The restored task has no current run identity')
  return runId
}

/** Wait for this new run's durable read receipt and its foreground turn, never an idle gap or an old same-title report. */
export async function waitForReportedTaskRun(win: SmokeWindow, taskId: string, previousRunId: string, title: string): Promise<void> {
  const runId: unknown = await until(win, `(async () => {
    const task = (await window.agent.finishedTasks()).find(entry => entry.task.id === ${JSON.stringify(taskId)})
    return task?.status === 'done' && typeof task.mark?.runId === 'string'
      && task.mark.runId !== ${JSON.stringify(previousRunId)} && task.mark.runId
  })()`, 'the restored task completing its new run')
  if (typeof runId !== 'string' || !runId) throw new Error('The completed task has no new run identity')
  await until(win, `(async () => {
    const history = await window.agent.loadHistory()
    const record = history?.records?.find(record => record.reportId === ${JSON.stringify(reportId(taskId, runId))})
    if (!record || !history.messages.slice(record.after).some(message => message.role === 'assistant'
      && message.text.includes('已看过后台结果：') && message.text.includes(${JSON.stringify(title)}))) return false
    const send = document.getElementById('send-btn')
    return send.dataset.busy === 'false' && !send.disabled && !document.querySelector('.caret')
  })()`, 'the restored task report being read and its foreground turn ending')
}

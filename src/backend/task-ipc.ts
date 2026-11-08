import type { IpcRegistry } from '../shared/ipc-contract.ts'
import type { TaskWindow } from './task-runtime.ts'

/**
 * The window's channels for background tasks: each hands its request to the task runtime (task-runtime.ts), which
 * holds and writes the tasks. Nothing is kept here.
 */
export function registerTaskIpc(ipcMain: Pick<IpcRegistry, 'handle'>, tasks: TaskWindow): void {
  ipcMain.handle('task:finished', () => tasks.finished())
  ipcMain.handle('task:close', (_event, taskId) => tasks.close(taskId))
  ipcMain.handle('task:stop', (_event, taskId) => tasks.stop(taskId))
}

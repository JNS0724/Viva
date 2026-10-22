/**
 * The working directory as the window shows it (single-conversation design): the folder in use and the ones
 * used lately, as the main process reports them (main/work-dir-ipc.js), the chip's menu, the folder waiting
 * for the user's confirmation the first time it is used, and why the last switch was refused.
 * Pure and immutable like the rest of `state.js`, which merges these handlers into its reducer.
 */
export const initialWorkDir = Object.freeze({
  current: '',
  defaultDir: '',
  isDefault: true,
  recent: Object.freeze([]),
  menu: false,
  /** A folder picked for the first time, waiting for 在这里工作 or 取消. */
  confirm: null,
  switching: false,
  error: null,
})

const withWorkDir = (state, changes) => ({ ...state, workDir: { ...state.workDir, ...changes } })

export const WORKDIR_ACTIONS: Record<string, Reducer> = {
  workdir_loaded: (state, { view }) => withWorkDir(state, {
    current: view.current, defaultDir: view.defaultDir, isDefault: Boolean(view.isDefault), recent: view.recent ?? [], switching: false, error: null,
  }),
  workdir_menu: (state, { open }) => withWorkDir(state, { menu: Boolean(open), error: open ? null : state.workDir.error }),
  workdir_confirm: (state, { dir }) => withWorkDir(state, { confirm: dir ?? null, menu: false }),
  workdir_switching: (state) => withWorkDir(state, { switching: true, menu: false, confirm: null, error: null }),
  workdir_failed: (state, { message }) => withWorkDir(state, { switching: false, error: message }),
}

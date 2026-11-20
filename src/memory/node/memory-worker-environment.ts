/** Local workers need operating-system paths and timezone, without parent credentials. */
export function memoryWorkerEnvironment(): NodeJS.ProcessEnv {
  const { SystemRoot, WINDIR, TEMP, TMP, TMPDIR, USERPROFILE, TZ } = process.env
  return { ELECTRON_RUN_AS_NODE: '1', SystemRoot, WINDIR, TEMP, TMP, TMPDIR, USERPROFILE, TZ }
}

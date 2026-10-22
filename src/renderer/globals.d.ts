// What the preload scripts put on the page (src/preload/preload.cjs, desk-preload.cjs). Loose until the shared
// IPC contract (src/shared/contracts) types every channel; then these point at it.
interface Window {
  agent: any
  desk: any
}

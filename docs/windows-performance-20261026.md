# Windows conversation responsiveness and real streaming

Validated on 2026-10-26, Windows build 26200 at 175% scaling. Branch: `codex/windows-performance`.
Base: `d6238c88fcdc9861d357b83005042a66830ecfe7`, combining PR #45 and the already merged PR #44.
Runtime: Electron 44.7.0, dsh 0.2.0-rc.2. Real-model checks used DeepSeek-V41-Flash / high.

## Causes and changes

The reported delay is between submitting and seeing the user's own words. Model completion time is a different measurement.

- The foreground dispatch was already synchronous. Its cost came from replacing the entire thread, rebuilding loaded history on busy/idle transitions, and immediately reading layout for scrolling. Persistence acknowledgments repeated the work. Rows now retain their DOM per container, unchanged reducer results skip rendering, history controls update separately, and geometry reads/writes are coalesced after DOM updates. Rewind controls keep a stable wrapper and do not change bubble width when a turn starts. Model bursts render once per frame.
- Background submission awaited fork/resume/MCP before displaying anything. Pending and failed submissions now retain the full text immediately, with explicit retry/removal. Successful work attaches to its captured source conversation. A failed background request is no longer silently steered into a foreground turn. Early task events wait until its task exists in the renderer.
- New sessions reconnect MCP. The app can prepare at most one untouched session for the current directory/MCP fingerprint; each topic consumes a distinct session. Configuration changes discard it. This adds at most one extra prepared agent scope and its MCP connections. It does not share stateful MCP clients across conversations. Cold creation and restoring a fork still require initialization.
- A failed MCP configuration is temporarily excluded for 30 seconds across session operations. Expiry, changed configuration, or explicit reload allow another attempt. Its existing failure status remains visible.
- dsh already emitted `agent/assistant-stream`; its ACP adapter only forwarded completed assistant blocks. The new versioned `viva-stream` plugin projects live text/reasoning through Node IPC. Tools, permissions, and usage continue through ACP. Neither dependencies nor `node_modules` are patched.
- Stream source selection is negotiated before each prompt. A transport barrier at completion handles ACP/IPC delivery in either order. Block ends replace provisional content, retries remove failed attempts, and durable session events settle the final visible content. A broken stream channel rolls back its own provisional output before replaying complete ACP text. Operation IDs include a bridge-instance UUID so dsh restart cannot overwrite a prior answer.
- Stop deadlines begin before awaiting cancellation. Timers and late stream completion belong to an operation object, so an old timer cannot stop a later turn in the same session. Detaching a command still does not prove that the underlying process has stopped.

## Measurements

These are local UI measurements from the actual Electron app with a real model. The QA driver invokes the same DOM click/submit handlers; this is not a hardware mouse-to-display latency measurement. The window was visible/focused, with background throttling disabled only in the QA harness.

| Input characters | Before: normal click | After: normal click | Before: background text in DOM | After: background text in DOM |
|---:|---:|---:|---:|---:|
| 100 | 34.4 ms | 0.9 ms | 1698 ms | 0.5 ms |
| 10000 | 46.9 ms | 2.5 ms | 1685 ms | 0.6 ms |
| 20000 | 55.6 ms | 4.2 ms | 1737 ms | 0.7 ms |

The foreground thread contained approximately 66–98k characters in the final comparison. The final history region was larger than the baseline (216k versus 29k characters), so this is not an identical DOM snapshot comparison. The final click traces contain **zero synchronous Layout events**, versus 28.8/38.2/45.8 ms inside the baseline clicks. First document Paint began about 6/10/22 ms after the final clicks; Paint and two RAFs do not prove compositor presentation.

Background and new-topic comparisons used a deliberately delayed MCP initialize (1500 ms). Background task readiness still waited for it. Three new-topic checks after allowing preparation took 264/59/59 ms, versus the earlier 1659–1707 ms cold path. The first included transferring a long conversation to history. Unprepared/rapid repeated topics can still incur cold initialization.

In a separate synthetic benchmark, rerendering the same 1000 messages / 200k characters took 2.7 ms for the thread and 1.6 ms for history, versus approximately 98/108 ms before. These are warm DOM/layout checks, not model or click-to-paint results. First insertion and actual width changes still require layout.

A real foreground reply and unrelated background calculation ran concurrently. The new background text was visible in 0.4 ms, returned `1674`, and both operations ended once without errors. The foreground received its first reasoning delta at 1.12 s, first text at 30.33 s, and finished at 38.08 s. Final rendered Markdown matched the canonical submitted text, with exactly one assistant bubble. The earlier history node stayed attached.

With 216k history characters, 120 programmatic window width changes had RAF p95 8.4 ms and no intervals over 50 ms, both idle and starting during a real streamed reply. This is a `BrowserWindow.setBounds` workload. Native continuous edge dragging and the user's other installed Windows machine remain unverified.

## Verification and evidence

- `npm run typecheck`, `npm run build`, and `git diff --check` pass.
- `npm test`: **615 passed, 0 failed** under the pinned Electron runtime on Windows.
- All five smoke phases passed. Setup/walkthrough/relaunch passed from a clean setup; after fixing the restart identity issue, memory and resume were rerun successfully. An earlier scroll-anchor regression was caught and corrected to scroll-container coordinates. The island steering smoke selector was updated for the stable user-row wrapper.
- `test/stream-runtime.test.js` runs the actual dsh against deliberately delayed SSE: the first live delta arrives before response completion, and cancelling retains only the committed prefix.
- Stream tests cover transport ordering, missing/late plugin readiness, block correction, failed attempt/retry, stale operations, bridge recreation, and ACP recovery after lost streaming. Existing actual-dsh tests and smoke cover tools, foreground/background movement, undo, and task restoration.
- The pre-existing Windows environment fixture now puts its complete environment-name list in the contract's `text` field rather than an invalid overlong title. The production title limit is unchanged.

Machine-local logs, traces, scripts, comparison data, and final tested SHA are recorded in `E:\viva\performance-fix-20261026`. Earlier baseline evidence is in `E:\viva\qa-20261026`. QA uses a dedicated profile and synthetic prompts; the user's installed profile was not used.

This change does not claim to fix the separate desktop-island topmost/environment issue, force a blocked shell command to exit, or verify an installer on the other machine. No installer, remote push, merge, or release was performed.

# New-topic P0/P1 implementation and validation

English | [简体中文](new-topic-performance-20261026.zh-CN.md)

Historical Windows validation on 2026-10-26, branch `codex/windows-island-interaction`, uncommitted workspace based on `c4c13d73a429d00ab2262e14119a4cb92f276fa4`. Runtime remained Electron `44.7.0`, dsh `0.2.0-rc.2`, ACP SDK `1.9.0`. P2 shared MCP connections were out of scope. These are not current internationalization results.

## Implementation

| Area | Behavior |
|---|---|
| P0 immediate UI | Archive messages and show/focus an editable new topic immediately; disable sending while preparing; failure retains draft and offers Retry; repeated clicks do not create duplicates or archive twice |
| P0 cleanup off critical path | Detach old foreground event ownership immediately; no-MCP/prepared paths may overlap cleanup; cold MCP creation/resume still waits for release; at most one old foreground cleanup during rapid switches |
| P0 timing | Main measures cancel, close, release wait, create+MCP, session acquisition/source, model settings, total; renderer measures history handling, rendering, UI response, first frame callback, readiness |
| P1 prepared session | One spare, directory/config fingerprint invalidation, expiry 120 seconds after ready, no repeated attempts for failed fingerprint, no active MCP status pollution on speculative failure, retryable cleanup and disposal of late results |
| P1 avoid redundant calls | Close idle sessions without cancellation; skip already-selected model/options, retaining main's last-model check |
| P1 long history | Cache immutable segments, reuse topic/message DOM, linear grouping instead of repeated copies; late save fills archive id without contaminating new topic |
| P1 upgrade audit | Isolated rc.2 compatibility/resume/packaged Windows runtime checks; production unchanged; see [report](dsh-upgrade-validation-20261026.md) |

Concurrent background behavior was incorporated: main chat contains only the task card and task details retain the original request. Empty-conversation cards, anchors before the next main message, late old-topic isolation, and cleanup were covered without restoring a duplicate user bubble.

## Validation

Four TypeScript configs, build, and diff whitespace checks passed. The pinned Electron runtime passed **640 tests / 0 failures**, covering cold MCP barriers, prepared hits/retries, stale events/permissions/suggestions, background permissions, spare expiry, disposal races, drafts, and history ids. Actual dsh with local fake models covered streaming, cancellation, singleton MCP, and background tasks without external model calls/messages.

All five desktop smoke phases (`setup/walkthrough/relaunch/memory/resume`) passed in isolated profiles. They covered immediate new-topic focus, disabled sends, draft retention, background card-only behavior, original request details, and task restart. The first suite and memory smoke each found an outdated bubble assertion, corrected to the new contract. Initial resume used a random fake-model port inconsistent with the saved address; the documented shared `SMOKE_LLM_PORT` fixed it without changing production connection logic.

## Measurements and limits

| Scenario | Result | Limit |
|---|---|---|
| Desktop new-topic click | 4.5 ms synchronous handling; ready observed at about 5.6 ms; focused input and retained draft | One real Electron DOM check with fake ACP; not hardware-to-display latency or production p95 |
| Actual dsh, 1,500 ms delayed MCP, no preparation | 1,638.56 / 1,640.00 / 1,636.29 ms | Node-driven dsh, old cleanup plus new MCP initialization; excludes UI/model generation |
| Same MCP after successful preparation | 0.28 / 0.33 / 0.31 ms, one active MCP | Acquisition of an existing session; initialization already paid in background; not before/after comparison |
| 1,000 messages / 200k characters, append three topics | 13.5 ms initial, about 0.2 ms each append; same original nodes, zero old-subtree childList changes | Hidden standalone Electron page without full product CSS; DOM reuse, not real layout/paint/display latency |

Enable main timing with `VIVA_SESSION_TIMING=1` (`[session-timing]`) and renderer with `localStorage.setItem('viva:session-timing','1')` (`[session-timing:renderer]`). ACP combines MCP initialization and agent creation in one RPC, recorded honestly as `session.create-and-mcp`. A frame callback does not prove compositor presentation.

Local rerunnable evidence: `E:\viva\new-topic-p0p1-20261026`, containing `verify.cjs`, five-phase logs/screenshots, `tests.log`, `benchmark.mjs/json`, and `dom-check.cjs/json`. Node launches pinned Electron with `ELECTRON_RUN_AS_NODE=1` for tests and removes it for GUI smoke; TEMP/TMP point to the test directory.

## Not covered

No candidate dsh release combined with these optimizations, installed-user upgrade, new NSIS installer, or other-machine/platform acceptance. Cold singleton MCP creation may still wait. An editable composer does not mean the backend is ready. Shared MCP connections remain unimplemented P2 work.

## PR checks follow-up

Windows CI for `bf2b232` passed; macOS walkthrough timed out waiting for the first approval. Its home screenshot still showed model “—”; the test used a fixed 1,500 ms startup delay. `smoke-kit.submit` now waits for live agent, session id, and enabled input/send before typing, retaining the 60-second bound.

`test/smoke-kit.test.ts` checks that an unready app is neither typed into nor submitted. Typecheck/build and the mixed JS/TS suite passed **641/641**. Actual Windows walkthrough passed with fake dsh delayed by 5,000 ms. The macOS fix remained subject to the next remote CI result. TypeScript migration conventions and `tsconfig.test.json` shipped with this follow-up.

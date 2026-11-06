# Architecture cleanup: reduce the scope of understanding one change

English | [简体中文](architecture-health.zh-CN.md)

Review baseline: 2026-11-06, main `26e4db4` (PR #95). This reviews source and change history, not application runtime performance. The first batch preserves product behavior and process boundaries.

## Evidence and priorities

Product `src` and `plugins` contain 243 TypeScript/JavaScript files and 30,521 lines, including blanks, comments and translations, excluding dependencies, tests, images and CSS. Size alone does not explain development speed; concentrated responsibilities and changes are clearer problems.

| Priority | Evidence | Effect on changes | Direction |
| --- | --- | --- | --- |
| P1 | `src/backend/compose.ts`: 1,105 lines, 55 distinct local dependencies; touched in 25 of the latest 50 non-merge commits | Configuration cards, session lifecycle, history switching, memory polling, schedules and process assembly share a closure; changing one feature requires understanding others' initialization order | Let feature modules own behavior and state; keep creation, wiring and disposal in the entry |
| P1 | `src/renderer/app.ts`: 1,103 lines, 43 local dependencies; touched in 15 of those commits | Page bindings, sending/interjections, card answers and event routing are interleaved; sending races require investigating the whole page | Extract conversation effects into actions with injected dependencies; let the entry wire them |
| P1 | `globals.d.ts` uses `any` for `Action`, `Untyped` and some IPC results; `acp-bridge.ts` also has open fields | Misspelled actions and cross-module shape changes can escape checking during refactoring | Type each feature's action/event union and IPC results incrementally instead of replacing all global state types at once |
| P2 | `view/render.ts` and `view/hub.ts` import the `Dom` type from executable `app.ts` | Creates a type dependency cycle and ties view contracts to startup; it is not a runtime cycle | Move the DOM contract into an independently importable page binding module without module-level startup effects |
| P2 | The architecture document still claims 793 unit tests; the baseline has 919, and its old reconnect limit predates B2 | Developers and models may investigate or redesign against stale descriptions | Describe mechanisms rather than fixed counts, and correct the reconnect limitation |

Preserve the existing shell/backend boundary, IPC argument contracts, TaskRuntime as the single writer of task state, transactions coupling storage changes with events, and renderer state/actions/view layers. Cleanup extends these boundaries rather than introducing another task scheduler or state authority.

## Boundaries implemented in the first batch

- `src/renderer/conversation-actions.ts`: ordinary/image questions, interjections, turn-end resend, question answers and credential responses. Depends only on a narrow API, state access, dispatch and UI callbacks; no `document` or `app.ts` dependency.
- `src/renderer/page-elements.ts`: binds page elements once and exports `Dom`. Views no longer depend backwards on the application entry.
- `src/backend/config-actions.ts`: MCP/skill operations requested through approved model cards. Depends on configuration storage, skill roots, trash capability and a change callback, not backend startup or the ACP process. Preparing a card writes nothing; only successful changes mark MCP for reload.
- `test/module-boundaries.test.ts`: walks TypeScript/JavaScript source in `src` and `plugins` using real syntax trees, including type imports, re-exports and literal dynamic imports; rejects feature imports of composition roots and source dependency cycles. Existing backend/Electron boundary checks remain.

Entry sizes become 1,041 lines in `compose.ts` and 943 in `app.ts`. File count grows, and factory assembly still imports features; neither metric alone is the objective. The useful change is that sending races and configuration operations can be tested independently without importing the executable application entry.

New behavior tests cover interjections becoming the next question as a turn ends, batching without duplicate resend, retained failed messages, clearing deferred sends after errors, image restrictions, question/credential request ids, credentials staying out of page state, configuration preparation without writes, encryption, no reload after failed changes, imports and skill trashing.

## Second batch: the dsh lifecycle

`src/backend/dsh-lifecycle.ts` now owns the runtime instance, generation, restart timer, crash history and quitting flag. Narrow capabilities supply creation and connection; existing modules retain configuration, history, task state and event routing. Startup, shutdown and crash recovery no longer share writable runtime variables in the composition root.

Contract tests cover shared concurrent starts, stopping in-flight startup, stale events/exits, replacement waiting for real disposal, 1/3/10-second crash backoff and giving up, revoking queued restarts, quitting, startup cleanup, failed disposal blocking replacement, and shutdown timeout retaining the disposal barrier. Readiness callbacks execute after checking the current generation; a cancelled connection cannot publish stale readiness.

This batch includes verified race fixes: revoking in-flight startup results, cleaning up failed initialization, coalescing concurrent starts and keeping the resource barrier after shutdown stops waiting. Instance retirement also settles an active foreground turn explicitly: filtered old events cannot leave the replacement busy. Cancellation clears queued interjection resends and revokes pending idle receipts. The real-dsh lifecycle smoke test changes models and clears a key while a question waits, then verifies new topics and background result reports. Key changes settle the old topic before creating the new one; late memory collection retains the ended turn's topic/session. It changes neither IPC/database formats nor TaskRuntime's authority. Extracting history/workspace switching business logic remains a later task.

## Subsequent batches and delivery criteria

| Order | Scope | Done when |
| --- | --- | --- |
| 2 | dsh lifecycle (this batch); history/workspace switching follows separately | Lifecycle state/timers now have a single module, verified by contract tests and full smoke; later switching extraction must test failure recovery |
| 3 | Renderer event ingress and conversation action types | Incoming events and actions are exhaustive unions; unknown events are handled explicitly at the boundary; foreground event changes do not require changing the task reducer; tests retain exclusion of old foreground pushes during new-topic preparation |
| 4 | ACP foreground and background session responsibilities | First identify shared transport, permission and cancellation capabilities, then extract session control; preserve process ownership, run admission and TaskRuntime's single writer rather than duplicating state machines |
| 5 | Test feedback and dependency cleanup | Feature-specific short feedback paths; full suites and both platforms' smoke remain final gates; remove interfaces with no callers while retaining contract and failure tests |

Each batch changes one explainable responsibility: establish state ownership, move behavior with tests, then remove its old entry. Smaller files or changed extensions alone do not count as delivery. The first batch changes no IPC, database format, task lifecycle or ACP semantics; subsequent changes to those boundaries require their own review and validation.

## Measuring development speed

Local full-test baseline: 919 passing tests, approximately 14.8 seconds on this machine with existing dependencies, measured once. This excludes remote CI queueing, dependency installation, build, packaging and smoke. Record remote waiting separately from source comprehension cost.

Track four things per batch: modules touched by a representative feature change, whether the entry still contains that feature's business logic, focused test time, and full verification results. The first batch's feature and architecture tests can run directly:

```sh
npx cross-env ELECTRON_RUN_AS_NODE=1 electron --test test/conversation-actions.test.ts test/config-actions.test.ts test/module-boundaries.test.ts
npm run typecheck
```

Final validation still includes `npm test` and `npm run check:i18n`. Major architectural changes run build and full smoke locally before checking macOS/Windows CI at the PR's current commit. Do not promise a percentage improvement before comparing equivalent development tasks before and after.

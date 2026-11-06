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

This batch includes verified race fixes: revoking in-flight startup results, cleaning up failed initialization, coalescing concurrent starts and keeping the resource barrier after shutdown stops waiting. Instance retirement also settles an active foreground turn explicitly: filtered old events cannot leave the replacement busy. Cancellation clears queued interjection resends, marks undelivered messages and revokes pending idle receipts. The real-dsh lifecycle smoke test changes models and clears a key while a question waits, then verifies new topics and background result reports. Key changes settle the old topic before creating the new one; late memory collection retains the ended turn's topic/session only while that topic remains current and no new foreground turn is running. This guard does not add session-level attribution to the memory store. It changes neither IPC/database formats nor TaskRuntime's authority. The separate owner for history/workspace session transitions is described below.

## Conversation and workspace selection

`src/backend/conversation-session.ts` owns the selected history segment, working directory, one-time carried records and pending session transitions. `compose.ts` provides storage, runtime and view capabilities; it no longer writes these session variables or implements model matching, topic creation, directory forks or resume recovery.

History and rewind commands use a mandatory selection callback. The admission gate remains closed through the runtime switch, history writes and segment selection, including transitions between segments with the same session id. A failed model match after acquiring a fresh runtime session keeps prompts and reports gated until a successful retry or explicit reconciliation; cached session info alone cannot prove the runtime stayed on the old session. Metadata saves cannot clear this gate. Every transition exit wakes waiting effects; safe fork failures resume reports on the unchanged conversation.

Focused contracts use real in-memory history/effects stores and the real history/rewind IPC handlers. They cover concurrent new topics, failures and retries, exact resume and recovery info, directory forks with saved/unsaved predecessors, stale runtime results, carried records, deferred reports and selection commits. These tests do not replace the full application smoke or both platforms' CI.

Conversation pushes now carry the history segment and runtime session captured when their prompt or plugin request began. The renderer buffers foreground pushes during bootstrap and while a selection RPC commits, then replays only the selected context in receive order and with the original receive timestamps. Task streams remain live. This closes the interval in which an immediately delivered background report could arrive before the page received its new-topic response. Questions and credential closures retain their original context; late prompt failures and interjection receipts cannot affect a newly selected topic. Rewind waits for queued reports before deciding whether its automatic follow-up is a new prompt or an interjection. The production event mapper also handles task permission closure without inventing a user decision. Offline directory changes publish the committed segment too. MCP reattachment reconciles a cold replacement session through the same owner and publishes configuration before releasing queued reports; sends are refused during directory, rewind and settings transitions. The next section describes the event decoding and exhaustive action owner.

## Renderer event and action contracts

`agent-events.ts` owns the unknown wire boundary, selection buffering, task-load handoff and push-triggered effects. `agent-event-decoder.ts` projects each supported payload into a closed `AgentEvent` union, discards unused ACP payloads, and rejects unknown/malformed frames before reducers or file/feed effects. Diagnostics contain a known tag and reason only. `agent-event-actions.ts` maps the validated union exhaustively; task pieces retain their run id and task sequence separately from the global event sequence. The old pending-topic tag filter has no remaining entry.

The global `Action` is now a union over a finite payload table, with mapped handler signatures instead of an open dictionary. Conversation state, text/thought streams, tools, trace entries, waits and receipts have explicit types and are excluded from the legacy state-widening helper. Task approvals and question answers use their own action tags; foreground payloads cannot carry task routing fields. Session metadata and conversation IPC results are typed end to end. Other feature payloads still reference their existing state contracts; this does not claim that all legacy feature data has been fully typed.

Production-entry tests cover bootstrap replay, omitted config fields preserving identity and recovery state, nullable SDK approval fields with tool fallback, real TaskRuntime snapshots/pieces during task reads, task/global sequence separation, malformed schedule proposals, and rejected frames causing no effects or payload-bearing diagnostics. All supported wire tags have examples. Compile-only negative tests reject misspelled actions, missing words/stream marks, missing text chunks and mixed foreground/task identities. Full suites and platform smoke remain required.

## ACP operation and task-session owners

`acp-operations.ts` owns native prompt identities, captured contexts, stream completion and cancellation deadlines. Foreground and background prompts share this mechanism without sharing writable operation records. Results check the operation identity after each await; an old operation cannot finish or delete the next one on the same native session. Disposal revokes pending stream bindings and prevents new work.

`acp-task-sessions.ts` owns native task attachments, their known configuration values and unattended markers. It acquires, resumes, configures, prompts, cancels and closes task sessions through narrow transport, permission, question, steering and read-only capabilities. It captures foreground directory/configuration before asynchronous acquisition, including SDK boolean options. Failed configuration or unattended marking releases the unreported session; late acquisition after disposal cannot reattach it. Each native attachment also has a private request identity: closing revokes an in-flight resume, old config/mark callbacks cannot remove a replacement, and reattachment waits for the prior close and wait cleanup. The bridge retains process ownership, MCP preparation, foreground selection and resource-close barriers. It no longer writes the task attachment, unattended or running maps. TaskRuntime still owns admission, application runs, status, transactions, persistence and reports.

Owner contracts cover cancellation with a non-returning RPC, delayed results and finally blocks after session reuse, disposal during stream binding and native acquisition, configuration snapshots, boolean requests, and cleanup after configuration/read-only failures. Existing public-bridge, stream, resume, resource-barrier and TaskRuntime tests remain the wiring and behavior gates.

## Test feedback and retired entry points

`npm run test:feature -- conversation` runs the conversation contracts, including event ingress, the core reducer and credentials, plus shared IPC/page API and module-boundary checks. The other curated groups are `runtime`, `tasks` and `architecture`; multiple groups are deduplicated and `--list` shows the chosen files. Runtime checks include the keeper and desktop questions; task checks include proposal state. The groups are a local feedback aid, not an automatic transitive dependency analysis. Unknown names and empty groups fail before launching; the child test exit status is preserved. Discovery includes both `.test.js` and `.test.ts`, skips installed dependencies and symlinks, and launches Electron with an argument array rather than a shell command. The script participates in typechecking; tests cover mixed discovery, a directory cycle, invalid selections and representative cross-feature contracts. Full `npm test` and coverage discovery are unchanged.

The unused `openConversation` page API, `history:open` argument contract/handler and `conversation_opened` action/handler are removed together. Source search found no product caller: review reads through `history:read`, and continuing a topic or undoing a new topic uses `history:resume-topic`; recovery from records still uses `history:continue-from-records`. History tests now exercise these live paths instead of manufacturing an obsolete open action. Real-database tests retain save/delete/restore/search/export and verify that reading old history cannot switch the selected agent. Session-unavailable, missing-directory, busy, carried-record and late-load refusal contracts remain.

## Batch scope and delivery criteria

| Order | Scope | Done when |
| --- | --- | --- |
| 2 | dsh lifecycle and conversation/workspace selection | Separate owners hold process lifetime and selected session state; focused contracts verify failure recovery and reports across transitions, with full smoke and platform CI as final gates |
| 3 | Renderer event ingress and conversation action types | Incoming events and actions are exhaustive unions; unknown events are handled explicitly at the boundary; foreground event changes do not require changing the task reducer; tests retain exclusion of old foreground pushes during new-topic preparation |
| 4 | ACP foreground and background session responsibilities | Identify shared transport, permission and cancellation capabilities, then extract session control; preserve process ownership, run admission and TaskRuntime's single writer rather than duplicating state machines |
| 5 | Test feedback and dependency cleanup | Feature-specific short feedback paths; full suites and both platforms' smoke remain final gates; remove interfaces with no callers while retaining contract and failure tests |

Each batch changes one explainable responsibility: establish state ownership, move behavior with tests, then remove its old entry. Smaller files or changed extensions alone do not count as delivery. The first batch changes no IPC, database format, task lifecycle or ACP semantics; subsequent changes to those boundaries require their own review and validation.

## Measuring development speed

Local full-test baseline: 919 passing tests, approximately 14.8 seconds on this machine with existing dependencies, measured once. This excludes remote CI queueing, dependency installation, build, packaging and smoke. Record remote waiting separately from source comprehension cost.

Track four things per batch: modules touched by a representative feature change, whether the entry still contains that feature's business logic, focused test time, and full verification results. With the cleanup, a local conversation-group sample passes 239 tests in approximately 1.1 seconds. This is one measurement with installed dependencies, not a promised product or development-speed percentage. Use the responsibility being edited for quick feedback, then run the full gates:

```sh
npm run test:feature -- conversation
npm run test:feature -- runtime tasks --list
npm run typecheck
npm test
```

Final validation still includes `npm test` and `npm run check:i18n`. Major architectural changes run build and full smoke locally before checking macOS/Windows CI at the PR's current commit. Do not promise a percentage improvement before comparing equivalent development tasks before and after.

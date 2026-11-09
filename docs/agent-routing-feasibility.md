# Viva Main Agent Routing Feasibility Validation

English | [简体中文](agent-routing-feasibility.zh-CN.md)

Date: 2026-11-09. Related [routing and task dispatch proposal](agent-routing-design.md). Baseline: `0fc159bd8dbbb42bfbcf05ee5f9150dbb9df426b`. Tests reused the existing `deepseek-official / deepseek-flash` connection available on this machine, catalogued by DSH as `DeepSeek-V41-Flash`. Credentials came from the existing environment, with no changes to everyday Viva data or configuration. This does not assert that the model weights run locally.

**Verdict: the runtime mechanisms are feasible, but the current routing protocol and instructions do not meet implementation acceptance.** Mechanical checks passed 12/12; actual-model formal samples passed 22/27 structured-contract assertions. All five failures retain their original outputs. Correct prose is not sufficient evidence that the backend can reliably continue the workflow.

**Supplementary validation (section 9):** rerun in the real app with a switch-guarded prototype, the production persona, plugins and default thinking: handover, addition, stop, interjection, cross-topic recovery, schedule and memory scenarios each passed 5/5, and the first round's clarification failures came mainly from the reduced persona and disabled thinking. Configuration that needs the user's confirmation cannot yet leave the main session, and constraints on binding timing, the output gate and turns ending in errors must be added to the proposal (section 17 of the proposal).

## 1 Method and evidence

Sources are the [isolated runner](../test/fixtures/routing-feasibility/run.ts), [probe plugin](../test/fixtures/routing-feasibility/index.ts) and [contract and instructions](../test/fixtures/routing-feasibility/contract.ts). These are not production implementation, are not loaded by the production profile, and the CLI does not match automatic `.test.ts` discovery. [Machine-readable evidence](agent-routing-feasibility-results.json) includes complete results, actions, selected events, source hashes and exploratory failures.

Runs use private temporary directories, fresh DSH homes, workspaces and sessions. All messages, histories and task materials are synthetic. Actual worker sessions call a safe delayed fixed-result tool, with no real market research or user-file writes.

The mechanical group used real DSH and a fake model: four scenarios repeated three times. The formal live group has nine scenarios repeated three times, totaling 27 attempts. Retrieval, streamed answers and workers can require additional model steps, so 27 is not the HTTP request count. Three concurrent follow-up requests belong to their parent concurrency attempts, not extra independent successes.

Formal history tests create 80 valid synthetic historical turns, persist, close and resume the session. All three actual-model requests then run at turn 81. Retrieval tests instead keep originals in the probe's history tool. Both paths permit original-text retrieval as a fallback: they do not prove complete retention in compacted internal context or production FTS recall quality.

## 2 Runtime mechanism results

| Scenario | Result | Evidence |
| --- | --- | --- |
| Initial free text without a route | 3/3 | One end-of-turn repair, followed by a reply decision and visible text in the next step |
| Global and scope-local forbidden tools | 3/3 | Reduced tool list; both direct execution probes denied and neither trap body executed |
| End the main turn after start | 3/3 | Actual independent worker session; main turn finishes before the worker |
| Repeated refusal to route | 3/3 | Exactly two repairs followed by failure; uncommitted text absent from the probe's visible output |

The main session's actual tools comprise history, task queries, relevant file reads and `commit_route` (supplementary correction: true only from the second step; the first request still carried every tool, see section 9). A deliberately registered scope-local escape remains visible but is denied at execution. Workers have only the safe step tool, without main-agent routing. Visibility filtering and execution guards are both necessary.

Streaming evidence identifies route and answer steps: visible deltas occur after reply acceptance in a later model step. Suppression is implemented in the probe event gate and visible-output collector, not Viva's production renderer; it does not establish that the product UI has this behavior already.

## 3 Formal actual-model results

| Scenario | Contract passes | Median main-turn time |
| --- | --- | --- |
| Proactively delegate a complete briefing request | 3/3 | 6.408 seconds |
| Update the existing briefing | 3/3 | 4.257 seconds |
| Update briefing and start market analysis | 3/3 | 3.545 seconds |
| Ambiguous reference to same-name reports | 2/3 | 4.685 seconds |
| Route ordinary answer before streaming | 3/3 | 2.631 seconds |
| Make a briefing after resuming 80 historical turns | 3/3 | 5.229 seconds |
| Retrieve earlier criteria and make a briefing | 2/3 | 5.695 seconds |
| Assistant suggestion without user confirmation | 0/3 | 8.827 seconds |
| Same-session follow-up while a worker runs | 3/3 | 3.979 seconds |
| Total | 22/27 | 4.685 seconds |

Main-turn time spans submission to the end of the current main-agent turn, including retrieval, routing and ordinary-answer generation, but not waiting for worker completion. Samples range from 2.180 to 12.398 seconds. These are small experimental samples, not latency commitments or reliability estimates.

Concurrency inputs supply all materials and require `report.md`; the worker tool waits 12 seconds. All three follow-ups correctly restate the preceding commission in the same main session and finish before the worker. Follow-up times are 1.396, 3.499 and 2.178 seconds. This proves session separation and contextual continuity, not actual file delivery.

Update, stop and clarification decisions are primarily recorded as plans in the probe; a new production request store and all action adapters are not implemented. Existing task runtime and channel regressions are reported in section 7.

## 4 Actual causes of the five failures

**Four clarifications expressed through reply.** One same-name-report attempt and all three unconfirmed-suggestion attempts correctly avoid guessing or treating assistant advice as user confirmation. Their prose is appropriate, but their submitted action is `reply`. The backend therefore cannot create a persisted clarification, waiting state and answer association.

The 0/3 unconfirmed-suggestion result is a structured-protocol failure, not three cases of adopting the suggestion. Original short assertion labels were too coarse. The evidence JSON preserves those labels and provides a reviewed diagnosis in `reviewedFailures` without rewriting outputs.

**One recovered standard without delegated execution.** The model correctly recovers relevance ordering, Chinese output and marker `ROUTE-JADE-7391`, but submits only a reply explaining the standard and asks again whether to begin. The user had already requested a briefing. Recovery is an intermediate step; the delivery action is missing. This is not a failure to find the old context.

A successful `commit_route` and valid schema guarantee a structured exit, not correct action semantics or complete coverage. A reply can still hide an untracked clarification or replace work that should have been delegated.

## 5 Design changes required before implementation

1. **Make answer and clarification contracts explicit.** Required information and object choices must become persisted questions associated with handling items, not only questions in reply prose. Refine schemas, examples and acceptance tests; a question-mark heuristic is insufficient.
2. **Account for every user goal.** Distinguish recovering a standard from producing the requested briefing. Decisions should identify handled, delegated, awaiting-input and unhandled parts. These fields are still model-produced and do not make semantic correctness a programmatic guarantee.
3. **Bound repeated retrieval.** Some simple routing samples search as many as 8 times. The unconfirmed-suggestion group searches 4–6 times and reads originals once. Add duplicate-query handling, read/token budgets and an empty-result strategy. Budget exhaustion must yield an honest limitation or clarification, not invented context.
4. **Use failure regressions to decide on review.** Keep the five failures as semantic and contract cases. If clearer contracts remain unreliable, evaluate targeted semantic review for reply-as-question or recovery-without-delivery. Do not unconditionally add another call to every message.

Repeat all nine actual-model scenarios after revision, retaining this baseline. Neither rerunning until green nor replacing semantic evaluation with fake-model calls establishes a fix.

## 6 Development failures and sample changes

All exploratory records remain in the evidence JSON; only designated final samples contribute to formal counts.

| Record | Cause and treatment |
| --- | --- |
| Initial mechanical probes fail before model dispatch | Missing plugin version causes DSH inventory-extension preparation to fail; adding required metadata fixes the fixture, not the model |
| Initial 80-turn seed raises a token-meter error | Historical assistant events lack corresponding step/start boundaries; add legal boundaries |
| An early runnable seed starts the next turn at 1 | Driver captures its counter before injection; formal tests persist, close and resume, verifying turn 81 |
| Early concurrency input asks to inspect sample materials without supplying them | Two clarifications are reasonable; the input cannot require delegation, so formal concurrency tests provide material and file-output requirements |

The actual ambiguous-reference and unconfirmed-suggestion protocol failures were not rerun away. Context and concurrency replacements address unsuitable experimental preconditions, with all earlier records and explanations retained.

## 7 Regression and coverage limits

All 48 relevant existing tests passed: `tasks-plugin.test.ts`, `task-runtime.test.ts`, `steer-plugin.test.js` and `steer-reports-dsh.test.ts`. Full `npm run typecheck` passed, including the new fixtures under strict `tsconfig.test.json` checking.

This work does not complete production UI gating, request/action database migrations, nonblocking application approvals, role rebinding on every recovery path, real FTS recall, image input, crash reconciliation or full macOS/Windows application acceptance. Workers perform only the safe step, so report quality, financial accuracy and file delivery are not verified.

Evidence supports refining the design and proceeding to an isolated R1 prototype; it does not establish R1–R3 completion, production activation approval or release readiness. Implementation still requires user agreement on the revised design.

The original checkout contains two unrelated, unregistered `memory-design` drafts; their contents and registration state remain untouched. An isolated PR worktree includes only this plan, report, evidence and probe. On that exact file set, full `npm test` passed 1162/1162, and `npm run typecheck`, `npm run check:i18n` and `git diff --check` passed.

## 8 Reproduction

Run from the repository root with the existing credential environment. Each invocation defaults to a fresh private temporary directory and prints report/event locations. Never use the everyday Viva DSH home.

```sh
# Real DSH with a fake model; no paid model calls
ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron test/fixtures/routing-feasibility/run.ts --repeat 3

# Existing DeepSeek v4.1 route, synthetic data only; current protocol can fail
ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron test/fixtures/routing-feasibility/run.ts --live --repeat 3

# Resumed 80-turn history only
ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron test/fixtures/routing-feasibility/run.ts --live --repeat 3 --only history-80-session
```

`--out` selects a new experiment output directory; `--only` takes comma-separated scenario IDs. Live mode incurs model usage charges. Credentials are reused only in process memory and child environments, never written to reports or command arguments.

## 9 Supplementary validation

The supplement targets the first round's weak points in three layers. Summarized evidence is in the [supplementary results](agent-routing-supplement-results.json).

**Deterministic set.** Real DSH, production plugins and a scriptable fake model, three runs each ([probe](../test/fixtures/routing-feasibility/supplement/run.ts)). Forbidden calls in the same step (before routing, after routing and after a reply) were denied 9/9 and no forbidden body ran. Interjected requests were tracked on their own, repaired only for themselves when omitted, and no text was released while one was pending, 6/6. Duplicate submissions and inconsistent plans were rejected 6/6. Unbound sessions were refused before their first step, 3/3. For visible output, the unchanged production stream passed 0/9 leak checks (control), dropping unauthorized attempts whole passed 3/9, and keeping start and settle with emptied content passed 9/9. The first-round probe narrowed tools in `pre-step`, so the first request still carried all 49 tools; binding at creation left 10.

**Bridge-level actual-model set.** Production persona, production plugins and default thinking, five runs per cell. With the v2 protocol, ambiguity, an unconfirmed suggestion, retrieval of a corrected standard, recovery after real compaction of a long session (the summary kept the corrected version), task updates, mixed requests, ordinary streaming and interjection each passed 5/5. In an empty workspace, "make a brief" asked for the source material first in 5/5; the production baseline also asked first and delegated 0/5. The first round's v1 protocol under the production configuration passed ambiguity 5/5, the unconfirmed suggestion 5/5 (one check false positive) and retrieval 4/5 (one reasonable follow-up question), so the first round's four clarifications given as replies came mainly from the experimental configuration. For the interjection, the production baseline handed over 0/5 times; all five tried the web inside the main session and wrote a report outline there. Median time to first text was 3.9 seconds, against 1.4 in production.

**Real-app set.** The Electron app with its real renderer, database and TaskRuntime, synthetic meeting notes in the workspace ([scenarios](../test/smoke/live-scenarios-routing.ts)), five runs each:

| Scenario | Result | Data |
| --- | --- | --- |
| Ordinary answer | 5/5 | First text in 2.4 to 4.2 s; no routing traces in the database or window |
| Brief from the notes (proactive handover) | 5/5 | Conversation free after 7.5 to 17 s; the task's brief carries the notes' issue numbers and owners |
| Add a risks section to the brief | 5/5 | Always sent to the original task |
| Interjection mid-answer (fast lane) | 5/5 | Task card after 1.5 to 2.0 s; 10.5 to 18 s without the fast lane |
| Interjection "say it in English" | 5/5 | No task started; the answer continued in English |
| "The usual rules" in a new topic | 5/5 | The corrected rules were recovered and written into the brief |
| Stop a task just started | 5/5 | The card shows stopped |
| Remind me every Friday | Function 5/5 | While the proposal card waited, the conversation went on; once confirmed, it showed in Coming up. The check required a test suffix in the title, which the model rewrote, so the report counts these as failures |
| Remember my manager | 5/5 | Written by `app_action`; a new topic answers |
| Add an MCP server | 0/3 | The approval was cancelled with the turn; with an executor task the approval appeared, but the configuration channel refused the task session |

Replaced runs are kept with their reasons: attempts of one run shared the task list and filled the task places (now each attempt has its own material and stops its tasks when it ends), and one run's argument check read the schema wrongly (fixed and rerun).

New findings are written into section 17 of the proposal: binding timing, the output gate, a restricted scope unable to run application tools on the agent's behalf, approvals unable to outlive their turn, invalid JSON tool arguments leaving requests silently unrouted (9 times), telling the user when task places are full, and several versions of one rule in long-term memory, of which the wrong one was picked once.

On the PR revision with the supplement, `npm run typecheck`, `npm test` and `npm run check:i18n` pass.

```sh
# Deterministic set; no paid model calls
ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron test/fixtures/routing-feasibility/supplement/run.ts --suite mech --stream gated --repeat 3

# Bridge-level actual-model set
ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron test/fixtures/routing-feasibility/supplement/run.ts --suite live --protocol v2 --stream gated --repeat 5

# Real-app set
VIVA_ROUTING=1 VIVA_ROUTING_FAST=1 npm run live -- --only route-reply,route-handoff,route-update,route-interject,route-interject-correct,route-history,route-stop,route-schedule,route-memory,route-mcp --repeat 5
```

The real-app set uses its own temporary profile and never reads everyday data. Every actual-model run incurs usage charges.

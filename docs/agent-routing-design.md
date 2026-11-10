# Viva Main Agent Routing and Task Dispatch Plan

English | [简体中文](agent-routing-design.zh-CN.md)

Status: being implemented, reorganized from three rounds of validation. Date: 2026-11-09. Baseline: `6e8265b`. Evidence is in the [feasibility report](agent-routing-feasibility.md) and the [results summary](agent-routing-supplement-results.json). The validation prototype was removed before implementation. Viva is still in development, so routing is the main conversation's only path: there is no switch, and earlier storage or protocols are not kept compatible (section 13). This plan revises how the [system design](system-design.md) divides work between the main conversation and background tasks.

Viva's main agent understands the user, recovers relevant background, dispatches work and reports results; work such as web research, commands and file writes is done by independent tasks. Every user request must produce a handling decision the host can check. The runtime guarantees that routing happens; context mechanisms and actual-model acceptance test whether the understanding is right.

## 1 Goals and scope

### 1.1 Goals

1. Independent work goes to tasks and the main conversation stays free; the user can keep talking while a task runs.
2. Additions, changes and stops reach the right task, and no task is started twice.
3. Agreements made dozens of turns ago or in another topic, and later corrected, are recovered and followed in their latest valid version.
4. When the user interjects mid-answer, they quickly see where the request went; the result may come later.

### 1.2 First-release scope

| Capability | Sections |
| --- | --- |
| Request ledger and enforced routing: every request (interjections included) gets a decision, omissions get bounded reminders, failures are told plainly | 5, 7, 8 |
| Layered narrowing of the main session's tools | 7 |
| Answers, clarification and the output gate | 8 |
| Task handover: new, addition, stop, several things in one sentence | 10 |
| Fast lane for interjections, and recovering from misrouting | 9 |
| App operations: schedules, memory, MCP and skill configuration, through the existing tools and confirmations | 10.3 |
| Durable requests, decisions and actions; reconciliation after disconnects and crashes | 11 |

### 1.3 Not in scope

| Not done | Why |
| --- | --- |
| Vector index, a separate item database | Conversation search, memory and compaction summaries already recover corrected agreements (section 15); reconsider on recall failures seen in acceptance |
| Task queueing, automatic dependency graphs | Keep five concurrent places and say so plainly when they are full |
| Preempting the current answer | DSH can only cancel a whole turn, and output of the new turn after a cancel never reaches the window; the fast lane meets the responsiveness requirement for interjections |
| Withdrawing sent additions, rolling back task changes, task snapshots | Need new DSH or task interfaces; the first release recovers with visible destinations, stopping and correction (9.2) |
| Letting configuration that needs confirmation leave the main session | The first release keeps today's behaviour (10.3); a standalone confirmation card is later work |
| Lowering reasoning on the routing step to shorten time to first text | About 2.5 more seconds to first text is accepted |
| Tuning for other models | The first release only promises behaviour on accepted models; other models need acceptance before they are enabled |

### 1.4 Confirmed decisions

- Implementation is in `viva-main`. The main agent keeps the continuous conversation and may search conversations, memory and tasks and read relevant files.
- Ordinary answers keep streaming: `reply` is committed first, then the answer is generated; about 2.5 more seconds to first text is acceptable.
- Interjections need a quick response; the result may be slow.
- Asking for the source material when it is missing is correct behaviour, not a routing failure.
- Configuration that needs confirmation keeps today's behaviour in the first release: the main session waits for the user.

### 1.5 To be confirmed

- Tools of MCP servers the user has added are no longer called by the main session directly; a task calls them and the main session does not wait. This changes the experience.

## 2 Problem and current behaviour

When the user asks for today's brief and then for an A-share analysis, the two independent jobs should run separately; "add tech news to the brief" should go to the brief task; "use the standard we agreed earlier" needs the agreement recovered before deciding what to do.

Today the main session holds every execution tool. What the user says while it is busy joins the running turn, and the persona says to "finish the other thing too, then continue the original work". In validation, the production configuration given "also do a full A-share analysis" mid-answer tried the web inside the main session and wrote a report outline there in all five runs, handing over 0 times; it starts a task only when told explicitly to "do it in the background".

| Place | Today | Change |
| --- | --- | --- |
| [conversation actions](../src/renderer/conversation-actions.ts) and [compose](../src/backend/compose.ts) | Prompt or steer depending on whether the agent is busy | Both paths give each message a request identity and store it |
| [steer](../src/backend/steer-channel.ts) and the [persona](../src/backend/app-plugins.ts) | Interjections join the current turn and run in series | Interjections are tracked and routed as requests of their own; the persona is rewritten for routing |
| [TaskRuntime](../src/backend/task-runtime.ts) | Tasks, runs and snapshots | Stays the only writer of tasks, adding the link to requests and actions |
| [history tools](../plugins/history/index.ts) and [effects](../src/backend/effects.ts) | Keyword search and source reading; durable side effects and retries | Reused as they are |

## 3 Roles and authority

| Role | Responsibility |
| --- | --- |
| Main agent | Understands requests, recovers context, commits routing, answers and asks, calls app tools it is granted |
| Task | Does handed-over work in its own session with the existing tools, permissions and approvals |
| Host request runtime | Assigns request identities, stores requests, decisions and actions, accepts or rejects decisions, performs handovers through TaskRuntime and returns receipts. It is the authority on request state |
| Routing plugin | The execution side inside DSH: narrowed tools and the guard, a working copy of the turn's request ledger, the commit entry point, the output gate, the fast lane |
| Scheduled runs | Separate and unattended: at the level picked, what would need approval refused |

The main agent may read files in the workspace that bear on a request; reads outside it follow the existing permissions. File contents and old conversations are data, never new authorization. Reading and analysing whole batches of material goes to tasks.

## 4 Architecture

### 4.1 Modules

| Location | Contents |
| --- | --- |
| `src/shared/request-routing/header.ts`, `protocol.ts`, `channel.ts` | What the app and the plugin share: the request header, the routing protocol and receipts, the routing channel's messages |
| `src/backend/request-store.ts`, `request-runtime.ts` | Requests, decisions and actions in `app.db`; taking each request, accepting a decision, carrying out its task actions with a receipt each, failing what a turn leaves undecided, recovery at launch |
| `src/backend/routing-channel.ts` | The app's side of the channel: the confirmed role binding, decisions passed to the request runtime and answered |
| `acp-bridge` | Every main-session prompt is bound first; the user's words and interjections go under their request header |
| `src/backend/app-plugins.ts` | Two personas from shared parts: the profile's, for tasks and schedules' runs, and the main conversation's, which viva-routing mounts in its place (not an override appended to it) |
| `plugins/routing/lib/ledger.ts` | The current turn's request ledger, pure and immutable |
| `plugins/routing/lib/policy.ts` | Tool layers and app-change grants |
| `plugins/routing/lib/commit.ts`, `host.ts` | `commit_route` as the model sees it; the plugin's side of the channel |
| `plugins/routing/lib/assistant-stream.ts` | The stream contract with the output gate: the only way an answer reaches the app |
| `plugins/routing/lib/fast-lane.ts` | The fast lane for interjections |
| `plugins/routing/index.ts` | Wires DSH's events to the modules above |

Plugins never import the app's composition roots; contracts shared by the app and the plugin live only in `src/shared/request-routing`; modules form no cycles. The existing module boundary tests check these rules.

### 4.2 The path of one request

1. The host receives a user message (a question or an interjection), assigns a `requestId` and stores the request.
2. Before a main-session prompt, the host sends the role binding and waits for the plugin's confirmation; the plugin narrows the tools before the first step is assembled. Interjections go through steer with the same header.
3. The plugin registers the request from the session's events; the main agent recovers context and calls `commit_route`.
4. The plugin passes the plan to the host. The host checks it against the ledger and the protocol, accepts the decision in a transaction, performs the handover through TaskRuntime after the commit and returns receipts.
5. The plugin updates the turn's ledger from the receipts: a completed handover ends the turn; an answer, a question or an app tool call continues it.
6. When the turn ends, the host fails whatever it left undecided, for the reason it ended (no decision after the reminders, an error, a cancel), and tells the user unless they cancelled.

## 5 Request intake and ordering

- The window, the desktop island, text and pictures share one entry point. Answers to permission cards and task questions, and stopping the current answer, are control events, not new requests.
- A request record holds: `requestId` (generated by the host, reused on retry); `conversationId`, `sessionId` and `cwd` (fixed on receipt; asynchronous work never reads the currently selected topic); `messageId` and content version; attachment references; order of receipt and state.
- The request header is `【请求 ID：…】` followed by a new line and `用户原话：…`, the same for questions and interjections.
- One main session understands and decides requests in the order received; the main agent has a single sequential model session. A new message is handled by the main agent after the current step ends, or handed over at once by the fast lane (section 9); it never waits for background tasks.
- Stopping the current answer cancels only the main agent's current call, never background tasks.

## 6 Context recovery

The main agent keeps the history still available in its session and uses DSH's compaction. Background beyond what is visible is retrieved from conversation history and memory:

1. Check references, constraints and goals against the current message, the continuous history and task snapshots.
2. When that is not enough, search topics, messages or memory, changing keywords as needed; one empty result does not mean there is no record.
3. Read the source of a hit and the messages after it, check whether the agreement was changed or cancelled, and follow the version the user confirmed last.
4. When several candidates are equally plausible and a wrong choice would change the result, ask; never default to the newest or a same-named task.
5. The handover brief states which agreement it follows and where it came from.

The assistant's earlier suggestions are not user confirmation, and old instructions are not current authorization. Long-term memory may hold several versions of one rule; on conflict, the source the user confirmed last wins (validation once picked the wrong one). Deleted or forgotten material is reported as unavailable, and routing records never copy its text.

## 7 Tool layers and runtime constraints

### 7.1 Layers

The main session's tools come in five layers, defined in one place, [`plugins/routing/lib/policy.ts`](../plugins/routing/lib/policy.ts):

| Layer | Tools | Rule |
| --- | --- | --- |
| Route | `commit_route` | Called for every request |
| Context | Conversation search and reading, `memory_recall`, task queries, read-only file tools | Always available |
| App query | `schedule_list`, `viva_mcp_list`, `viva_skill_list` | Always available |
| App change | Creating, changing and deleting schedules; remembering and forgetting memories; adding, changing, removing and importing MCP servers and skills | Visible to the model; the turn must first commit the matching `app_action`, and the guard lets the call through on that grant, one call per grant |
| Execution | Shell, file writes, web, sub-agents, the background-task tools, MCP servers' tools and everything else | Out of scope; such work goes to a task through `commit_route` |

App tools stay in the main session's scope, so they keep DSH's argument check, approval cards, key windows and observers, and no new DSH interface is needed.

### 7.2 Constraints

- Narrowing happens before the first step is assembled. The host binds the role and waits for confirmation before every main-session prompt; new, prewarmed, resumed and switched sessions all go through the same binding. Narrowing only in `pre-step` leaves every tool in the first request; validation saw calls to `bash` that way.
- Every call of the main session is decided again by the same layers in `tools/pre-execute`, before DSH asks the user to approve it: a call outside the scope still reaches approval by its name, so a refusal there means no approval card ever shows for it. This also covers tools registered in the scope later; newly installed plugins never gain main-session permissions by themselves.
- App changes need a grant from an `app_action` accepted in the same turn, one call per grant; unused grants are dropped when the turn ends.
- Tasks and scheduled runs are not narrowed and keep their permissions and approvals.
- An omitted decision gets at most two reminders. When the turn ends, the host fails each request it left undecided and tells the user; a turn ending in an error (for example, the model produced tool arguments that are not valid JSON) fails them the same way, so nothing is left silently. Cancellation fails them without a message and gets no reminders; requests a stopped app left undecided fail at the next launch.

## 8 Routing protocol, answers and the gate

### 8.1 Protocol

`commit_route` submits goals (where each goal of the sentence goes) and actions:

| Disposition | Action | Contents | Result |
| --- | --- | --- | --- |
| answer | `reply` | Scope of the answer | Answer at the next step |
| delegate | `start` | A self-contained brief | A new task |
| update_task | `message` | Task ID and addition | The task is told, or resumed |
| stop_task | `stop` | Task ID | The task's current run stops |
| needs_input | `clarify` | Question and options | Ask at the next step, then wait for the answer after the turn |
| app_operation | `app_action` | The app tool's name | The main agent calls that tool at the next step |

A handover also carries a `notice`, one line for the user: once the handover is done, the plugin shows it as the turn's answer and ends the turn, with no further model call; it is only shown, never part of the host's decision record. Without one, the main agent says it at its next step. Goals and actions must agree both ways; the host checks and rejects a mismatch with its reason. The protocol stays flat: an `app_action` names only the tool, and the arguments go to the tool's own call; nested free-form arguments made the model produce invalid JSON. A request takes one decision only; the user's corrections arrive as new requests referring to the original action.

### 8.2 Answers and questions

Once a `reply`, `clarify` or `app_action` is accepted, the request may show text in that turn. When a new turn starts, leave to answer ends, a question turns into awaiting its answer, and the user's answer arrives as a new request. The first release shows a clarification as question text only and records it as awaiting in the ledger; no new question card is added.

When a handover fails (for example, all five places are taken), the turn does not end; the request becomes an answer, and the main agent says plainly what was not done and why.

### 8.3 Output gate

Only steps after leave to answer was given show text, and nothing shows while a request is undecided; a turn with no request (a task result coming back) speaks freely. A streaming attempt of an unauthorized step keeps its start and settle and only empties its content. The app never shows ACP's copy of the text: a call whose output the plugin did not confirm withdraws what it showed and ends in an error. Neither the window nor the conversation database shows request headers, routing JSON or dispatch notices.

## 9 Interjections

### 9.1 Fast lane

When an interjection arrives, the plugin makes one model call without reasoning, given the recent conversation, the task list and the interjected words, and hands over directly in only two cases: the words are clearly a new, independent job; or they are clearly an addition to, or a stop of, exactly one task. Everything else (a correction to the current answer, an ordinary question, an unclear reference, anything that needs history or confirmation) goes back to the main agent after its current step. After a handover, a notice is injected into the main session so the agent does not submit the request again and mentions it at the end of its answer. Fast-lane handovers use the same task interface and task ID checks as the main session.

On a handover the model gives a task name (the card's title; the start of the words when it gives none) and a brief. The user's words are always appended to the brief as said, because the model's paraphrase can drop exact requirements such as a file name or a format. A short brief is no reason to defer. Each fast-lane outcome is recorded as a `request.fast` event: the outcome (handed, deferred, already taken by the main agent, failed), a defer reason code (the model's own choice, or which field of its output was invalid) and the time taken, without the words.

In validation, the fast lane decided in about 1.4 seconds and the task card appeared in 1.5 to 2.8 seconds (once 6.4 seconds in 15 runs), against 10.5 to 18 seconds without it. With the words appended and the task name as its own field, the interjection scenario handed over through the fast lane in 5/5 runs, with the task card after 1.2 to 3.2 seconds. Corrections to the current answer went back to the main agent in 10/10 runs.

### 9.2 Recovering from misrouting

- Prevent: hand over directly only on a unique match; task IDs must come from the tasks the host listed.
- Show: every handover immediately shows where it went, as a task card and one sentence.
- Correct: when the user points out a mistake, a new request refers to the original action; a task started by mistake is stopped, and a misplaced addition is followed by a correction to that task.

Withdrawing unread additions, rolling back task changes and task snapshots are out of first-release scope (1.3).

## 10 Task handover and app operations

### 10.1 Handover

TaskRuntime is the only writer of tasks. A task starts from the conversation on screen, which during a turn is the request's own (switching topics is refused while a turn runs); only tasks of the request's working folder can be stopped or messaged. A brief is self-contained: the user's words, the goal, the agreements found and their sources, files and output requirements; a summary of old background never replaces the original reference.

### 10.2 Places

At most five tasks run at once. When all places are taken, the action returns a clear failure and the user is told; there is no queue, and the work never falls back to the main agent.

### 10.3 App operations

Changes to schedules, memory, MCP and skills are made by the main agent calling the original tool after its `app_action` is accepted; the argument checks, approval cards, key windows and results are unchanged. Schedule proposals do not block the conversation; configuration that needs approval keeps the main session waiting in the first release, as today. Plugin management is outside the main session's scope. If confirmation should later leave the main session, the preferred way is an app-side proposal card (the pattern `schedule_create` already uses), which needs no DSH change.

## 11 Durability and recovery

`app.db` gains request, decision and action records, reusing the existing event transactions and effects. The host's records are authoritative on request state; the plugin's ledger only tracks the current turn.

| Object | Contents |
| --- | --- |
| Request | Session, topic and working folder at receipt, kind (question or interjection), order of receipt, state, reason for failure; never the words |
| Decision | Goals and actions as accepted |
| Action | Execution state, the task it concerns, the error of a failure |

Decisions are accepted in a transaction with their events (ids and kinds only), and task actions run after the commit, each receipt kept with its event. Exactly-once cannot be guaranteed when the app stops after a task action and before its receipt is kept: the next launch marks such an action uncertain and never sends it again; actions of the same decision that already succeeded are not redone. Routing records keep no model reasoning and none of the user's words.

Not done yet: reconciling an uncertain action from the task and session links and telling the user about it (it is only logged); clearing routing records when a topic is deleted (they hold the topic's id, not its words).

## 12 Reports and control events

Reuse [task reports](../src/backend/task-reports.ts) and their effects queue, keeping deduplication per task and run, read confirmation and cross-topic origin. A completion notice is a typed event, not a new user request, and never starts a task. The main agent reports results at a suitable moment; the user's new messages come before a report that has not started.

Stopping the current answer affects only the main agent's current call; stopping background work must name the task, and "stop everything" needs the user's intended scope first. Answers to approvals and questions go back to their original task, regardless of where the user is looking.

## 13 Delivery batches and acceptance

Viva is in development, so routing replaces the main conversation's old path outright, with no switch and no compatibility layer. The main session can no longer run commands, write files or start tasks through tools, so the first delivery has to carry everything that path used to do: R1, R2 and the app operations of R3 land together, and the task tools the main agent no longer has (`start_background_task`, `stop_background_task`, `message_background_task`) are removed rather than left unused.

| Batch | Delivery | Acceptance |
| --- | --- | --- |
| R1 | Host request runtime and storage; request header and role binding; layered narrowing and the guard; `commit_route` and the ledger; `reply` and the output gate; reminders and failing what a turn leaves undecided | Ordinary answers 5/5 in the real app, no forbidden calls, no routing traces in the window or database; requests intact after a restart; deterministic tests for same-step forbidden calls, unbound sessions, omissions and error endings |
| R2 | Handover (new, addition, stop, several in one sentence); clarification; context recovery; fast lane and misrouting recovery; task result reports (a completion notice is a control event, not a new request) | Matching scenarios of 13.1 each 5/5; median time from interjection to task card under 3 seconds |
| R3 | App operations (with R1 and R2); crash recovery's uncertain actions (with R1 and R2); the open items of section 11; Windows and full regression | Schedule, memory and MCP scenarios each 5/5; uncertain actions are not resent after a crash; full smoke on macOS and Windows |

### 13.1 Actual-model acceptance scenarios

Real-app scenarios ([`test/smoke/live-scenarios-routing.ts`](../test/smoke/live-scenarios-routing.ts)): an ordinary answer; a brief from workspace material (proactive handover); an addition to a running task; an interjection handing over new work mid-answer; an interjection correcting the current answer; following a corrected agreement in a new topic; stopping a task just started; a weekly reminder; remembering a fact; adding an MCP server.

Before R2, scenarios validated at the bridge level in the first round and the supplement join the real-app set: ambiguity between same-named tasks, an assistant suggestion the user never confirmed, and recovery after compaction of a long session.

Measurements: receipt to decision, decision to handover, time to first text, interjection to task card, tokens, kinds of routing failure, reminders, error endings.

Before each batch's commit, run the relevant tests, `npm run typecheck`, the full `npm test` and `npm run check:i18n`; batches touching IPC, sessions or storage run `npm run build` and `npm run smoke` locally before the PR, and the PR's current-commit CI on macOS and Windows decides.

## 14 Risks

| Risk | Detail | Response |
| --- | --- | --- |
| Only one model validated | All actual-model acceptance ran on DeepSeek Flash | Rerun 13.1 before enabling other models |
| No actual-model acceptance on Windows | CI covers deterministic tests and smoke only | An R3 acceptance item |
| Unknown recall of production search on real history | Validation used synthetic data | Watch recall failures before deciding on an index (1.3) |
| Several versions of one rule in long-term memory | The wrong one was picked once | Section 6 follows the source the user confirmed last; covered by R2 scenarios |
| Several identical `app_action`s in one commit | 2/5 in the schedule scenario | Reword the protocol; spare grants are already dropped at the end of the turn |
| Persona conflict | The original persona says to do the work and names the background-task tools | The main conversation's persona is built from the shared parts plus the routing rules and mounted in place of the profile's, never appended to it |
| Cost of the fast lane | One more model call per interjection | Triggered only by interjections; watch tokens |

## 15 Evidence

| Round | What | Result |
| --- | --- | --- |
| First round | Isolated probe, reduced persona, reasoning off | Mechanisms 12/12; structured contract 22/27, failing mainly by clarifying through `reply` ([report sections 1–8](agent-routing-feasibility.md)) |
| Supplement | Deterministic set, bridge-level set with the production configuration, real-app set | All deterministic checks passed (same-step forbidden calls, interjection tracking, the gate, binding); the first round's clarification failures disappeared under the production configuration; constraints found on binding timing, the gate, app operations and approvals, and invalid JSON (report section 9) |
| Layered narrowing | Real app, 10 scenarios five times each | 50/50; forbidden calls 0, routing failures 0; app operations done by their own tools on a grant in 15/15; MCP setup 6.8 to 10.3 seconds per turn (report section 10) |

This document does not authorize implementation. Before R1, the item in 1.5 needs confirming and this plan needs approval.

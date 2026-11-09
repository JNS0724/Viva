# Viva Main Agent Routing and Task Dispatch Plan

English | [简体中文](agent-routing-design.zh-CN.md)

Status: design review draft, not approved for implementation. Date: 2026-11-09. Target checkout: `viva-main`. Current implementation baseline: `0fc159bd8dbbb42bfbcf05ee5f9150dbb9df426b`. This proposal changes the foreground and background responsibilities described in [System design](system-design.md); it does not describe shipped functionality.

Viva's main agent maintains the conversation, recovers relevant context, delegates work, and communicates results. Independent tasks perform web research, commands, and file writes. Every user request must produce a backend-validated handling decision, including ordinary conversation. Runtime checks guarantee that routing occurs; context recovery and actual-model evaluation establish whether the decision is correct.

## 1 Confirmed boundaries and review scope

| Category | Decision |
| --- | --- |
| Confirmed | Implement in `viva-main`, not the `my-agent` checkout originally attached to this chat |
| Confirmed | The main agent retains continuous context, searches conversations, memory and tasks, and may read relevant files; workers perform web research, commands and file writes |
| Confirmed | Ordinary answers remain streamed, after an accepted `reply` decision |
| Architectural direction | Every user request passes through a routing submission; the main agent understands and delegates, workers execute independently, and context may come from dozens of turns earlier |
| Proposed first release | Reuse history, memory, TaskRuntime, event transactions and effects; retain the existing limit of 5 active tasks |
| Proposed first release | Add no vector database, general task queue, automatic dependency graph or separate database of authoritative matters |
| Pending | First-release scope, delivery batches and the product and technical choices in section 15 |

Clarification, ordinary answers and delegated work are different behaviors. Neither every message becoming a background task nor every mid-turn message becoming a correction to the current work is appropriate.

## 2 Problem and current implementation

A daily briefing followed by an A-share market analysis should create independently executing work. Adding technology news should update the briefing. “Use the earlier criteria” requires recovering the agreement before choosing an action.

The user has confirmed that explicitly asking to run work in the background succeeds. The problem therefore concerns proactive delegation and context association; this observation alone does not establish why the model made a particular decision in a particular failed example.

| Location | Current behavior | Required change |
| --- | --- | --- |
| [Conversation actions](../src/renderer/conversation-actions.ts) | Chooses `prompt` or `steer` from busy state; images have additional busy-state restrictions | Submit all user messages through one backend entry point |
| [Compose](../src/backend/compose.ts) | Receives foreground prompts and steering separately; wires tasks and application operations | Admit persistent requests and fix their source and ownership |
| [Steer channel](../src/backend/steer-channel.ts) and [persona](../src/backend/app-plugins.ts) | Mid-turn words enter the running turn; instructions say to finish another item and then continue the original work | Track independent requests and require delegation decisions before execution |
| [TaskRuntime](../src/backend/task-runtime.ts) | Owns tasks, run IDs, storage and snapshots | Reuse execution and add request-action links and explicit origin context |
| [History tools](../plugins/history/index.ts) and [reader](../src/backend/history-reader.ts) | Keyword search and nearby text; the underlying reader already supports pagination | Expose continued historical reading to the main agent |
| [Effects](../src/backend/effects.ts) | Durable effects, generations and retries | Reuse the queue with routing-action idempotency and reconciliation of uncertain outcomes |

Instructions to finish interjections and to end the current turn after starting a task leave ambiguity when unrelated work arrives before the original work ends. Prompt changes help, but do not replace request tracking or execution constraints.

## 3 Main agent and executors

Retain the existing main session per topic rather than starting a classifier with incomplete history for each sentence. Retrieve relevant context from other topics when needed. Tasks retain the origin of the request that started them.

| Role | Responsibilities and permissions |
| --- | --- |
| Main agent | Understand requests, read context, submit decisions, answer ordinary questions and report results; no execution tools by default |
| Worker task | Complete a delegated goal in an independent session under existing permissions and approvals; reread referenced context when needed |
| Backend request runtime | Admit and persist requests, validate and accept decisions, dispatch actions, and own request state and receipts |
| Application operation executor | Perform memory, configuration and scheduling operations through existing tool and confirmation pipelines |
| Scheduled task | Retain existing independent execution and unattended permissions; gain no capability from this change |

The main agent may read workspace files relevant to understanding the request. Reads outside the workspace retain existing permission rules. Files and old conversations provide context, not new authorization. Lengthy reading or analysis of a document collection should itself be delegated, so the main agent does not become another long-running worker.

## 4 Request admission and ordering

Introduce a unified submission contract for the window, desktop island, text and images. Approval answers, task-question answers and explicitly stopping the current reply are control events bound to their original objects, not new requests for classification.

Bind the following information when the backend admits a request:

| Field | Meaning |
| --- | --- |
| `requestId` | Unique client-generated ID retained across retries; backend validates identity and uniqueness |
| `conversationId`, `sessionId`, `cwd` | Validated origin topic, main session and working directory |
| `messageId` and content revision | Original user message; edits produce a new revision that stale results cannot overwrite |
| Attachment references | Durable image and file identities, not temporary UI paths |
| `inReplyTo` | Optional clarification or related-request reference validated by the host |
| Order and state | Backend-assigned receive order, processing state and failure information |

Merge UI message display and persisted requests by the same identity. Reconnects and network retries must not create duplicate work. Asynchronous dispatch uses the captured origin instead of consulting whichever topic is currently selected.

Understand and commit requests in receive order within a main session; do not concatenate them into an anonymous interjection. There remains one sequential model session. In the first release, new messages may wait for the current understanding step or streamed answer, but must not wait for worker completion. Explicitly stopping the current answer cancels that main-agent call without implicitly stopping workers.

A task-creation action must reach a confirmed handoff outcome before subsequent requests can reference the created task. Startup may include connecting MCP servers; measure startup separately from execution and do not promise zero dispatch latency.

## 5 Context recovery

Resolve context before selecting actions. Keep history still available in the main session and retain dsh's compaction behavior rather than imposing a recent-turn cutoff. Read persisted history for information no longer visible.

1. Compare the current message, continuous history and relevant task snapshots to determine whether references, constraints and goals are clear.
2. Search candidate topics, messages or memories when context is missing. Reformulate keywords; one empty search does not prove that no record exists.
3. Read original messages and later changes to check whether an agreement was modified, cancelled or scoped. Expose pagination and continuation information.
4. Record the message references, memory revisions, file versions or task run IDs used for the decision.
5. Clarify when multiple candidates remain plausible and the choice changes the outcome. Do not default to the newest task or a similar title.

A matter under discussion need not already be a worker task. Recover unexecuted plans and agreements from conversation records without manufacturing task records. The first release does not create a new matters database for every turn; evaluation failures can justify a derived index later.

Preserve source role and sequence. An assistant suggestion is not user confirmation, and an old instruction is not renewed authorization. A later message only supersedes an earlier decision when it actually changes the same decision, not simply because its timestamp is newer.

The interface to long-term memory is recall with provenance and applicability. This proposal neither implements its migrations early nor requires its entire rollout. Replace the recall adapter when that Runtime becomes available rather than maintaining a second source of factual truth. Deleted attachments, files or forgotten memories remain unavailable; copying their contents into routing records must not defeat deletion.

## 6 Routing submission protocol

Add `commit_route`. The model may perform multiple context-retrieval steps, but must submit a valid decision for every admitted user request delivered to it. The host binds the request ID, session, revision and processing identity; a model-supplied ID alone is insufficient.

| Action | Required information | Backend behavior |
| --- | --- | --- |
| `reply` | Answer scope and supporting references | Open the ordinary answer stream for that request |
| `start` | Goal, complete brief, constraints, context and attachment references, delivery criteria | Create an independent task through TaskRuntime |
| `message` | Task ID, run reference or state revision, user instruction and context | Supplement, start the next turn or resume according to actual state |
| `stop` | Explicit task and target run | Stop that run; a stale stop must not cancel a later run |
| `clarify` | Missing object or condition, question and handling item | Persist the question, display it and release the main agent |
| `app_action` | Enumerated application capability with typed arguments | Execute through existing tool and confirmation pipelines |

Version the protocol and validate a TypeScript discriminated union with Zod. Bound action counts, text, references and attachments. `app_action` must not pass through arbitrary tool names, code or shell commands.

One request can have several handling items. “Make the briefing English and also analyze A shares” contains an update and a new task. Give each item a stable `actionId`, state and receipt. An independent, understood item need not wait for clarification of another. Do not assume parallel execution when work has dependencies or shared write targets; use explicit sequencing or clarification in the first release rather than an automatic dependency graph.

Accept the decision and action plan in a transaction; execute external actions after commit. Repeating the same decision for a request revision and handling item returns existing receipts. A different decision cannot overwrite that item’s accepted plan. Later user corrections are new requests referring to the previous action or task. When additional handling is needed, the host first registers a new continuation item linked to the original request and parent decision, then accepts a separate decision for it. The model cannot invent handling-item identities.

## 7 Runtime enforcement and role binding

Add a routing plugin and acknowledge session-role binding before the first prompt. New, prewarmed, resumed, switched and forked sessions use the same binding path. Do not infer roles from session titles or the model's own declarations. An unbound session cannot start execution.

The current DSH interfaces support these constraints:

| Interface | Purpose |
| --- | --- |
| `tools.restrict` | Reduce global tools visible within an agent scope |
| `tools.guard` | Check role, phase and request authorization at execution, including scope-local tools and other invocation paths |
| `agent/pre-step` | Supply admitted requests and their identities to the current step and refresh handling state |
| `agent/turn-stopping` | Check unresolved requests before a normal end and inject a bounded request to submit missing decisions |
| Tool result `concludesTurn` | End handoff-only turns after submission rather than waiting for worker results |

Visibility filtering does not cover every scope-local registration, so execution guards are also required. Newly installed plugins gain no execution permission in the main agent automatically. Role checks add restrictions to the existing sandbox and approval pipeline without loosening file access, external-send or unattended rules.

Check same-step concurrency too: an execution call queued before routing must not acquire permission merely because another parallel call committed a route. An application-operation grant binds a specific request, action, tool and arguments rather than temporarily opening all tools.

Only undecided handling items already delivered to the model participate in omission checks. Items awaiting user input, already handed off, or generating an authorized answer are not omissions. Propose at most two attempts to submit an omitted decision. Do not repair automatically after explicit cancellation, disconnect or lifecycle shutdown. Persistent failure retains the request and reports failure. The backend independently validates terminal state instead of trusting plugin notifications alone.

## 8 Ordinary answers and streaming

After accepting `reply`, continue the ordinary answer in the next model step of the same session, preserving history and streaming. The request gains no web, command or write permission. Measure the extra model step's latency and token cost separately.

Do not publish main-agent free text generated before routing as a final answer. The UI may show controlled progress status, but not routing JSON or internal reasoning. Tag answer streams with request and attempt identities so stale fragments after cancellation or retry cannot append to a new answer.

`reply` opens an answer; it does not complete it. Preserve visible partial text and mark interruptions. If execution becomes necessary while answering, finish or mark the current answer interrupted at a model-step boundary, register a continuation item through the host, and submit its separate route linked to that answer. Do not rewrite the old decision or invoke execution tools implicitly.

Statements such as “started” do not complete requests. Confirm task creation, message delivery and application changes from execution receipts, and report real failures. Distinguish received, starting and started so a plan is not presented as completion.

## 9 Clarification and application operations

A main-agent `clarify` must not use a long tool invocation that blocks the main session waiting for the user. Bind questions to request, handling item and revision, display them, and allow the current main-agent call to end. Other work remains admissible.

Question-card answers supply host-validated `inReplyTo`. Interpret free-text replies against unresolved questions and clarify further if association is ambiguous. A request waiting for input must not block other admitted requests. Existing worker questions and approvals remain owned by that worker.

Explicit memory changes, MCP and skill configuration, plugin management and schedules must remain available after reducing main-agent tools. Use a closed application-capability mapping that preserves original argument validation, permissions, confirmations, secret entry and receipts. Application operations waiting for confirmation keep independent operation state instead of occupying the main session indefinitely; this is an R3 integration boundary to verify. Credentials remain in their existing input flow and never enter route briefs or conversation text.

## 10 Action execution and context handoff

TaskRuntime remains the sole task writer. Reuse run IDs, capacity reservations, snapshots and persistence. The request runtime must not write task tables or prompt worker sessions around the task service.

Pass the origin conversation, working directory and model configuration snapshot explicitly during creation. Extend foreground-dependent interfaces with validated origin parameters so delayed startup and topic switches cannot attach work incorrectly.

Handoff includes original-message references, an independent goal, relevant context and revisions, files and attachments, constraints, output language, delivery location and acceptance criteria. A background summary is derived data, not a replacement for original references. Workers reread materials under existing access rules and explain or request missing material when a reference is unavailable.

Propose retaining at most 5 active tasks. Capacity exhaustion produces an explicit action outcome and retains the request; do not queue invisibly or execute the work in the main agent. Independent tasks may run concurrently. Handle sequencing, file conflicts and external quotas for the actual work without claiming automatic detection of all conflicts.

## 11 Persistence and recovery

Add request and action records to `app.db`, reusing event transactions and effects. Proposed storage responsibilities follow; finalize names and migrations before implementation.

| Object | Stored information |
| --- | --- |
| Request | Origin, original-message and attachment references, revision, receive order, clarification links, routing and answer state |
| Decision and handling items | Protocol version, action plan, context references, request revision and stable action IDs |
| Action execution | State, attempt or generation, task and run IDs, receipts, failure or uncertainty reasons |
| Effects | Wake and recover committed actions without duplicating authoritative business state |

Track routing, ordinary answers and handoffs separately; TaskRuntime owns worker completion. Typical routing transitions are `received → resolving → committed`, with `waiting_input`, `failed` and `cancelled` branches. Action states include `pending`, `executing`, `succeeded`, `failed` and `uncertain`. Test transitions as pure functions rather than deriving them from UI state.

Derive action keys from request revision, handling-item identity and action identity; check receipts before duplicate delivery. Keep model calls and external I/O outside transactions, then validate request revisions, action generations and object state when committing results.

A crash after an external call but before receipt persistence prevents an exactly-once guarantee. Reconcile using task/session associations, persisted runs and delivery records. If the result cannot be established, retain `uncertain`, explain it, and prevent generic effects retries from blindly starting or sending again. Do not replay successful sibling actions because another action in the batch failed.

Persist only the references and decisions needed for recovery, not internal model reasoning or copies of all history in the event log. Conversation, attachment and memory deletion must update derived-reference handling and retention rules.

## 12 Reports and control events

Reuse [task reports](../src/backend/task-reports.ts) and their effects, preserving task/run deduplication, read acknowledgments and cross-topic origin. Completion notifications are typed `task_result` events, not new user commissions, and cannot start tasks merely by being reported.

The main agent may read results and report them at an appropriate time. Reports share session ordering with user requests, but user input takes precedence over report summaries not yet started. Reporting must not substantially defer new user requests.

Stopping the current answer affects only the main-agent call. Stopping background work targets its task and run. “Stop everything” requires determining the intended scope. Approval and question answers return to their original task rather than being redirected by the currently visible page.

## 13 Proposed module changes

| Component | Change |
| --- | --- |
| New `src/shared/request-routing.ts` | Request, item, action, receipt and push contracts and schemas |
| New `src/backend/request-runtime.ts` | Sole business entry for admission, ordering, state, decision acceptance and recovery |
| New `src/backend/request-store.ts` | `app.db` tables, migration, queries and revision constraints |
| New `src/backend/request-actions.ts` | Execute accepted actions through existing task and application interfaces |
| New `plugins/routing` | Role binding, context-tool restrictions, execution guard, route submission and end-of-turn checks |
| Compose and ACP modules | Wire the request runtime and plugin transport, including role binding on creation and resume |
| Conversation actions, preload and IPC | Unified submission with IDs, origin and attachments; remove direct busy-state routing |
| History adapters | Original-text pagination, continuation and stable references using the existing reader |
| Task and application adapters | Explicit origin, action links, receipts, existing confirmations and recovery reconciliation |
| State and views | Admission, clarification, startup, partial failure and interrupted streaming without internal route details |

Names may follow repository conventions during implementation. New source and tests use TypeScript and native type stripping, with no new framework or runtime dependency. Migrate touched JavaScript within the change's scope and include it in strict typechecking.

## 14 Delivery batches and acceptance

| Batch | Deliverables and gate |
| --- | --- |
| R1 | Requests and protocol, role binding and mandatory submission, ordinary-answer streaming gate; prove execution cannot bypass routing and original context is retained |
| R2 | Task creation, updates, stops, mixed requests, nonblocking clarification, historical pagination and handoff; verify briefing and A-share scenarios |
| R3 | Application operations, reports, disconnect/crash recovery, deletion and migration compatibility, full regression; qualify the overall replacement |

Enable intermediate batches only in isolated development or test configurations. Do not globally restrict normal-use main-agent tools before R3 and thereby remove configuration or memory features. End or explicitly cancel legacy foreground turns before switching modes. Restore existing workers to the correct role instead of turning an actively executing legacy foreground session into a read-only main agent mid-turn.

Deterministic tests cover input identity, duplicates, role isolation and scope-local bypasses, bounded missing-route repair, suppression of uncommitted text, stream ownership, same-step races, task state changes, stale stops, partial failures, pictures and attachments, clarification links, topic switches, retained approvals, and uncertain crash outcomes without blind replay.

Real DSH with a fake model verifies capabilities, session continuity, submission/result transport, stream gating and lifecycle. Repeat the following with actual models; scripted fake tool calls do not establish semantic routing correctness.

| Scenario | Expected result |
| --- | --- |
| Daily briefing followed by A-share analysis | Independent tasks; the main conversation does not wait for completion |
| Add technology news | Update the original task without duplication |
| Make the briefing English and analyze A shares | Two independently traceable actions in one request |
| Criteria discussed 30 or 80 turns earlier, with intervening topics | Recover the right source and applicable agreement |
| An earlier criterion explicitly changed later | Apply the changed criterion with provenance |
| Only an assistant suggestion, no user confirmation | Do not treat it as an agreed requirement |
| Same-name matters or ambiguous references | Clarify rather than guessing from recency |
| Compacted or deleted history and unavailable materials | Continue retrieval or explain unavailability instead of inventing context |
| Ordinary questions and follow-ups | Preserve conversational continuity and streaming |
| New work while clarification or application approval is pending | Admit new requests without losing the outstanding question |

Measure admission-to-decision, decision-to-handoff, first-answer-fragment latency, token cost, routing error categories, omissions, duplicates, clarification outcomes and recovery. Set thresholds and retrieval budgets after measurement; model-reported confidence is not an accuracy metric.

During implementation, run relevant tests, `npm run typecheck`, full `npm test` and documentation `npm run check:i18n`. This changes IPC, sessions and storage, so run `npm run build` and `npm run smoke` locally before opening a PR. Current-commit CI still verifies macOS and Windows. Include screenshots for visual changes and preserve bilingual copy and accessibility rules.

## 15 Decisions and verification before implementation

These items preserve the three confirmed boundaries, but must be settled before their implementation batch:

- Accept the first-release scope and R1–R3 rollout gate, especially retaining capacity 5, no queue when full and no initial vector index.
- Accept first-release processing of new input after the current main-agent model step when streaming, or define immediate interruption and continuation behavior.
- Set repair, context-reading and timeout budgets; propose at most two repair attempts and measure the other limits first.
- Verify real DSH behavior for streamed replies after submission, end-of-turn repair, role rebinding, parallel tools within one step and reconnects.
- Adapt application operations to retain original approvals without holding the main session, and define compatibility with the later memory migration.
- Identify uncertainty windows between session creation, first prompt, message insertion and persistence, and the receipts available to reconcile each action.

This delivery contains design documents and documentation registration only; it does not authorize code implementation.

## 16 Revisions required after feasibility validation

Isolated experiments on 2026-11-09 used real DSH and the existing DeepSeek v4.1 connection. See the [validation report](agent-routing-feasibility.md) and [raw results](agent-routing-feasibility-results.json). Mechanical checks passed 12/12, actual-model structured-contract checks 22/27, and relevant existing regressions 48/48. Verified paths include processing turn 81 after persisting and resuming 80 historical turns, streaming after routing, and same-session follow-ups while workers run.

Five contract failures comprise four clarifications submitted as reply and one recovered standard without delegating the requested briefing. The model did not select an ambiguous object or treat unconfirmed assistant advice as an agreement; the backend lacked the correct question state or delivery action. Before R1, clarify the boundary between ordinary replies and persisted questions and explicitly account for every goal in the original request. These fields remain insufficient to guarantee semantic correctness.

Set retrieval deduplication and budgets, retain the failures as regressions, and repeat the full actual-model evaluation after revision. The probe uses safe workers and an experimental output gate; production UI, nonblocking application approvals, every role-recovery path and crash reconciliation remain unverified. Runtime mechanisms are feasible, but the semantic protocol needs revision. This is neither production activation approval nor authorization to start implementation. Revisions after the supplementary validation are in section 17.

## 17 Revisions after the supplementary validation

The supplementary validation of 2026-11-09 added a switch-guarded prototype to the real app (`VIVA_ROUTING=1`; see [routing-prototype](../src/backend/routing-prototype.ts) and [plugins/routing](../plugins/routing/index.ts)) and ran actual-model scenarios with the production persona, production plugins and default thinking. Results are in [section 9 of the feasibility report](agent-routing-feasibility.md#9-supplementary-validation). The revisions below override the sections they cite; everything else stands. With the switch off, the app behaves as before; the prototype is not approval to ship.

### 17.1 Role binding timing (§7)

DSH assembles a step's system prompt and tools before `agent/pre-step`, so narrowing tools inside pre-step only affects the next step. The first-round probe's main session therefore sent all 49 tools with its first request, and live runs produced `bash` calls that the guard denied. The host must bind before the first step: before each main-session prompt, send the role binding and wait for the plugin's confirmation; narrow at once when the session already has an agent, otherwise at `agent/created`. Background tasks are never bound. In the prototype, the first request carries only the 10 main-session tools.

### 17.2 Visible output gate (§8)

A streaming attempt of an unauthorized step must still send start and settle, only without text or blocks. Dropping it whole lets the app's ACP fallback send the original text to the window when the operation produced no stream. In the deterministic set, the unchanged production stream passed 0/9 leak checks, dropping attempts whole passed 3/9, and keeping start and settle with empty content passed 9/9. In the real app, neither the conversation database nor the window showed request headers, routing JSON or dispatch notices.

### 17.3 Fast lane for interjections (§4)

The main agent reads an interjection only after its current step ends; during a long answer, the task card appeared 10.5 to 18 seconds after the interjection. A fast lane is added: when an interjection arrives, the routing plugin makes one model call without thinking, given the recent conversation, the task list and the interjected words. It hands over directly only when the words are clearly a new, independent job or clearly an addition to, or a stop of, exactly one task; anything else goes back to the main agent. After a handover, a notice is injected into the main session so the request is not submitted twice. In the real app, the fast lane decided in about 1.4 seconds and the task card appeared in 1.5 to 2.0 seconds; corrections to the current answer went back to the main agent in 5/5 runs. Fast-lane handovers use the same task interface and task ID checks as the main session.

### 17.4 Application operations (§9)

`commit_route` gains `app_action`, whose `operation` is a closed enumeration and whose arguments match the tool of the same name. Findings (the handling of the first two is superseded by the layered narrowing in 17.9):

- A restricted scope treats a global tool it does not include as absent, so the host cannot run it through the registry on the main session's behalf. The prototype runs the global definition directly instead, which skips DSH's argument check, guards and observers. A real implementation needs DSH to run an authorized out-of-scope call, or to let a scope hold a tool without showing it to the model.
- The main agent cannot see the parameters of tools narrowed away and repeatedly passed wrong fields. The host must check arguments against the tool schema before accepting the plan and reject with the parameter format; after this fix, schedules and memory each passed 5/5.
- A schedule proposal does not block: while its card waits, a new question is answered; once confirmed, it appears in Coming up.
- Configuration that needs approval (adding an MCP server, saving a skill and so on) cannot outlive its turn: DSH cancels a turn's pending approvals when the turn ends. With an executor task instead, the approval appears on the task card, but `config-channel` accepts requests only from the current main session, so the key step is refused. Options are in 17.5.

### 17.5 Configuration that needs confirmation

| Option | What the user sees | Changes needed |
| --- | --- | --- |
| a Main session waits | As today: the approval card and key window appear in the conversation; the turn does not end until confirmed, and new messages wait as interjections; if the user ignores the card, the conversation keeps waiting | Only keep such an operation's turn open |
| b Executor task | A task card such as "connect a service" appears and the turn ends at once; approval happens on the task card and the key window returns to the conversation; chatting continues meanwhile, at the cost of one task place and one more task start | `config-channel` accepts an executor task belonging to the current conversation, and shows the key window in the conversation |
| c Standalone confirmation card | Like a schedule proposal: a card that can be confirmed at any time appears and the turn ends at once; confirming opens the key window and the result is reported in the conversation | DSH approvals that outlive a turn, or, on the app side, configuration tools that propose a card the way `schedule_create` does, with the app collecting the confirmation |

For the first release, a is recommended: these operations are rare and the experience matches today's. For R3, take c's app-side form, which reuses the validated schedule-proposal pattern and needs no DSH change.

### 17.6 Turns ending in errors and failed receipts (§10, §11)

Across 206 sessions in the real app, 9 turns ended in an error because the model produced tool arguments that were not valid JSON. All nine were `commit_route` calls: eight schedule requests with nested `app_action` arguments and one very long start brief. An error ending does not fire `turn-stopping`, so the request was left unrouted silently and the user saw no response. The host must turn requests still pending at an error ending into failures reported to the user, or retry them a bounded number of times; protocol arguments should be kept flat.

When a handover receipt fails (for example, all five task places are taken), the turn must not end at once. The prototype turns the request into an answerable one, so the main agent says plainly what was not done and why.

### 17.7 Recovering from a misrouted interjection (§6, §12)

Four misjudgements are possible: an addition sent to the wrong task; a new task started where an addition was meant; a correction to the current answer treated as a task; new work merged into an existing task. Recovery has five layers:

1. Prevent: the fast lane hands over directly only on a unique match and otherwise defers to the main agent; task IDs for `message` and `stop` must come from the tasks the host listed.
2. Show: every handover immediately shows in the conversation where it went (task name and action), so the user can spot a mistake within seconds.
3. Withdraw: an addition sent to a running task is read only at the task's next step. It should be withdrawable until read, which needs the host or DSH to remove an unread message from the task's inbox. Once read, only a correction can follow, with a stop and restart if needed. A task started by mistake is simply stopped; the stop path passed 5/5.
4. Correct by a new request: "not that one" becomes a new request referring to the original action. The host compensates (a retraction to the wrong task, delivery to the right one or a new task) and marks the original action as corrected.
5. Side effects: a task may already have changed files on the wrong addition. The first release cannot roll back automatically; record the files a task touches before it reads an addition, or rely on the user's version control. Task-level snapshots remain to be assessed.

Withdrawing unread additions, compensation and file rollback are not yet implemented or validated.

### 17.8 Still unverified

History after reopening a conversation was checked only in the database. Crash-time action reconciliation, durable storage of requests and actions, Windows, production FTS recall on real history, other models, options b and c of 17.5 and the changes in 17.7 are not implemented or validated; option a is validated in 17.9. The supplement shows how the mechanisms and these scenarios behave on one model; it is not approval to ship.

### 17.9 Layered narrowing of the main session's tools

The main session's tools come in five layers, defined in one place, [policy](../plugins/routing/lib/policy.ts):

| Layer | Tools | Rule |
| --- | --- | --- |
| Route | `commit_route` | Called for every request |
| Context | Conversation search and reading, `memory_recall`, task queries, read-only file tools | Always available |
| App query | `schedule_list`, `viva_mcp_list`, `viva_skill_list` | Always available |
| App change | Creating, changing and deleting schedules; remembering and forgetting memories; adding, changing, removing and importing MCP servers and skills | In scope and visible to the model; the turn must first commit the matching `app_action`, and the guard lets the call through on that grant, one call per grant |
| Execution | Shell, file writes, web, sub-agents, the background-task tools, MCP servers' tools and everything else | Out of scope; such work goes to a task through `commit_route` |

Narrowing happens before the first step (17.1), and the guard applies the same rule again at execution, covering tools added later. App tools stay in scope, so they keep DSH's argument check, approvals, key windows and observers. The two problems in 17.4, a restricted scope unable to run a tool on the agent's behalf and the agent unable to see its parameters, disappear: the prototype no longer runs tool definitions directly, and no new DSH interface is needed. An `app_action` names only the tool; the model gives the arguments in its own call of that tool at the next step, so the protocol stays flat. Configuration that needs approval follows option a of 17.5: when the main session calls `viva_mcp_add`, the approval card and key window are as they are today.

Validation ran in the real app with the production persona, plugins and default thinking, five runs each: 10 scenarios passed 50/50; forbidden calls 0, routing failures 0; schedules, memory and MCP setup committed an `app_action` and were then done by the matching tool in 15/15; MCP setup took 6.8 to 10.3 seconds per turn with the approval card and key window as usual; after an interjection the task card appeared in 1.6 to 2.8 seconds (once 6.4); corrections to the current answer went back to the main agent in 5/5; first text came in 3.1 to 5.0 seconds. Twice the schedule scenario committed two `app_action`s at once; the spare grant was dropped at the end of the turn, and the protocol's wording needs to be clearer.

Experience change: tools of MCP servers the user has added are no longer called by the main session directly; that work goes to a task, and the main session does not wait for it.

### 17.10 Code structure

The supplementary prototype is split by responsibility, and implementation keeps this split:

- `src/shared/request-routing/`: contracts the app shares with the plugin. `header.ts` is the one definition of the request header; `protocol.ts` holds the routing protocol and the closed set of app operations; `ledger.ts` is the pure, immutable request ledger with every state transition, including closing the last turn's leave to speak when a new turn starts and failing undecided requests when a turn ends in an error. The app-side request runtime reuses this ledger when it adds durable storage.
- `plugins/routing/`: what is dsh's alone. `lib/policy.ts` holds the tool layers and grants; `lib/task-actions.ts` hands over through the viva-tasks channel, every call answering with a receipt; `lib/stream.ts` is the gate; `lib/fast-lane.ts` is the fast lane; `index.ts` only wires dsh's events to these modules. The evidence file is an optional observation port.
- `src/backend/routing-prototype.ts` and the bridge: the switch, the persona rules, the plugin swap and the confirmed role binding.

The restructuring fixed an existing problem: leave to speak did not end with its turn, so once a session had answered anything, later handovers no longer ended the turn and the gate let text through. Unit tests cover the ledger's transitions, the tool layers and grants, the protocol, the request header and the fast lane's parsing.

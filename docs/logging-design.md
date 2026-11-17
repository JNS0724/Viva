# Viva logging and fault diagnosis design

English | [简体中文](logging-design.zh-CN.md)

Updated November 17, 2026. This document specifies the logging architecture, flow coverage and acceptance requirements. The first L1a runtime batch is implemented; see section 14 for its status. Design approval does not mean all implementation stages are complete.

The [additional independent review](qa-logging-design-independent-review-20261117.zh-CN.md) has been incorporated for diagnostic-validation isolation, separate L1 acceptance batches, identity rotation on clearing and partial JSONL records. Decisions are recorded in the [review record](qa-logging-design-review-20261117.zh-CN.md), both in Chinese.

Viva saves structured diagnostic logs locally by default. Conversations, memory requests and background work can be followed across Renderer, Shell, Backend, DSH plugins and Workers. Stalled requests expose their current stage, resources and holders. Persistent business operation identities connect execution across restarts. Users on another computer can export evidence that identifies the affected process and stage.

## 1 Current behavior and problem

The baseline is merged main commit `c3224d7`, together with ongoing frontend changes in the current workspace. A user reported a stalled memory:get on another computer and suspects repeated dream retries. That causal relationship remains a hypothesis.

| Confirmed behavior | Design implication |
| --- | --- |
| [memory:get](../src/backend/memory-ipc.ts) sequentially reads profile, onboarding, cleanupPending, revision and fileProfile | Record each child request separately |
| The [remote owner channel](../src/backend/remote-memory-channel.ts) has a default 30-second timeout per request and already carries requestId and epoch | Reuse identities and add an outer budget and actual post-timeout execution status |
| The [owner](../src/memory/node/owner.ts) rejects ordinary reads when not ready or when source changes remain pending | Record state, reasons and operations, distinguishing rejection from a stall |
| [Dream](../src/memory/core/memory-dream-jobs.ts) can retry indefinitely, with backoff capped at 60 seconds, and some catches discard errors | Preserve stage, reason, progress and next attempt without assuming that retries block reads |
| [Effects](../src/memory/node/effects.ts) awaits runners sequentially within a pass | Record runner duration, backlog and wake source |
| The [send fence](../src/memory/core/send-fence.ts) waits for actual transport settlement | Distinguish cancellation requested from transport settlement and identify pending attempts |
| Merged startup wires inputs after data loading, while ongoing workspace changes already wire inputs earlier but still initialize events after Promise.all | Preserve that work and decouple optional memory loading from required event initialization |
| [Session timing](../src/backend/session-timing.ts) primarily reports on completion, and Shell inherits Backend stdout/stderr | Add start and wait events and durable local file sinks |

Ordinary reads do not directly await dream. Evidence of a shared resource, owner-state dependency or blocked process is required to establish causality. Failed RPCs, RPCs that never return and global RPC serialization are different conditions.

## 2 Scope and boundaries

Coverage includes startup and recovery, conversations, interruption and cancellation, background and scheduled work, memory writes, forgetting and retrieval, index maintenance, tool connections and desktop window lifecycle.

Diagnostic logs do not provide business receipts, idempotence, scheduling or memory truth. Existing app.db events, memory document journals, user-visible trace.db records and native DSH session logs retain their semantics. Diagnostics use independent files so database problems have an independent evidence channel.

Use Pino with an asynchronous SonicBoom destination and existing business transports. L1a pins Pino 10.4.0 and SonicBoom 4.2.1; the latter matches Pino's dependency range, avoiding duplicate destinations. Yazl 3.3.1 provides streaming ZIP archives. These three Node runtime dependencies supply structured logging, bounded asynchronous output and standard ZIP encoding, validated in Electron's embedded Node and standalone DSH. Renderer adds no runtime dependency and uses Preload. Event-specific allowlists prevent arbitrary business objects from being serialized.

## 3 Architecture and ownership

```text
Renderer actions / transport
  -> validated, rate-limited one-way Preload diagnostics
  -> Shell file sink

Shell IPC -> Backend HTTP -> DSH host channel -> Memory owner / core
    |              |                  |                |
    +-- own file    +-- own file        +-- DSH file      +-- injected port

Embedding Worker -> own file or bounded parent diagnostic channel

Shell exporter -> saved files + time-bounded snapshots -> local ZIP
```

| Layer | Responsibility |
| --- | --- |
| src/diagnostics/contracts.ts | Dependency-free event unions, context and diagnostic port with no Node, Electron or DSH imports |
| src/diagnostics/node/ | Thin Pino/SonicBoom adapter, context and around-call entry points, capacity/file policies, active spans, snapshots and safe fields |
| Shell | Application runId, configuration, its own and Renderer files, Backend supervision and offline export |
| Backend | HTTP and domain-boundary instrumentation, DSH supervision and context propagation |
| Memory Core | Optional diagnostic port with a no-op default, no direct console, filesystem or Electron access |
| DSH plugin and Node owner | Host requests, state, recovery, transport and storage stages, with an independent standalone sink |
| Renderer | Actions and transport record events, state remains pure, views display state |

The generic module cannot depend on product layers. The current assembler permits only plugins/memory and src/memory. Add the explicit diagnostics subtree while retaining rejection of other repository-only imports. Update typechecking, independent plugin assembly and isolated execution tests.[Plugin assembly](../scripts/build-memory-plugin.ts)

Standalone DSH and dsh-web use the same diagnostic port and Node sink. A host may supply a directory and correlation context without secrets. Otherwise the plugin uses its own local diagnostic directory. Viva settings and Shell export are not prerequisites for plugin startup.

The port exposes synchronous, bounded, non-throwing emit(event): undefined and never returns a Promise. A common safety adapter catches diagnostic failures, falls back to a no-op and increments bounded failure counters. Sink initialization, asynchronous rejection and flushing stay inside that adapter. Business work never waits for them, and business errors retain their original propagation.

### 3.1 Framework selection

Pino supplies levels, JSON serialization, child loggers, serializers and redaction. Configure them through one adapter rather than independent business loggers. Disable default hostname binding. Use the safe error serializer in this design rather than default message/stack output. Bind only validated correlation metadata to children. Redaction is a second layer after allowlisting.[Pino API](https://github.com/pinojs/pino/blob/main/docs/api.md)

Construct SonicBoom directly and pass it to Pino with sync: false, fsync: false, finite maxLength/maxWrite and periodic flushing. Observe drop/error/write events. Managed rotation uses end/close, confirming old destination closure before creating a new destination through a thin switching adapter. Reopen ready means a new fd opened, not that the old fd closed, and cannot release slots or authorize repeated rotation. Unconfirmed closure retains slots/handles and stops rotation with bounded drops. Libraries handle file I/O. Declare both dependencies explicitly.[SonicBoom API](https://github.com/pinojs/sonic-boom#api)

Configure the public retryEAGAIN policy to decline persistent library retries. EAGAIN/EBUSY ends that destination attempt and diagnostics owns bounded backoff. Periodic flush uses the no-callback form. Lifecycle flush callbacks and their asynchronous fsync share shutdown deadlines and in-flight accounting. Admission stop, flush timeout or requested destroy is not confirmed closure and cannot justify more destinations.

The default is in-process asynchronous batching, avoiding extra transport Worker memory, startup and packaging. Serialization and context still cost CPU and require measurements. Production paths forbid synchronous flush, fatal during normal operations and unbounded exit flushing. Own destination lifecycle instead of convenience entry points with implicit synchronous exit flush. L1a must verify locked-version behavior rather than assuming async or worker guarantees nonblocking operation.

### 3.2 Around-call logging and context

Provide a thin withOperation entry point to record start, duration, outcome, errors and cleanup at known RPC, task, storage and Worker boundaries. Use one wrapper at IPC/HTTP registration boundaries. Stable AsyncLocalStorage.run propagates Node context with Pino children. Cross-process propagation remains explicit and validated.[Node asynchronous context](https://nodejs.org/api/async_context.html)

Wrappers accept allowlisted metadata and never automatically log arguments, results or raw errors. Synchronous functions retain synchronous returns. Asynchronous completion, return values, error identity, this and cancellation retain original behavior. Detached work starts its own linked context. Use higher-order functions without transpiled decorators, global monkey patches or another AOP framework.

Pino hooks wrap logging calls and cannot discover what a business function awaits. Around-call adapters cover common lifecycle while domain modules explicitly report dream phases, fence holders and recovery reasons. Application policy stays thin while serialization, levels and file I/O reuse mature implementations.

### 3.3 DSH diagnostics and local integration

The following reuse boundaries come from installed DSH 0.2.2-rc.2 public documentation, types and source. RC interfaces stay version-locked and contract-tested rather than being called stable cross-version standards. Official source is [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

| DSH capability | Use and boundary |
| --- | --- |
| Cordis ctx.logger/exporter | Register early and map severity/source/sequence/time into Pino, never raw args, format strings or Error. Non-throwing observers dispose with plugin scope |
| tools/execute around-dispatch waterfall | Reuse official wrapping with exactly one next, preserving normalized result, signal and quiescence. tools/result emit observes result metadata |
| agent/status, agent/error, agent/request-error | Safe state/error categories. request-error waterfall preserves the original retry chain. Never add deprecated agent/request listeners |
| session/event and local Session Log | Reuse validated native sessionId/type/seq/turn/step metadata without copying bodies. Session seq is not Viva UI cutover watermarks |
| ctx.sessionQuery | Use public local-history queries for deliberate deeper investigation rather than private compressed formats. Default logs/bundles do not scan content |
| llm/stream waterfall | Observe known boundaries without changing requests or consuming twice/early. Iteration end/cancel is terminal. A stream handle does not prove provider I/O |
| SessionTelemetryBackend/Sink and record waterfall | Public seam, but ledger bodies mirror complete events. Do not add another backend or capture queue for metadata diagnostics |
| Startup diagnostics and local inspector | Use startup outcomes/plugin states for missing/PENDING diagnosis. Raw startup reports may contain credentials and are excluded. Inspector is manual local development tooling, with no default raw fetch capture |

Verification entry points in installed packages are docs/user/develop/framework/events.md, docs/subsystems/session-telemetry.md, @deepseek-ai/cordis/src/logger.ts, @deepseek-ai/dsh-tools/src/events.ts, @deepseek-ai/dsh-agent/src/runtime-types.ts and @deepseek-ai/dsh/src/startup-diagnostics.ts. Recheck exported types at implementation.

Emit observers only enqueue bounded metadata. Waterfalls preserve next, original values/errors and cancellation. Serial checkpoints such as agent/turn-stopping never await diagnostic writes/flush/snapshots. Adapt DSH hooks separately from Viva's custom memory_host protocol. ACP does not provide the complete Shell/Renderer/custom-memory diagnostic chain automatically.

ACP-mode stdout remains protocol frames only. Pino uses an explicit local-file destination, never stdout logging or indiscriminate raw stderr collection. Failed plugin startup retains host-observed exits, status and safe categories. Original startup reports stay in DSH local storage for deliberate investigation.

### 3.4 Local storage and networking

Diagnostics use local files, local IPC and loopback HTTP only. No cloud collector, automatic remote upload or remote inspection port. Never automatically attach diagnostic traces to model requests. Manual export writes locally without sending.

Viva-managed profiles explicitly disable both DSH session telemetry upload and native-log inclusion in model requests. Set session-telemetry-otel to DISABLED or leave it unmounted. FEEDBACK_ONLY can upload on feedback and is not local mode. Keep session-log-deepseek enabled:false and existing memory exclusions. Check other mounted analytics/exporters rather than claiming one environment variable disables everything. Record results, not full configuration.

Standalone plugin diagnostics remain local without changing host-global telemetry. Local DSH/dsh-web acceptance uses a profile with uploads explicitly disabled. If an external host still uploads, disclose the unmet host condition rather than equating plugin-local logs with a network-free host. Normal model networking and local-only diagnostics are separate boundaries.

## 4 Event contract and correlation

| Field group | Contract |
| --- | --- |
| Version and source | schemaVersion, appVersion, build commit, platform, architecture and component version |
| Time and order | UTC timestamp, diagnosticRunId, processInstanceId, increasing per-process sequence, local monotonic time and durationMs. Persist correlation identities as aliases for the current diagnostic generation |
| Trace | traceId, spanId, parentSpanId and optional links for independent asynchronous work |
| Business identity | Validated opaque operationId, requestId, taskRunId, jobId, generation and ownerEpoch |
| Event and outcome | component, fixed event name, level, stage, outcome and reasonCode |
| Diagnostic summary | Event-specific scalar attempt, retryDelayMs, queueDepth, completedCount, remainingCount, waitFor and blockingSpanId |

Each user action starts a trace. RPCs, recovery attempts and actual model transport attempts have child spans. Retries retain the business operationId and receive separate attempt spans. Background and scheduled work start independent traces linked to their trigger. Restart changes processInstanceId, and persistent operationId connects recovered execution without assuming in-memory trace context survives.

Only bounded, validated correlation metadata crosses process boundaries. It never determines authorization, scope, provenance, idempotence or fence admission. Renderer trace data is not trusted business identity. Shell creates or validates its own correlation mapping at the trusted IPC boundary.

Preload accepts known events and bounded scalars, never arbitrary text, paths or objects. HTTP, host and Worker messages carry an independent, optional, self-versioned diagnostics envelope. Validate it separately from business arguments. Separate only that fixed field in recognized messages, preserving existing business validation for everything else. Diagnostics never enters parseHostMemoryCommand input, business fingerprints or signatures.

Retain existing authentication, message types, business protocols and transport-size limits, then independently safeParse business content and diagnostic context. Invalid business remains rejected. Missing diagnostics creates a local root. Unknown diagnostic versions, malformed trace/span or unknown fields discard context, create a local root and increment context_dropped with a fixed reason. Never log rejected values or parser-error text, and never change business outcomes because diagnostic parsing failed. Invalid diagnostic-only messages are simply dropped.

Senders boundedly validate diagnostics, then account separately for business encoding and optional diagnostic overhead against existing shared transport limits. HTTP/JSON uses actual UTF-8 bytes including escaping, keys and envelope delimiters, never string length or estimated object size. If diagnostics would exceed an existing body/frame/header limit where applicable, omit diagnostics, count context_dropped(reason=transport_budget), and send the original business encoding. Never truncate, compress or rewrite business to make room. Diagnostic validation/encoding failure also falls back. Reuse the business encoding and small diagnostic encoding rather than traversing/copying large objects again. Omit context if fitting the complete encoding cannot be proven cheaply.

Receivers retain full-message limits. Current loopback HTTP rejects bodies over 32 MiB with 413 before parsing JSON. It cannot promise to recover business from arbitrary oversized or incompletely parsed external messages by stripping diagnostics. Context degradation applies after transport admission. Viva senders preserve valid business admission through budget fallback. Oversized business itself remains rejected. Logging neither increases transport limits nor introduces business-size limits where none existed.[Receiver limits](../src/backend/rpc-server.ts) [Sender encoding](../src/shell/backend-client.ts)

Adding only a diagnostic envelope does not increment MEMORY_HOST_PROTOCOL. Missing/unknown/invalid diagnostic combinations test degradation, not old business-protocol or data compatibility. Business-version mismatch retains existing rejection. Real batching and synchronization fields added in L1b remain business contracts and cannot be discarded as optional diagnostics.

Wall time helps reading but cannot establish cross-process duration or ordering. Explicit parent/request/response relationships establish causality. Each process measures its duration with its own monotonic clock.

## 5 Lifecycle and waits

Before awaiting work, enqueue start and register a bounded active span. Record meaningful progress, wait.begin, wait.end and one local terminal outcome. Outcomes include completed, failed, timed_out and cancelled. If a caller times out while the server continues, the server records late_completed or its actual failure using the same request identity. Caller timeout must not imply server cancellation.

The module that owns a resource reports its waits, including resource category, holder operation or span, start, oldest age and count. Temporal overlap is insufficient to set blockingSpanId. Unknown holders remain unknown with the last successful stage preserved.

Waits cover owner readiness, recovery operations, effects runners, fence transport attempts, database busy, model responses, Embedding Workers, HTTP and SSE host-mark catch-up. Admission rejection and waiting are separate outcomes.

The default slow threshold is 2 seconds. Emit a snapshot once when crossed and at most every 30 seconds thereafter, then record final duration. Long background work has independent execution deadlines and stage progress. Crossing a slow threshold does not fail it.

Each process tracks at most 2048 active spans. At capacity, retain existing spans and count untracked additions without delaying business work. Snapshots reference authoritative existing state rather than implementing another task or fence state machine.

## 6 Initial memory and dream instrumentation

Record Renderer invocation, Shell receipt, HTTP send, Backend receipt, each of the five owner reads, result construction, HTTP receipt, host-mark catch-up and Renderer application for memory:get. Separate starts and outcomes expose an unfinished child step.

Dream records Extract, Integrate, Verify and Tag stages, counts, operation identity and checkpoint commits. retry.scheduled includes failed stage, stable reasonCode, attempts, next execution time and progress. Deferred work awaiting evidence, wait awaiting an external wake and successful empty results are distinct from technical retries.

Count inner model correction, effect reruns and actual SDK transport retries separately. Instrument existing observable transport boundaries without changing private SDK behavior to guess whether a send occurred. Before converting an exception into retry, report its safe category and preserve the business outcome.

Owner snapshots include ready/recovering/unavailable, replayingWrites, pending source changes, pending host effects and fence attempt count/oldest age. State changes include their cause and operation. Counters come from existing authoritative state.

| Condition | Required evidence |
| --- | --- |
| Dream fails while reads succeed | Overlapping dream retry and completed memory.get with ready owner |
| Recovering owner rejects a read | Read rejection reason, owner state and recovery operation |
| Backend sent but DSH has not processed | Send without plugin receipt, combined with heartbeat/exit evidence |
| Plugin received but storage has not finished | Owner start and missing storage-stage completion, with loop/storage evidence |
| Result exists but UI still waits | Gaps among plugin reply, HTTP response, Shell mark wait and Renderer application |
| Fence cannot release | Mutation, pending transport attempts, cancellation and missing settlement |

Conclusions stop at the evidenced boundary. Missing receipt logs require checking sink loss/failure before claiming that the request never arrived.

## 7 L1b startup isolation and deadlines

This section belongs to independent L1b availability fixes. L1a diagnostic delivery does not depend on these business changes. Preserve early input wiring and separate optional memory data from required startup tasks. Keep history snapshot, selected conversation and replay ordering intact. Release buffered events only after a valid required snapshot, preventing older snapshots from overwriting pushes. Memory loading no longer gates conversation event initialization.

Required snapshots have a 30-second initialization budget. Foreground buffering is limited to 1024 events, 2 MiB and a 15-second oldest age. The first exceeded limit ends that initialization in a recoverable error. Memory accounting includes held content, while logs contain counts only. Stop accumulating events for that attempt and retain drafts and attachments. Never discard events silently and continue applying deltas. Manual retry starts a new initialization generation, obtains trusted selection and required snapshots, then associates ordered events with that generation. Reject old snapshots/pushes. Reuse existing reconnect/snapshot paths, disclose unreplayable streaming gaps and block model sends until safe state is restored. Record overflow, last sequence and resynchronization. Regression coverage belongs to L1b.

Local Renderer generation only rejects old asynchronous callbacks. It cannot distinguish old pushes for the same conversation. L1b adds a minimal trusted synchronization contract. Backend/Shell event publication provides streamGeneration and increasing eventCursor. Required snapshots return a matching cutoverCursor in the same publication order. Retry validates conversation and stream identity, installs the snapshot, then applies only ordered deltas after its cutoff. Snapshot/cursor capture shares the publication boundary rather than reading a cursor arbitrarily after an asynchronous snapshot. Unknown boundaries or incomplete replay retain failure and disclose gaps. Log traceId cannot substitute for these business synchronization fields.

memory:get has a 10-second end-to-end budget. Children inherit remaining time capped by the existing 30-second owner timeout. Across processes, carry remaining duration and establish a local monotonic deadline, subtracting waits at each stage rather than comparing monotonic timestamps from different processes. The outer deadline covers lost responses and host-mark catch-up. Show unavailable/timeout with manual retry rather than fake successful empty memory.

Caller timeout does not prove server work stopped. Coalesce only unexpired refreshes from the same page. On expiry, finish the caller span, remove its coalescing entry, release caller concurrency and close cancellable HTTP resources. Manual retry gets a new requestId rather than the old Promise. Late outcomes are diagnostic only and cannot update UI.

Separately account for server read executions that have not confirmed completion. Memory-page reads allow at most two batches per owner epoch. A timed-out batch retains its server slot until actual completion or owner exit/epoch change, allowing one independent retry after the first stall. If both slots remain occupied, immediately return an explicit busy state without queuing more owner work. Discarding expired diagnostic records cannot free real execution slots. Test ordinary concurrency and recovery under this limit.

The trusted host/owner business coordinator owns these slots using a separate readBatchId, never the diagnostic active table. Preserve the existing five read methods and register each sent child's execution and owner instance. Caller timeout stops further dispatch for that batch while retaining sent, unfinished execution records. On a trusted terminal reply, settle execution before looking up a deliverable caller waiter. Existing pending-map deletion and late-reply suppression cannot settle slots. Release only on proven non-send, completion of all sent children, owner exit or epoch change. Logs merely observe this state and losses cannot affect it.

Use existing cancellable boundaries rather than discarding ongoing tasks after Promise.race. Writes, forgetting and undo query their operationId receipt rather than automatically retrying as new operations.

UI interaction and model admission remain separate. Existing DSH fences still apply while the owner recovers, with an explicit reason when sending is unavailable. Never recover availability by faking readiness, clearing fences, ignoring withdrawal or forcing admission after timeout.

## 8 Coverage of critical flows

| Flow | Required stages | Phase |
| --- | --- | --- |
| Startup and recovery | Start, ready, plugins, owner recovery, event initialization, exits and restart attempts | L1a observations, L1b fixes, L1c hardening |
| Memory reads and dream | Full boundaries, five reads, four stages, retries, progress, fence and recovery | L1a observations, L1b deadlines/settlement |
| Conversation and interruption | Send, intake, injection, admission, physical send, first response, completion, cancel and settlement | L2 |
| Background work and routing | Create, claim, route, start, user wait, recovery, report, receipt and idempotence | L2 |
| Scheduled work | Due, claim, dispatch, execute, next time, receipt, crash recovery and duplicate suppression | L2 |
| Session and daily intake | Receive, date assignment, backlog, checkpoint, receipt, rejection and recovery | L2 |
| Writes and management | Draft validation, replacement, revision publication, undo, clarification, failures and idempotence | L2 |
| Forgetting and cleanup | Source exclusion, fence, copy-cleanup stages, pending, host ACK and completion | L2 |
| Retrieval and indexing | Counts/timing for full text, vectors, fusion and relations, model load, rebuild and stale rejection | L2 |
| Infrastructure and tools | HTTP/SSE reconnects, generation changes, transactions/busy, Workers, MCP and tool boundaries | L2 |
| Desktop | Window/island creation, destruction, expansion, collapse, focus and failures, no per-frame drag logging | L2 |
| Logging and export | Sink failures, drops, rotation, export omissions/completion and offline use | L1a safety foundation, L1c fault tests, L3 release |

Streaming records first response, periodic count summaries and completion, not tokens. Tool names use built-in enums or opaque identities rather than untrusted third-party names, arguments or output.

## 9 Files and bounds

Viva stores diagnostics under userData. Each process instance writes its own JSONL files, with no shared cross-process file handle. Shell writes Renderer events retaining the Renderer processInstanceId. Workers using bounded parent channels disclose that dependency, and the parent's supervisor observes failure.

Defaults are 7-day retention, a hard 100 MiB logical-byte budget for managed diagnostics and 8 MiB per file. Shell manages Viva quota, and standalone plugins use their own Node manager. Reserve quota when allocating file slots. Active files, closed files, control inventories and pinned export ranges share that budget. Writers use only allocated slots without waiting for additional quota. Exhaustion, unavailable managers or deletion failure cause counted drops rather than unlimited rotation.

Each directory has at most eight independent writers. Additional Workers use bounded parent channels. Reclaim only closed, unpinned regular files. Writer registration includes runId, processInstanceId and supervisor-confirmed exits, not PID alone. After Shell crashes, the next startup confirms the previous instance no longer owns the directory and its writers have exited before reclaiming slots. Uncertain slots remain charged. Prefer dropping logs to unbounded allocation. ZIP and temporary export files reside at the user-selected destination and follow separate export limits below.

Events are limited to 8 KiB. Adapter queues, SonicBoom buffers and in-flight log data share one 4 MiB per-process budget rather than independent allowances. Combine library maxLength/maxWrite and write/drop events with adapter admission accounting. Release in-flight charges only after actual write confirmation. Reserve an upper bound including JSON escaping and framework fields. Each sink allows one file write at a time, at most 64 KiB, with serialized file transitions. Timeout/pending stops admission rather than creating more Promises or destinations. Renderer batches are at most 64 KiB and 10 per second. Validate and count invalid/oversized events before passing them to Pino, never truncate JSON.

When the thin destination receives an encoded Pino line, reconcile actual UTF-8 length and release surplus reservation. Reject oversized lines whole. Level filtering, serialization failure and admission rejection release the full reservation. Settle SonicBoom drop bytes separately from accepted data. Actual/partial write releases confirmed bytes FIFO without double release. A false write return signals backpressure, not rejection or permission to resend. Error invalidates the destination, retaining uncertain data/file charges until confirmed release/closure. Uncertainty stops additional destinations.

Info records key steps, warn slow requests/retries/recoverable problems, and error terminal failures. Debug expires after 15 minutes and has identical content rules. Drop debug and repeated summaries first and reserve capacity for errors, starts and terminal events. Total exhaustion remains observable through counters. This is not a lossless audit log.

Asynchronous writes never backpressure business calls. Sink failures retain bounded in-memory summaries and use backoff without recursive logging. On startup, classify spans without terminal records from a previous run as incomplete, without assuming the business operation failed to commit. Shutdown allows at most 2 seconds of best-effort flushing. Crashes and power loss can lose an unwritten tail.

## 10 Health and export

Backend reports to Shell and DSH reports to Backend every 5 seconds, summarizing process identity, event-loop delay, active requests, oldest stage and sink health without content. Bounded child IPC is independent of business HTTP/effects and explicitly demultiplexed from ready handshakes. Health messages cannot count as startup responses. A 15-second gap causes the supervisor to record suspect. It does not automatically kill processes, undo work or release fences. Heartbeat receipt and file logging remain separate so sink failures differ from child unresponsiveness. Renderer sends heartbeat through Preload, keeping only summaries.

Both settings and the native application menu expose diagnostic export. The native menu remains usable when Renderer is unresponsive. Shell reads files directly without memory:get or Backend RPC. Snapshot requests to live components have a shared 2-second limit. File export continues and the manifest names missing components.

The ZIP contains version inventory, logs, available active-span snapshots, process exit details and export summary. Databases, memory files, native sessions, trace content, screenshots and memory dumps are excluded by default.

Each application instance permits one export. Repeated clicks reuse progress rather than creating work. Shell supervises an independent export child process with a 30-second total deadline covering enumeration, open, read, ZIP output and finalization. The 2-second snapshot budget is included. Pin at most 32 MiB at fixed file cutoffs. Output plus the sole temporary ZIP is limited to 40 MiB. Read and write each permit one in-flight operation with bounded streaming buffers. The manifest lists ranges, omissions, drops and failures.

Read JSONL only through its fixed source cutoff and process complete newline-terminated records. If the cutoff falls within the last record, do not wait for the writer or decode/export the fragment. Retreat to the last complete newline, producing an empty segment if none exists. The manifest separately records rawCutoffBytes, exportedThroughByte, trailingBytesOmitted, partial_trailing_record and outputBytes after safe re-encoding. Output size is not a source cursor. A trailing fragment is not corruption. Newline-terminated invalid JSON is separately counted as invalid_record without copying it. Test partial UTF-8, an incomplete first record, crash tails and concurrent appends within existing byte/buffer limits.

Test three newline-terminated records: valid A, malformed JSON containing a secret sentinel, and valid B. Export A/B safely, increment invalid_record exactly once, omit the secret/raw malformed line from ZIP/manifest, and continue through B. With no trailing fragment, partial_trailing_record is false and trailingBytesOmitted is zero. If a real trailing fragment also exists, report it independently rather than treating complete malformed records as truncation. This is L1a baseline export acceptance, repeated in L1c/L3 fault/release integration.

An independent Shell watchdog terminates overdue export work and reports failure or an already finalized partial result. Never report an unfinished ZIP as successful. Confirm exit before releasing pins and cleaning temporary files. Unconfirmed exit or deletion failure retains quota as cleanup_pending and blocks new exports until cleanup, preventing additional orphan processes/files. Next startup reclaims incomplete export resources by instance identity and conservatively retains uncertain charges. The native menu can always open the log directory. An unwritable disk may cause explicit export failure. Bounded user waiting is required, successful ZIP creation is not.

## 11 Content protection and forgetting

Normal and debug logs accept fixed names, bounded codes, counts, versions, timing and validated opaque identities. Reject prompts, message/memory content, reasoning, request bodies, tool input/output, Authorization, API keys, connection configuration, arbitrary URLs and raw paths.

Never serialize Error.message, cause or stack directly. Map known failures to reasonCode and unknown types to fixed unknown_error, never raw Error.name. Retain only build-verified module IDs, line/column and trusted static symbols. Omit or opaquely map unknown frames, dynamic functions, plugin paths and eval names. Validate opaque business identities and persist correlation/business identities as salted aliases for the current diagnostic generation. Producer-side HMAC also represents potentially content-bearing effect keys/names. Live business identities remain unchanged and aliases never affect business decisions. Preserve alias consistency within each bundle without reusing stable aliases across clearing.

Store the salt separately and exclude it from exports. Logs contain neither content nor bare hashes that enable dictionary reconstruction of content, so forgetting creates no additional diagnostic text copies. Diagnostic retention does not replace business erasure.

Clearing rotates the salt and diagnosticRunId, clears old mappings/bounded caches/diagnostic spans and invalidates old child bindings. Ongoing business continues and later diagnostics rebind to the new generation, recording continued_after_clear if needed without old-generation links. Application identity, owner epoch, real readBatchId execution slots and business receipts remain unchanged. Timing, process and version metadata can still support inference. This is not cross-bundle anonymity.

The diagnostic control plane pauses old-generation admission, waits for writer closure and deletes files without waiting for or releasing business fences. Resume logging after establishing new generation/file slots and drop late old-generation messages/buffers. Keep bounded I/O and a 2-second control wait. Unconfirmed closure/deletion retains quota and reports cleanup_pending rather than successful clearing. Previously exported ZIPs remain user-managed. Never delete business databases, receipts or real execution records.

## 12 Implementation sequence

### L1 Memory fault diagnosis

L1 remains one top-level stage with three independently implemented, validated and committed batches. Deliver L1a diagnostics without waiting for business changes in L1b. L1c concentrates fault and platform verification rather than combining everything in one change.

| Batch | Scope | Independent exit criteria |
| --- | --- | --- |
| L1a Read-only diagnostics | Locked Pino/SonicBoom, ports/wrappers/context/isolation, five memory reads, dream, owner/fence and exit observations, DSH local integration, independent plugin packaging and safely bounded native export | Missing owner replies/dream failures remain exportable and identifiable. Diagnostic toggles, malformed context and sink failures preserve business values/errors/admission/cancellation/receipts. Existing business deadlines, slots and initialization stay unchanged. Fixed baseline-load comparison meets section 13 performance targets |
| L1b Memory availability | Section 7 startup isolation, trusted stream generation/cutoffs, 10-second budget, real readBatchId settlement and read capacity | Startup/memory/replay regression passes with a no-op logger. Retry works after timeout, late replies/old pushes cannot overwrite state and fences hold |
| L1c Diagnostic hardening | Heartbeats/supervision, quota/rotation/clearing/export fault injection, isolated plugin, macOS/Windows targeted checks and initial performance measurement | Permanent pending, exits, cleanup failures and flooding remain bounded, export/local-only guarantees have test evidence |

L1a already includes allowlists, safe error serialization, non-throwing ports, rate limits, bounded queues/in-flight I/O, quotas, serial rotation, shutdown bounds, export deadlines/concurrency/size, complete JSONL records and disabled upload paths. Framework selection includes baseline performance comparison. L1c extends stress/platform measurements and L3 verifies all release flows. Shipping a clear action also requires salt/generation rotation and incomplete status in the same batch, with full fault verification in L1c. Never postpone these safety foundations.

Completing L1 requires all batches, while L1a can ship independently. Stream cutoffs and true execution slots in L1b are business lifecycle state that diagnostics cannot change on failure.

### L2 All critical flows

Complete section 8 using consistent events and correlation in place of relevant scattered console output. Connect existing SessionTiming entry points to spans so important work has evidence before completion. Retain business identity and causal links across background/scheduled retries and restarts.

Exit requires normal, failed and applicable recovered evidence for every listed flow, with one operationId linking host requests, commits and continued background execution.

### L3 Fault injection and release acceptance

After earlier batches and L2 coverage, complete integrated matrix regression, content/capacity/performance measurements and installed-package verification on both platforms. L3 does not replace L1a/L1b/L1c admission checks. Completion requires actual test evidence.

## 13 Acceptance matrix

L1a runs noninterference, basic resource bounds, privacy and export cases. Section 7 deadlines, snapshot cutoffs and execution slots belong to L1b and cannot gate L1a alone. L1c adds diagnostic stress/fault/platform tests, L2 adds flow-specific cases and L3 integrates release verification.

| Injected condition | Required result |
| --- | --- |
| Repeated dream model/validation failures and stale sources | Reasons, stages and progress visible, wait/deferred distinct, healthy reads not falsely blamed |
| Recovering owner, missing owner reply and missing Backend HTTP response | Total 10-second budget, identified boundary, late results cannot overwrite newer requests |
| Permanently pending optional data | Interaction and necessary replay independent, buffers bounded and ordered |
| Permanently pending required snapshot plus continuous pushes or buffer count/byte/age overflow | Recoverable error on deadline, stopped accumulation, fresh-generation resync, retained drafts/attachments and no stale overwrite |
| First read permanently pending then successful manual retry, and successive reads all pending | Release caller slots without old Promise reuse, independent first retry and immediate busy at actual execution capacity |
| Both reads time out, subsequently complete, then a third read | Settle readBatchId after waiter deletion, restore slots and allow the third read |
| Same-conversation old pushes during resync and deltas around snapshots | Trusted generation/cutoff without duplicates, gaps or regression, otherwise explicit failure |
| Interruption/cancel/withdrawal with missing transport settlement | Identify the attempt without releasing fences early |
| Foreground/background/scheduled failures and crash recovery | Connect attempts by business identity without timeout-induced duplicate writes |
| Blocked Backend/DSH event loop or process exit | Supervisor records missing health/exit, native export succeeds |
| Database busy, stuck Worker and host-mark catch-up | Explicit stage/resource/duration rather than generic model errors |
| Full disk, access denial, oversized events and flooding | Business proceeds, bounded memory/storage and observable losses/sink failure |
| Throwing diagnostic port, directory creation failure or async sink rejection | Unchanged write/forget/retrieve/fence outcomes, isolated diagnostics and original business errors preserved |
| Valid business with missing/unknown-version/malformed trace or span/unknown diagnostic fields | Only local root/context_dropped changes, identical business outcomes/receipts/admission and unchanged MEMORY_HOST_PROTOCOL |
| Toggle diagnostics at exact business/full-message limits, one additional diagnostic byte, multibyte UTF-8 and escaped values | Actual encoded bytes govern. Omit only diagnostics when over budget and preserve original business admission without increasing 32 MiB or other existing limits |
| Invalid/oversized diagnostics through Viva sender, or bypass sender with an oversized full message | Bounded validation/encoding falls back on sender. Receiver still rejects oversized messages with existing 413 and no promise of post-parse recovery |
| Invalid business authentication/protocol/input with valid or invalid diagnostics | Existing business rejection, no relaxed boundary or raw rejected values |
| Permanently pending log write | Bounded memory including in-flight bytes, one outstanding I/O, visible drops and no business wait |
| Wrapped sync/async calls, nested concurrency, cancellation and the same thrown error object | Preserved values/error/this/cancellation, isolated context and no business effect from diagnostic failure |
| Pino/SonicBoom startup failure, drop, partial write, rotation, flush and exit | Actual encoding reconciles reservations, no leaked surplus, backpressure distinct from drop and shared buffer accounting |
| Persistent EBUSY/EAGAIN, hanging flush fsync and failed old-file close | No infinite library retries, no slot reuse/new destination before close confirmation and bounded shutdown |
| Content, paths, secrets and URLs in message/name/function/module/generated names | Test sentinels absent from normal/debug logs and ZIP |
| Forgetting followed by log/cache inspection | No forgotten content copies and receipts survive clearing diagnostics |
| Clearing during execution, late old generation, unresponsive writer or failed deletion | New salt/diagnosticRunId, no reused aliases/caches, business continues with real slots intact and incomplete cleanup_pending |
| Same raw identities before/after clearing and existing exports | Different generation aliases, old ZIP unchanged, no promise that timing metadata cannot be correlated |
| Stuck Renderer/Backend, export rotation and repeated clicks | Native menu works, one export, pinned ranges share the hard log quota and ZIP discloses omissions/ranges |
| JSONL cutoff within a record/UTF-8 character, incomplete first row or crash tail | Newline-complete records only, manifest source cutoff/export range/output bytes and partial_trailing_record without false corruption |
| Valid A, newline-terminated malformed JSON with a secret sentinel, valid B | A/B exported, invalid_record increments once, no secret/raw malformed line in ZIP/manifest, partial_trailing_record=false and trailingBytesOmitted=0 |
| Permanently pending export read/write or unconfirmed child termination | User wait ends within 30 seconds, no success for unfinished ZIP, bounded process/temp files and retained cleanup_pending quota |
| Active/pinned files, repeated exits, PID reuse and failed cleanup | File-slot hard budget holds, PID alone never authorizes reclaim and failure causes drops rather than growth |
| Isolated standalone DSH/dsh-web | No Viva dependency and diagnostic evidence for write/forget/retrieve |
| DSH emit/waterfall/serial hooks, stream cancellation and plugin disposal | Exactly one next, preserved results/errors/retries/signals, no diagnostic I/O wait or leaked observers |
| Local-profile feedback, turn completion and export | No non-loopback diagnostic connections or remote exporter, no native-log/trace additions to model requests |
| Secrets in Cordis args, native Session bodies, startup reports and fetch capture | Default files/ZIP contain allowlisted metadata only, no content or credential sentinels |

Use TypeScript regression tests and existing strict checks for contracts, limits, rotation, correlation, deadlines and state behavior. IPC, lifecycle, build or plugin packaging changes require local build and full smoke. PR CI covers macOS and Windows. Run check:i18n for documentation.

Compare enabled/disabled diagnostics against the same fixed workload on the same computer. Report event volume, flush latency, peak queue, losses and main-flow P95. Initial default-load targets require P95 growth no greater than 5% and an absolute increase no greater than 10ms. Saturation must demonstrate bounded queues and no waiting on sinks. Hung log I/O must not block callers. Tune implementation and frequency before release if targets fail.

## 14 L1a implementation status

The first batch is on the isolated `codex/local-diagnostics` branch, based on `84c16d3`, separate from test-engineering work in the original workspace. Only new test ownership and cost entries were registered on this branch; the original workspace's runner was not modified.

- The [portable contract](../src/diagnostics/contracts.ts) imports no Node, Electron or DSH modules. Core receives an optional, nonthrowing diagnostic port. Node adapters own ALS, Pino/SonicBoom, identity aliases, quotas and export, with no reverse dependencies on product code.
- L1a coverage includes the Renderer memory-read entry, Shell/Backend RPC, the owner channel, five read steps, all dream phases and parsing/validation retries, effects, physical send fences and process exit/restart. Model requests and business receipts keep their semantics. L1a diagnostics alone did not raise MEMORY_HOST_PROTOCOL; section 15 describes L1b's subsequent business-protocol upgrade.
- Event allowlists precede Pino redact. Pending objects reserve a conservative memory bound, reconciled to actual UTF-8 bytes after encoding, including destination in-flight data. Summary floods leave room for starts, terminal events and failures. Rotation and shutdown wait for actual file closure and quota receipts within the same two-second shutdown budget.
- The adapter first obtains an exclusive file descriptor asynchronously, then hands it to SonicBoom, avoiding periodic flush after the library's failed-open lifecycle. Open failures, quota exhaustion and diagnostic-port exceptions degrade independently; SonicBoom cannot retry EAGAIN indefinitely. RPC sends a view of the existing business encoding plus a small suffix, avoiding a large body copy; diagnostics alone are removed when they would exceed the existing 32 MiB limit.
- The macOS native menu and Windows tray offer local ZIP export and opening the log directory. A separate child exports without memory:get, under concurrency, deadline, source-range and output-size limits, distinguishing corrupt complete rows from partial trailing records. Only Shell/Renderer provide live snapshots; other missing components are identified in the manifest, without claiming heartbeats exist.
- Viva profiles explicitly disable DSH OTEL. The standalone DSH Web acceptance profile disables both OTEL and native-log upload. The plugin does not change another host's global telemetry policy.

The temporary export path is stored only in the private quota inventory to recover cleanup after a confirmed export-process exit. It never enters JSONL or ZIP output. Build commit currently reads `unknown`; release-build revision injection belongs to L3. The initial L1a batch did not ship clear, debug controls or a settings entry. Section 16 covers subsequent native controls; the settings entry remains outstanding.

Validation commands include `npm run typecheck`, `npm test`, `npm run build`, `npm run smoke`, `npm run test:memory-plugin`, `npm run smoke:memory-plugin` and `npm run check:i18n`. There is also a [framework microbenchmark](../scripts/benchmark-diagnostics.ts), [interleaved real memory:get comparison](../scripts/benchmark-memory-diagnostics.ts) and [native export fault injection](../scripts/smoke-local-diagnostics.ts). The latter suspends its own test Backend and Renderer on macOS, verifies native-menu export, then resumes and closes them. Targeted Windows fault injection and installer checks remain in L1c/L3 and are not claimed here.

The final real memory:get comparison was 3.263875ms → 3.690667ms, an increase of 0.426792ms / 13.0762%, with no losses. It fails section 13's original performance gate; L1a acceptance remains incomplete and the target has not been relaxed. Performance optimization scope is now frozen. Full evidence and remaining validation appear in the Chinese [implementation record](qa-logging-l1a-implementation-20261117.zh-CN.md).

The L1a record does not include L1b business fixes; section 15 tracks those, section 16 tracks L1c and section 17 tracks L2. L3 release acceptance remains incomplete.

## 15 L1b implementation status

L1b uses the same isolated worktree without modifying the original workspace's test-engineering work. Startup awaits only the trusted conversation snapshot. Memory, settings, working-directory, feed and independent task loading do not gate foreground initialization. Required snapshots have a 30-second total budget, including cancellable Shell HTTP resources. Initialization and selection buffers each allow at most 1024 events, a conservative 2 MiB retained-content bound and a 15-second oldest age. They retain serialized content rather than extra event object graphs. Failure stops accumulation, preserves drafts, images and files, discloses gaps and offers manual retry. Model sends remain blocked until safe state is restored.

A separate Backend publication adapter assigns actual pushes a streamGeneration and eventCursor. History saves include the owning conversation and applied watermark; stale selections or regressing cutoffs cannot overwrite current state. Required snapshots capture history and the publication boundary synchronously and include ordered foreground replay after the saved cutoff. The Renderer rejects superseded initialization callbacks, retired generations, duplicate cursors and incomplete replay. Unprovable completeness remains a failure. Withdrawn generated content cannot return from the replay cache.

memory:get establishes local monotonic deadlines in Renderer, Shell, Backend and the owner channel. Only remaining durations cross processes. The ten-second total budget also covers missing responses and host-mark catch-up, while each child read retains the existing thirty-second ceiling. All five read semantics remain. Only unexpired same-page refreshes coalesce; retry after timeout gets fresh request identities and late results cannot overwrite the UI.

The trusted Backend owner channel owns actual readBatchId execution accounting, with at most two page-read batches per owner epoch. Caller timeout or recovering/unavailable status does not release unfinished executions. Authenticated terminal replies settle execution before consulting caller waiters. Only completed sent reads, proven non-dispatch, owner exit or epoch replacement release capacity. Full capacity returns busy immediately; recovery returns unavailable. Mutation receipts and DSH send fences remain intact. These business fields raise MEMORY_HOST_PROTOCOL to 3 independently of L1a's discardable diagnostic envelope.

Regression covers a real owner's pending dream model, repeated timeouts and persisted recovery alongside all five page reads; two timed-out reads followed by busy and successful retry after late settlement; same-epoch recovery/unavailability; epoch replacement; HTTP response loss; required-snapshot deadlines; buffer bounds; stale pushes and diagnostic-port failure. The [availability smoke](../scripts/smoke-memory-availability.ts) exercises actual SIGSTOP. Synthetic drawer streams now use the existing automation driver and actual Backend publication boundary; runners and CI are unchanged. Final evidence and platform limits appear in the Chinese [implementation record](qa-logging-l1b-implementation-20261118.zh-CN.md). L1a's failed performance gate remains recorded and is not reclassified by L1b.


## 16 L1c implementation progress

As of 2026-11-18, bounded diagnostic IPC supervises Backend→Shell and DSH→Backend independently of business HTTP/effects. Both renderer preloads are supervised separately. Startup explicitly distinguishes health messages from ready. Supervision reports suspect/recovery and sink state, never terminates processes or releases business barriers. Recursive diagnostic snapshots reserve reply time at each relay; missing components remain explicit.

The native macOS menu and Windows tray now offer clear and debug limited to 15 minutes. Clear closes directory quota admission for new writers, waits for component acknowledgements and actual file closure, and rotates the salt/diagnosticRunId only after every slot is closed, no export pin remains and old files are deleted. A deadline reports cleanup_pending; unresolved actual controls retain capacity. Recovery retries the same clear identity, and retries after rotation resume rather than deleting the new generation again. Local business continuations use a fresh trace; retired remote diagnostic metadata is dropped. Read-batch capacity, owner epochs, tasks and send barriers are unchanged.

See the [L1c implementation record](qa-logging-l1c-implementation-20261118.zh-CN.md) for macOS evidence and the fault matrix: permanently pending writes/closure, partial writes, ENOSPC/EAGAIN/EACCES, unresponsive IPC, clear recovery, floods, retired callbacks and standalone plugin isolation. Native Windows fault/installed-artifact acceptance is outstanding, and the performance gate has not passed. L1 is therefore not claimed complete; L2/L3 retain their original scope.

## 17 L2 implementation progress

Metadata now covers foreground sending and actual settlement after cancellation, SessionTiming, background tasks and routing, schedules and reports, daily intake, managed writes and undo, cleanup acknowledgements, retrieval/rebuild, SQLite, workers, HTTP/SSE, MCP and window lifecycles. Core depends only on a portable observation port; Node owns ALS, storage and host adapters. New events exclude queries, bodies, paths, report tokens, tool inputs/results and Error.message. Streaming records one first response, never individual tokens or animation frames.

Commit and retry events follow actual durable outcomes, excluding rolled-back writes and retired generations. Disabled portable async observation returns the original business Promise directly, avoiding extra microtasks that could change real receipt ordering. Daily jobs also had dream's unnecessary recovery-fence pattern. Only actual file intents or cleanup now enter recovery fencing; model failures, retry and runner restart leave unrelated foreground requests admitted. Actual commits and recovery still await physical request settlement.

The Chinese [L2 implementation record](qa-logging-l2-implementation-20261118.zh-CN.md) tracks regression and integration evidence. The original performance target and native Windows acceptance remain mandatory and are not marked passed by instrumentation coverage.

## 18 L3 release progress

Settings now uses the existing Shell diagnostic controls for export, directory opening, clear/retry, temporary debug and status, independently of the business Backend and memory:get. App and standalone-plugin builds inject the actual revision of a clean checkout; dirty sources and archives without Git remain explicitly unknown. The Chinese [L3 progress record](qa-logging-l3-progress-20261118.zh-CN.md) covers bilingual UI, state/actions/view boundaries, input preservation and actual narrow-window checks. Performance still exceeds section 13's 5% limit. Native Windows and installed-artifact acceptance remain outstanding, so the complete logging plan is not declared finished.

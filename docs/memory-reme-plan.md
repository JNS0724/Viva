# Viva file memory: ReMe behavioral reproduction

[简体中文](memory-reme-plan.zh-CN.md)

Status: 2026-11-15. R1 and R2 implemented; R3–R5 pending. This plan replaces the old memory organization, processing and retrieval design. Evidence validation, authorization, forgetting and request barriers remain requirements. No old-data migration; no ReMe service dependency; leave the comparison branch untouched.

## Reference and scope

Pin agentscope-ai/ReMe to `b13034ba2ff7339bb03df4fa4ee130b47a731c6c`. Reproduce text Auto Memory, Auto Dream, Markdown file semantics and search. Follow session → daily → digest, frontmatter/Sources/wikilinks, Extract → Integrate → Finish → Auto Tag, separate node/chunk search, AST chunking and weighted RRF. Exclude images, resources, proactive discovery, a second atomic-fact store, Hindsight layers, multi-hop agents and additional rerankers.

Explicit Viva differences: backend-owned permissions and provenance, staged model writes, source/version validation, forgetting barriers, local embeddings and durable SQLite task metadata. ReMe itself does not provide transactions over arbitrary Agent file edits; a crash before a receipt can repeat edits. Failed dream inputs require a later scan covering their date. Failed tagging is not retried without another file change. Do not imply that reproduction alone proves production reliability.

## Files and ownership

Each authorized scope has a backend-selected root. Models use relative paths only:

```text
session/dialog/<session-id>.jsonl
daily/YYYY-MM-DD.md
daily/YYYY-MM-DD/<name>.md
digest/{personal,procedure,wiki}/<name>.md
metadata/
```

Markdown is authoritative for daily/digest. SQLite owns operations, receipts, dependency versions, exclusions and derived indexes, not a second memory truth. Backend metadata owns authors, source IDs and source versions. Frontmatter preserves name, description and extra fields; daily links session_id/source_conversation; entity tags use memory_tags. Daily uniqueness uses session/date, not its readable filename. Renames redirect incoming links.

Sources are explanatory sentences linking to full workspace-relative material paths. Digest relationships are contextual wikilinks. Do not append extensions implicitly; anchors and display labels are distinct from the target path. Read uses separate line arguments. Reject absolute/traversal/control-character/backslash paths and symlink traversal. One backend owns writes. Content hashes identify file snapshots, not global request-barrier revisions.

## Auto Memory

Consume completed turns, necessary preceding context, trusted IDs/authors/event times, a stable request ID and the existing daily card. Preserve speaker attribution; filter tool results and binary content. Assistant messages provide context, not user evidence. Record useful facts, preferences, decisions with reasons, progress and reusable experience. Update the day index. Backend resolves filename collisions and ownership. Use message dates in the configured timezone; recovery time must not redate history.

Replay completed identical requests; reject a reused ID with different input. A true no-content skip differs from computation failure. Mark turns complete only after saving the card. Reject stale results if dependencies changed. Newly saved daily material is searchable immediately.

## Auto Dream

Extract refreshes day indexes and scans changed daily versions. Emit `{units:[{name,bucket,summary,paths}]}` across files, not one summary per file. Paths must belong to changed input. Buckets are personal/procedure/wiki; unknown strings fall back to wiki like the reference. Merge same-name units within a scope, union paths and keep the richer summary. Valid empty output is success; malformed output gets the reference bounded correction attempt, then failure. Split unprocessable multi-file requests. Never checkpoint failed, unseen or budget-deferred input.

Integrate runs once per unit with node_search, read, frontmatter_read, write, edit and frontmatter_update. Retrieve node summaries first, read likely candidates, distinguish same_abstraction/related/unrelated. Choose CREATE/CORROBORATE/REFINE/CORRECT, write exactly one digest target, and do not SKIP. Preserve sources and links; explain supporting and related links in prose. CREATE uses the proposed bucket; updates may target an existing abstraction in another bucket.

All model edits affect an isolated draft. Verify the final target, receipt, sources, scope and expected versions before commit. Span checks establish provenance, not semantic correctness; semantic validation must cover negation, time, conditions and third-party attribution. Failed validation leaves work pending. Return `{action,target_path,note}` and verify it against actual staged edits.

Finish checkpoints only processed input with no dependent failed unit, using the version originally read. Changes during processing remain pending. Auto Tag touches only actually changed files, once per file. Tag failure does not roll back successful integration or alter checkpoint decisions; no invented tag retry policy.

## Reference defaults

Defaults come from the pinned DSH integration, default.yaml, DreamExtractStep and SearchStep, not a universal ReMe setting: note interval 5 turns; integration timezone Asia/Shanghai and dream time 23:00; scan days 2; max units 5; dream batch budget 40,000 file bytes and per-file read limit 60,000 Unicode characters (oversized files form their own batch; truncated reads carry a marker); search limit 5, maximum 50; candidates min(200, limit × 5); vector weight .7; RRF k 60; min_score 0; chunk byte target 10,000; inbound/outbound neighbors at most 10 each. Verify behavior and units, not just numeric equality. Local embeddings are enabled by Viva choice; ReMe disables them by default.

## Retrieval and indexing

node_search retrieves digest node summaries for integration. search retrieves daily/digest chunks, fuses lexical and vector candidates, and uses single-arm ranking on fallback. Scores are not probabilities. AST chunking preserves frontmatter, ancestor headings, tables, code, lists, wikilinks and original line ranges. No arbitrary recent-file or prefix truncation.

Results carry path, lines, text, scores, neighbor summaries and counts. Distinguish no matches from results already delivered to the tool context; invalidate dedup on revision change. Startup scan and file changes update nodes, chunks, links, lexical and vector indexes; deletion removes all derived data. Like ReMe, reindex rebuilds from accepted chunk snapshots; filesystem rescan is separate. An embedding-space change disables old-space retrieval until rebuild completes.

## Changes, forgetting and recovery

CORRECT is an evidenced document revision, not latest-write-wins. Ordinary history remains; explicit forgetting overrides the normal additive-link policy. Commit exclusion and global revision first, immediately block reads/model requests/stale result commits, then clean sources, daily, digest, history and indexes. Hide mixed-source documents and rebuild from remaining evidence. Distinguish evidence dependencies from merely related links; do not delete every connected document.

There is no cross-medium SQLite/filesystem transaction. Persist an operation intent with expected source/target versions and the new hash; sync a same-directory temporary file, atomically replace, then finalize the receipt. Recovery compares actual hashes: new → finalize; old → retry; other → conflict. Multi-file card/day-index updates need recoverable plans, and partially published plans stay invisible to models. Watchers ignore temporary files. Single-file rename alone is not a complete transaction.

## Layers and delivery

Shared contracts are Node-free. Document parsing is pure. File storage handles snapshots, atomic IO and path containment. Runtime owns authorization, evidence, effects and commits. Compute adapters return drafts and receipts. Search owns derived indexes and filtering; UI reads backend snapshots.

| Phase | Deliverable | Exit criteria |
| --- | --- | --- |
| R1 | Document/path/unit contracts and file storage | Real file roundtrip, stale writes, containment, metadata preservation; runtime not enabled |
| R2 | session/daily, day index, commit intents | Ingestion, receipts, rename and crash recovery |
| R3 | Four dream stages and node_search | Four actions, single target, multi-source units, failed checkpoints; remove dream-to-discrete-extraction path |
| R4 | AST, indexes, search tools and links | Reference fixture parity, tail hits, structured blocks, dates and rebuild |
| R5 | UI, forgetting and request barriers | Remove old-fact dual reads; real DSH retries, recovery and copy cleanup |

Every batch runs relevant TypeScript tests and full typecheck; docs run check:i18n. Before runtime rollout run full tests, build and local memory smoke; follow repository CI rules for macOS/Windows PR acceptance. Do not claim the reproduction is shipped before R5.

## Acceptance

Cover daily uniqueness; request replay/mismatch; message dates; merged abstractions; all four actions; invalid/bare provenance links, unauthorized/multiple targets; partial failures; edits during compute; rename backlinks; tag failures; vector fallback; exact lines and table/code structure; tool-context dedup; restart; in-flight forgetting; scope isolation and request barriers. Separately evaluate real-model Chinese short replies, quotations, negation, conditions, historical corrections, procedures and preferences. Mock tests do not establish semantic quality.

## Progress

R1 provides shared unit/receipt/path contracts, frontmatter roundtrips, line reads and file snapshots.

R2 connects completed turns to session JSONL and makes Markdown authoritative for daily content. SQLite keeps identities, source versions, work, pending commit plans and receipts. It uses the existing `VIVA_DAILY_MEMORY=1` experimental switch; the default runtime is not switched and no ReMe service is used. Backend provenance selects a hashed authorization workspace; filesystem session names are hashed session IDs, with original IDs in JSONL/frontmatter. Message time and configured timezone determine the day. One card per session/day is maintained through renames, inbound-link and day-index updates, portable long names and collision handling.

Identical requests replay receipts; changed input is rejected. Skip is successful; model failures remain pending. Commits validate source versions, original content and file hashes. Assistant messages keep their own role and provide context only. Written files immediately enter the existing daily retrieval path.

Intents persist before file replacement. Receipt and turn checkpoint commit in one SQL transaction. Recovery recognizes old/new hashes, quarantines third-hash conflicts and hides every member of an unfinished plan. Invalid sources or superseded jobs cannot commit. Completed plans discard their content copies. Files and directories are synced (files only on Windows); writes still require one backend owner, with no cross-process CAS guarantee.

Withdrawal immediately hides cards and durably cleans transcript copies, cards and day-index links. Complete digest/history/index cleanup, external-file scanning and UI states remain R4/R5 acceptance work. R3–R5 are pending; dream still temporarily delegates to the old discrete extraction path, to be replaced by the four-stage document pipeline.

Validation covers real process death at intent, replacement, receipt and checkpoint boundaries, session append and rename recovery, external edits, source-version changes, duplicate requests, scope isolation and model failures. The full suite passes (see delivery logs for the exact totals); typecheck, build, check:i18n and local memory smoke pass. Memory smoke covers the existing default path; a real DSH completed-turn integration test separately covers the new daily pipeline.

The previous schedule-query failure did not recur in this full run or eight targeted diagnostic runs. A reproducible assertion defect was fixed: checking only the last message misses tool output followed by a runtime notice. Assertions now match schedule_list/schedule_update results by call ID. Regression tests cover trailing notices, unmatched calls and other tools. The original failure lacks request snapshots, so this defect cannot be asserted as its sole cause. Failed assertions now retain the schedule list, matched results and last messages for diagnosis.

### R2 review and repair cycle

Three sub-agents reviewed storage recovery, runtime integration and context regressions. All passed re-review after fixes. No predicate classification table was introduced.

- A completed receipt with an unfinished effect retires the old generation before processing the next batch. Renames atomically update inbound cards' hashes/revisions; invalidated sources cannot reappear during recovery.
- Cleanup uses nullable, owned card paths with expected hashes. External conflicts quarantine only the affected work. Partial withdrawal preserves independent user messages, removes derived assistant content and rebuilds the card.
- Assistant copies retain session-source dependencies; transient or stale context is not persisted. Cross-day short answers keep the preceding question within the same workspace/session. Request IDs retain original event identity, and raw input fingerprints remain separate from safe stored copies, preventing duplicate turns after withdrawal/replay.
- File mode retains complete session evidence across legacy extraction and candidate expiry. Actual note/dream text, titles, questions and assistant context are revalidated before dispatch and commit, including externally edited content.

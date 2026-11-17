# Viva Test Engineering Optimization Plan

English | [简体中文](test-engineering-optimization.zh-CN.md)

Date: 2026-11-17. This document defines the order of test-engineering and CI changes. The PR 0 metrics entry, PR 1 shared fixture cleanup and lane split, and PR 2 heavy-file splitting are implemented in the current worktree; PR 3 and later stages remain planned. The goal is faster feedback while preserving process isolation, failure recovery, privacy, and behavior acceptance on both shipping platforms.

## 1 Evidence and diagnosis

### 1.1 Measurement definitions

This plan records distinct metrics that must not be interchanged:

1. **Workflow wall time**: from workflow creation to aggregate check completion, including every job's queueing and execution.
2. **Job wall time**: from job start to finish, including checkout, dependency installation, build, tests, artifact upload, and cleanup.
3. **Test-step duration**: the time of an individual `npm test` or Playwright step.
4. **Node runner duration**: the runner-reported `duration_ms`.
5. **File wall time and case duration**: file wall time runs from a file's first scenario start to its last scenario finish; each scenario also reports a case duration. Summing case durations across concurrent files does not equal job or file wall time.

Review item [TEO-03](qa-test-engineering-optimization-review-20261117.zh-CN.md#teo-03-统一测量口径并更新场景清单) identified where the earlier plan labeled job time as `npm test` time and treated accumulated case durations as file time. Baselines and improvements must use the same level, and setup time cannot be removed from the measurement and then claimed as a test optimization.

### 1.2 Workflow and job baseline

| Run | Workflow wall time | Windows headless job | Windows test step | macOS memory integration job / Playwright |
| --- | ---: | ---: | ---: | ---: |
| [Before the memory change, #143](https://github.com/JNS0724/Viva/actions/runs/43679429767) | 5m 32s | 5m 20s | 3m 46s | 3m 27s / about 2m 36s |
| [`c3224d7` on main](https://github.com/JNS0724/Viva/actions/runs/44004336689) | 11m 39s | 11m 28s | 10m 13s | 6m 14s / about 4m 46s |
| [Latest UI PR](https://github.com/JNS0724/Viva/actions/runs/44060528772) | 13m 03s | 12m 57s | about 11m 15s; Node runner about 11m 9s | 5m 18s / about 4m |

Windows headless is the main bottleneck, not core UI smoke. Its current 15-minute timeout is nearly exhausted.

### 1.3 Heavy-file baseline

The following are **accumulated case durations**, used only to identify heavy scenarios and guide later sharding. They are not file or job wall times:

| Baseline | File | Cases | Accumulated case duration | Main cost |
| --- | --- | ---: | ---: | --- |
| Latest UI PR | `test/memory-handoff.test.ts` | 38 | 485.473s | Real Backend/DSH, process recovery, files and native replicas |
| `c3224d7` | `test/memory-file-host.test.ts` | 47 | about 143s | Owner, file journals, sources and forgetting |
| `c3224d7` | `test/memory-document-store.test.ts` | 29 | about 80s | SQLite, file commits and recovery |
| `c3224d7` | `test/memory-package.test.ts` | 4 | about 65s | Offline packing and installation |

PR 0 must regenerate the complete file and scenario inventory at one commit and record the commit, run, platform, and definitions above. The current 38 `memory-handoff` scenarios are the baseline for set equality before and after splitting; the earlier count of 27 must not be reused.

The current `fast` tier includes real SQLite and temporary-file work, so it no longer represents cheap tests. Serial execution inside `memory-handoff` is on the critical path. The independent memory, schedules, and lifecycle UI scenarios also run serially in one lane.

Conclusion: split heavy files, improve fixture cleanup, and move specialized acceptance to the right workflows before deleting core coverage or raising timeouts.

## 2 Goals and constraints

### 2.1 Measurable targets

Evaluate at least three successful CI runs after the first three stages:

- Overall **workflow wall time**: p50 at most 7 minutes and p95 at most 8 minutes.
- Windows **headless job wall time**: p95 at most 7 minutes, comfortably below the 15-minute timeout.
- macOS **memory integration job wall time**: p95 at most 3 minutes.
- No reduction in promised normal, failure, crash-recovery, or dual-platform coverage.
- Keep additional CI runner-minutes below 20% where practical; wall-clock feedback is the primary goal.

Also report test-step, Node-runner, file-wall, and case durations to explain the source of improvement, but they do not replace the workflow/job targets. Moving setup, dependency installation, or artifact upload does not count as a test-execution optimization. Package and performance workflows are timed separately; moving a scenario out of check alone must not be claimed as a reduction in total engineering time.

These are initial thresholds, to be adjusted against the next baseline rather than declared met from one successful run.

### 2.2 Constraints that must remain

- Keep Playwright at `workers: 1` and `fullyParallel: false` per desktop runner. Parallelize through isolated jobs, not concurrent desktops.
- Never hide failures with reruns; retain original traces, screenshots, and logs.
- Do not share stateful DSH processes, application instances, or business databases for speed.
- Do not remove native-erasure, send-fence, crash-recovery, or Windows file-semantics tests to save time.
- Do not treat a larger job timeout as optimization.

## 3 Test tiers and coverage policy

Replace `fast / integration / timing` with:

| Tier | Contents | PR policy |
| --- | --- | --- |
| `unit` | Reviewed pure functions, reducers, schemas, DOM without external processes, and pure state logic | Once on one platform |
| `io` | SQLite, real files, journals, permissions, deletion, indexes and WAL | macOS and Windows |
| `process` | DSH, HTTP, Workers, real process lifecycle, recovery, and functional timing contracts | macOS and Windows |
| `perf` | Scenarios whose primary purpose is performance measurements and large-load benchmarks | Specialized or scheduled workflow; required before release |

**Every test file must still be explicitly assigned to exactly one tier.** There is no default `unit`, and an unregistered file cannot silently gain single-platform eligibility. Registration may be simplified through directory-level lists or less repetitive structures, but the classification audit remains mandatory.

An unregistered new file must fail the audit; category counts alone are insufficient. Only files explicitly reviewed as pure `unit` logic may be deduplicated across platforms. Acceptance includes a virtual feature-recognized path with no cost classification, which must produce a classification error. Preserve complete JS/TS discovery and duplicate-classification checks.

`perf` describes measurement intent, not elapsed duration. The `backend-wire-timing.test.ts` cases “RPC still succeeds after an idle connection” and “a later request proceeds after the required gap deadline” are functional correctness contracts and must remain in the dual-platform `process` PR set. Other functional timing tests for cancellation, recovery, request barriers, and timeout release must not leave PR merely because they wait longer. The old `timing` tier must not be migrated wholesale into `perf`.

## 4 Splitting heavy files

### 4.1 `memory-handoff`

Split by responsibility into roughly four files:

1. Source ingestion and routing.
2. Native tools, outputs and replica erasure.
3. Forgetting, crash recovery and context rebuilding.
4. Background and scheduled tasks.

Extract shared setup into a common fixture. Every test keeps independent temporary state. Preserve all original names and assertions. Do not select tests in CI by name pattern, which could silently omit new scenarios.

### 4.2 `memory-file-host` and `memory-document-store`

- Split `memory-file-host` into read/write versus forgetting/recovery groups.
- Split `memory-document-store` into commit/recovery versus revision-management groups.
- Balance files by measured CI critical path, not by line count or test count.

The purpose is to let Node's file-level concurrency shorten the existing critical path, not to reduce tests.

## 5 Fixture lifecycle optimization

`startHarness` and other temporary-directory fixtures share `scratch`. Tests in one file share an outer container but keep independent case directories. Each case directory is removed immediately after its resources close; finishing the file removes only the empty outer container:

```text
Temporary container per test file
  ├─ independent subdirectory for test-a: removed after its resources close
  ├─ independent subdirectory for test-b: removed after its resources close
  └─ independent subdirectory for test-c: removed after its resources close

Each test still closes its own DSH, Workers, SQLite and fake LLM
The empty container is deleted when the file finishes
```

Requirements:

- Keep independent subdirectories and business state per test.
- Close processes and databases before removing that case directory, preserving LIFO resource order and the Windows deletion wait of up to 15 seconds.
- Retain diagnostic directories when cleanup fails; do not hide a failure through container reuse.
- Do not defer recursive deletion of case directories that child processes may still hold until the end of the file; the first Windows CI run demonstrated cleanup failure and a stuck test process with that approach.

Only later evaluate sharing read-only build artifacts, profile templates, and fake-provider configuration. Never share mutable sessions.

## 6 CI orchestration

### 6.1 Existing boundaries to keep

- `core` keeps the shared UI smoke; it is not the main bottleneck.
- `package.yml` keeps installer and installed-application acceptance.
- The aggregate `check` retains its current status names and includes every required result.
- Each desktop runner still owns one desktop worker.

### 6.2 UI integration lanes

Replace the current two lanes:

- `interaction`
- `memory` (memory + schedules + lifecycle)

with three:

- `interaction`
- `memory`
- `schedules-lifecycle`

These scenarios already use independent Scenarios and application instances, so separate jobs are safe. Add only this lane initially to limit setup overhead.

### 6.3 Target headless shape after classification

| Job | Platforms | Contents |
| --- | --- | --- |
| `headless-unit` | macOS | Typecheck, all reviewed `unit`, check:i18n |
| `headless-integration` | macOS + Windows | All `io` and `process`, sharded by measured cost, including functional timing contracts |
| `core` | macOS + Windows | Existing shared UI smoke |
| `integration` | macOS + Windows | interaction, memory, schedules-lifecycle |
| `package` | Path-filtered, manual, release | Offline installation, installers and installed-app acceptance |
| `performance` | Specialized, scheduled, release | Large seeds and benchmarks whose primary purpose is measurement |

After splitting heavy files, keep all `io/process` coverage on both platforms first. Add another process shard only if measurements justify it; do not create many jobs up front.

## 7 Ownership of specialized acceptance

### Offline plugin installation

Move the full `memory-package` npm pack/install scenario to the package or memory-plugin workflow. Ordinary PR checks retain:

- Manifest and export contracts.
- Dependency closure and host-import rejection.
- Offline error codes and timeout bounds.
- Lightweight Node API smoke.

The specialized workflow remains mandatory when build scripts, plugin manifests, runtime dependencies, or shared memory code change.

### Performance and large seeds

Move only scenarios whose primary purpose is performance figures or large-load measurement to `smoke:perf` or a scheduled performance workflow. Each moved scenario must document its benchmark purpose and the tier that retains its correctness assertions in ordinary PRs.

Functional timing is outside this migration. The dual-platform `process` PR set must continue to include both functional contracts in `backend-wire-timing.test.ts`, together with cancellation, recovery, barrier, and timeout-release tests. Ordinary PRs may retain lightweight identity, migration, and correctness assertions for large seeds without reconstructing performance data.

### Repeated happy paths

Create a coverage matrix with a canonical tier for each capability:

- Core behavior: unit tests.
- Host/owner contracts: real-process integration.
- Primary user journeys: UI smoke.
- Installation artifacts: package.

A happy path should not be repeated at all three layers, but platform differences, crash recovery, functional timing, and safety boundaries must not be removed merely because they look repetitive.

## 8 Phased implementation

### PR 0: Baseline and observability (implemented)

- Save the complete file and scenario inventory at one commit, recording commit, run, platform, and classification.
- Report workflow, job, test-step, Node-runner, file-wall, and case durations separately, with the 20 slowest files and their measurement definitions.
- Establish the current set of 38 `memory-handoff` scenario names; the set must be identical before and after splitting.
- Summarize job duration and runner-minutes in the CI summary, with package and performance shown separately.

### PR 1: Low-risk fixture and lane changes (implemented)

- Share the temporary-directory fixture, removing case directories per test and empty containers per file.
- Split the schedules-lifecycle UI lane.
- Keep all tests and assertions unchanged.

### PR 2: Heavy-file splitting (implemented)

- Split `memory-handoff`, `memory-file-host`, and `memory-document-store`.
- Share fixtures while preserving names, coverage, and dual-platform execution.
- Remove the unused `createMemoryService/createMemoryClient` generic protocol and its tests, keeping `HostMemoryApi + remote-memory-channel` as the production protocol.
- Compare actual file critical paths and verify that extra setup does not negate the benefit; scenario sets must match before and after splitting.

### PR 3: Acceptance ownership and classification

- Introduce `unit / io / process / perf`, with every file explicitly and uniquely classified and no default tier.
- Add an unregistered-path audit case: it must fail rather than silently becoming macOS-only `unit`; preserve duplicate-classification and JS/TS discovery checks.
- Register `backend-wire-timing.test.ts` explicitly as dual-platform `process`, and review every other functional timing test individually.
- Move only genuine offline-install and performance-benchmark scenarios; verify complete discovery, proving that scenarios moved rather than disappeared.

### PR 4: Data-dependent deduplication

Only if targets are still unmet:

- Run only explicitly reviewed pure-logic `unit` tests on one platform.
- Add one cost-balanced process shard.
- Remove only repeated happy paths explicitly cleared by the coverage matrix.

## 9 Verification and delivery gates

Every stage must:

1. Run relevant tests and `npm run typecheck`; verify complete discovery after changing test selection.
2. Run `npm run build` and the matching smoke stage when smoke engineering or process lifecycle changes.
3. Keep test counts and coverage lists explainable; record old and new locations for moved scenarios.
4. Check macOS and Windows CI on the current commit; do not substitute local results for CI.
5. Compare workflow/job p50/p95, test-step durations, slowest files, and runner-minutes over at least three runs using identical definitions; never substitute job wall time for test time or accumulated case durations for wall time.
6. Verify scenario sets after splitting, especially the current 38 `memory-handoff` scenarios, with no loss or duplication.
7. Inspect traces, screenshots, and logs before any rerun; rerun only after confirming intermittency and document the reason.

The intended deliverable is not fewer test files. It is a shorter critical path, accurate classification, unchanged isolation, diagnosable failures, and provable complete coverage.

## 10 Risks and stop conditions

| Risk | Response |
| --- | --- |
| Extra setup makes sharding slower | Collapse excessive shards and rebalance from measurements |
| Shared fixtures leak state between tests | Keep per-test directories and resources; stop reusing mutable state on failure |
| An unregistered file is misclassified as single-platform `unit` | Fail the classification audit; only explicitly reviewed pure logic may be deduplicated |
| Functional timing is moved out of PR | Classify by purpose; keep `backend-wire-timing`, cancellation, recovery, and barrier tests in dual-platform `process` |
| Moving acceptance loses required coverage | Include specialized workflows explicitly in PR path filters and release gates; retain discovery lists |
| Time pressure removes safety coverage | Stop that optimization; privacy and recovery correctness take precedence |

If the first two stages do not shorten the critical path, analyze setup and cleanup overhead before considering broad test deletion.

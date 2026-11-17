# Viva Test Engineering Optimization Plan

English | [简体中文](test-engineering-optimization.zh-CN.md)

Initial draft: 2026-11-17. Reassessed: 2026-11-18. This document replaces the previous staged plan based on same-runner file splitting and file-level temporary-directory cleanup. The goal is a shorter CI critical path while preserving process isolation, failure recovery, privacy, and behavior acceptance on both shipping platforms.

## 1 Reassessment

### 1.1 Comparable evidence

| Run | Windows headless job | Windows Node runner | Result |
| --- | ---: | ---: | --- |
| [`c3224d7` on main](https://github.com/JNS0724/Viva/actions/runs/44004336689) | 688s | about 613s | Passed, but close to the 15-minute limit |
| [`a134bac` with same-runner splitting](https://github.com/JNS0724/Viva/actions/runs/44117048557) | 724s | 622.4s | Tests finished; a metrics path assertion failed |

Same-runner splitting did not shorten the Windows critical path and added about 36 seconds to the job. One run is insufficient for p95, but it is enough to reject further fine-grained splitting on the same runner as the main direction.

Independent UI jobs behaved differently: in [run 44112795498](https://github.com/JNS0724/Viva/actions/runs/44112795498), macOS memory integration fell from 374 seconds on main to 169 seconds. Assigning existing independent scenarios to independent runners worked; increasing file count within one test process did not.

The two temporary-directory attempts also exposed a resource-lifecycle ordering bug: the `scratch` deletion hook ran before the `startHarness` DSH-close hook. Although that ordering was subsequently corrected, there is no evidence that the directory redesign itself produced a benefit, so its risk and complexity are not retained.

### 1.2 Decisions on earlier stages

| Earlier change | Decision | Reason |
| --- | --- | --- |
| Metrics, JSON artifacts, and slow-file summaries | Keep and correct | They identify real costs; normalize Windows paths and exclude file-level runner events |
| Independent interaction, memory, and schedules-lifecycle UI jobs | Keep | Existing independent application instances produced a shorter memory critical path |
| Same-runner splitting of `memory-handoff`, `memory-file-host`, and `memory-document-store` | Revert | No wall-time benefit, with additional initialization and maintenance costs |
| File-level temporary containers and shared `scratch` redesign | Revert | No measured benefit and a previous resource-ordering regression |
| Removal of the generic memory client/service protocol with no production consumer | Keep as independent architecture cleanup | It removes dead code but is not counted as test acceleration |
| Documentation cleanup and review reports | Keep | Recorded separately from CI performance claims |

## 2 Measurement definitions and targets

Keep these measurements distinct:

1. **Workflow wall time**: creation to aggregate check completion, including queueing.
2. **Job wall time**: checkout, npm installation, build, tests, artifacts, and cleanup.
3. **Test-step duration**: one Node or Playwright command.
4. **Node-runner duration**: the runner-reported `duration_ms`.
5. **File wall time and case duration**: the file completion event includes file setup/hooks; case duration is per scenario. Accumulated case durations across concurrent work do not equal wall time.

Metric paths use `/` on every platform for comparability. File-level pass/fail events complete file records but never increment scenario totals. Artifact names retain platform, run id, and attempt; comparisons must identify the commit and run link.

Evaluate later improvements over at least three successful CI runs:

- Workflow p50 at most 7 minutes and p95 at most 8 minutes.
- Windows headless, or its equivalent subsequent job set, p95 at most 7 minutes.
- macOS memory integration p95 at most 3 minutes.
- Keep additional runner-minutes below 20% where practical.
- Do not reduce normal, failure, crash-recovery, privacy, or dual-platform coverage.

Moving setup, dependency installation, or artifact upload is not a test-execution improvement. Scenarios moved to specialized workflows must be timed separately; removing them from PR check alone is not a reduction in total engineering time.

## 3 Using the current cost evidence

Metrics from the split run remain useful for identifying costs, but not as proposed file boundaries:

- `memory-handoff-tasks`: about 190 seconds of file wall time, including real waits and recovery for background and scheduled tasks.
- `memory-package`: about 102 seconds, dominated by offline packing and installation.
- `memory-plugin`: about 72 seconds; separate installation acceptance from lightweight protocol checks case by case.
- File-host erasure and handoff recovery/native groups each cost about 76–86 seconds, involving real files, processes, and native copies.

After reverting the split, analyze these costs by scenario name and case duration rather than recreating files with these names. Functional waits are not automatically redundant. Offline installation and large performance measurements must have their specialized ownership confirmed before moving.

## 4 Revised route

### Stage A: Restore a trustworthy baseline (current PR)

- Restore the original three heavy test files with every scenario; remove same-runner splitting and shared mutable fixtures.
- Restore per-test resource closing and temporary-directory removal.
- Keep metrics with corrected Windows paths and scenario counts.
- Keep the three independent UI integration lanes.
- Obtain complete green macOS and Windows results and record a new comparable baseline.

This stage makes the PR reviewable and mergeable; it does not claim that Windows is already faster.

### Stage B: Explicit tiers and pure-logic platform deduplication

Replace `fast / integration / timing` with:

| Tier | Contents | PR policy |
| --- | --- | --- |
| `unit` | Pure functions, reducers, schemas, and pure state/DOM logic without external processes | Once on one platform |
| `io` | SQLite, real files, journals, permissions, deletion, indexes, and WAL | macOS and Windows |
| `process` | DSH, HTTP, Workers, real process lifecycle, recovery, and functional timing | macOS and Windows |
| `perf` | Benchmarks whose primary purpose is performance figures or large-load measurement | Specialized, scheduled, and before release |

Constraints:

- Every test file must have exactly one explicit tier. There is no default `unit`; an unregistered file fails the audit.
- The existing `fast` tier includes SQLite and real files and cannot simply be renamed `unit`.
- `backend-wire-timing`, cancellation, recovery, request barriers, and timeout release remain dual-platform `process`; elapsed time does not make them `perf`.
- Only reviewed pure `unit` files may be deduplicated across platforms. Prove collection completeness before changing CI.

### Stage C: Specialized acceptance ownership

- Move the full `memory-package` npm pack/install scenario to the package or memory-plugin workflow.
- Review `memory-plugin` case by case, moving only actual offline-install or artifact acceptance while retaining lightweight protocol and error contracts.
- Move only large seeds and benchmarks whose primary purpose is measurement to `smoke:perf` or a scheduled workflow.
- Record each scenario's old and new location and the correctness assertions retained in PR. Specialized workflows remain required when build scripts, manifests, or shared code change.

### Stage D: Split independent jobs only if still necessary

If Windows remains above target after stages B and C, distribute the complete `io/process` collection across **independent CI jobs**, not more files:

- Add only one cost-balanced process shard initially and compare wall-time gains with extra npm/setup costs.
- Use explicit, stable shard manifests. Verify that the union of shards, unit, and specialized performance coverage equals complete discovery, with only designed intersections.
- Do not select tests through temporary filename patterns that could silently omit new scenarios.
- Keep one desktop worker per runner and never share mutable DSH processes, application instances, or business databases.

### Stage E: Remove duplicate coverage last

Create a coverage matrix identifying the canonical unit, host/owner, UI, and installation-artifact tier for each capability. Delete a happy path only when it is repeated across layers and platform differences and failure boundaries remain covered elsewhere.

Do not remove native erasure, request barriers, crash recovery, functional timing, privacy, or Windows file semantics merely because they look repetitive.

## 5 Verification and stop conditions

Every stage must:

1. Run relevant tests and `npm run typecheck`; verify complete discovery after changing selection or classification.
2. Run `npm run build` and the matching smoke stage when smoke engineering or process lifecycle changes.
3. Retain before/after scenario lists, proving that tests moved rather than disappeared.
4. Check macOS and Windows CI on the current commit; local results do not replace CI.
5. Compare workflow/job p50/p95, test-step durations, slow scenarios, and runner-minutes over at least three runs.
6. Inspect logs, traces, and screenshots before rerunning; rerun only after confirming intermittency and document it in the PR.

Stop the corresponding optimization when:

- Setup, installation, or process startup offsets the wall-time benefit of a file or job shard.
- A shared fixture introduces cross-test state or changes resource-close ordering.
- The audit lets an unregistered file silently become single-platform.
- A specialized move or coverage deletion cannot prove that complete acceptance still runs.

The deliverable is not more or fewer test files. It is a shorter critical path, accurate tiers, unchanged isolation, diagnosable failures, and provable coverage.

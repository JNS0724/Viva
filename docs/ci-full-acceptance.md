# CI Full Acceptance and Test Ownership Plan

English | [简体中文](ci-full-acceptance.zh-CN.md)

Date: 2026-11-18. Status: updated proposal, not implemented. This document replaces earlier suggestions based on same-runner file splitting, temporary-directory redesign, and paid runners.

## 1 Decisions

- Use free standard GitHub-hosted runners for the public repository's daily and release acceptance.
- Use `macos-latest` and `windows-latest`; do not introduce paid larger runners or self-hosted machines.
- Give each full-acceptance job an independent **45-minute** budget. Keep `check.yml` PR jobs at 15 minutes rather than making them green by extending their timeout.
- Run full acceptance through `schedule` and `workflow_dispatch`; releases invoke the same collection through `workflow_call`.
- Do not split test files within a runner, change temporary-directory lifecycles, or automatically rerun failures.
- Clean up obsolete functionality only when its implementation has no production consumer; do not present that cleanup as CI acceleration.

A standard GitHub-hosted job can run for up to 6 hours, so 45-minute full acceptance needs no special machine. Current Windows failures come from the repository's own 15-minute limit, not an inherent GitHub restriction on full acceptance. See [standard runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) and [Actions limits](https://docs.github.com/en/actions/reference/limits).

## 2 Problem boundaries

#144 introduced file memory and the independent DSH plugin, substantially increasing the source suite. Under resource pressure, Windows headless approaches or exceeds 15 minutes, and individual real-process scenarios can still reach their own 15/45-second functional deadlines.

Handle these separately:

1. **Full-workflow job duration**: use the independent 45-minute budget.
2. **Per-scenario functional timeouts**: retain their deadlines and logs; investigate individually rather than hiding them behind the job budget.
3. **Default PR execution**: govern it through explicit test ownership, not by deleting useful coverage.
4. **Obsolete implementations**: remove them separately from CI changes.

## 3 Execution ownership

| Ownership | Contents | When it runs |
| --- | --- | --- |
| `unit` | Pure functions, reducers, schemas, and pure state/DOM logic without external processes | PR on one platform |
| `io` | SQLite, real files, journals, permissions, deletion, indexes, and WAL | PR on both platforms |
| `process-critical` | Key DSH lifecycle, primary recovery, safety, and send barriers | PR on both platforms |
| `process-extended` | Complete fault combinations, deep regressions, and less common recovery paths | Affected-PR specialization, daily, and release |
| `package` | npm pack/install, installers, and installed-application acceptance | Affected PRs, manual, and release |
| `perf` | Benchmarks whose primary purpose is performance figures or large-load measurement | Daily, manual, and release |

Without selection environment variables, local `npm test` and `npm run smoke` still run complete collections.

Functional timing is not a performance benchmark. Classify `backend-wire-timing`, cancellation, recovery, request barriers, and timeout release by correctness purpose; elapsed duration does not turn them into `perf`.

## 4 Workflow design

### 4.1 PR `check.yml`

Keep existing job and aggregate status names, and `retries: 0`:

- `headless`: macOS runs typecheck, pure `unit`, and documentation checks; both macOS and Windows run `io` and `process-critical`.
- `core`: retain public UI smoke.
- `integration`: retain current lanes and one worker per desktop runner; do not rearrange them in the same change.
- Keep `timeout-minutes` at 15.

### 4.2 Memory specialization for affected PRs

Add `memory.yml` to run the complete memory collection when `src/memory/**`, `plugins/memory/**`, related host adapters, or their tests change:

- Run on both macOS and Windows.
- Support `workflow_dispatch` and `workflow_call`.
- Affected PRs must pass; the fast PR collection must not bypass it.
- Use an independent duration budget without changing the 15-minute `check.yml` limit.

### 4.3 Package and performance acceptance

Extend the existing `package.yml` path coverage for memory sources, plugins, and build scripts, and run `npm run test:memory-plugin` there. Ordinary PRs retain lightweight manifest, export, and dependency-closure checks.

Playwright already has an independent `performance` project. Invoke `npm run smoke:perf` from the full workflow rather than adding another performance framework.

### 4.4 Daily and release full acceptance

Add `full.yml`:

```yaml
on:
  schedule:
    # 19:17 UTC = 03:17 in Beijing; avoid minute zero and thirty
    - cron: '17 19 * * *'
  workflow_dispatch:
  workflow_call:

jobs:
  full:
    strategy:
      fail-fast: false
      matrix:
        os: [macos-latest, windows-latest]
    runs-on: ${{ matrix.os }}
    timeout-minutes: 45
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
      - run: npm run build
      - run: npm run smoke
      - run: npm run smoke:perf
```

In `release.yml`, `publish` must depend on both `package` and `full`. Failure, cancellation, or absence of required full acceptance blocks publication.

Scheduled workflows can queue during busy periods, especially on macOS. Observe queueing and execution separately. The 45-minute budget limits job execution and does not eliminate platform queues.

## 5 Test policy and coverage reconciliation

### File-level policy

Turn `scripts/test-levels.ts` into explicit execution ownership while reusing JS/TS discovery, feature selection, and argument validation in `scripts/test-feature.ts`.

Every file must be registered exactly once. Unregistered files, duplicate registrations, nonexistent paths, and empty intended selections fail. There is no default `unit`, and a new file cannot silently gain single-platform eligibility.

The existing `fast` tier includes SQLite and real files and cannot simply be renamed `unit`. Only reviewed pure-logic files may be deduplicated across platforms.

### Scenario-level policy only for mixed heavy files

Do not migrate every test to a new framework. Use a narrow wrapper only for heavy files that mix critical and extended scenarios:

```ts
testCase({
  id: 'handoff/native-erasure-after-send-failure',
  title: 'Preserve the existing test title',
  tier: 'process-extended',
  watch: ['plugins/memory/lib/native/**']
}, options, fn)
```

Rules:

- IDs are stable and unique; titles remain available for log comparison.
- Unknown IDs, duplicate IDs, and title mismatches fail immediately.
- Mixed files cannot bypass the wrapper to register scenarios.
- Unselected scenarios are not registered and do not create misleading skipped results.
- Local runs register every scenario by default.
- Do not select scenarios through fuzzy name patterns.

### Completeness requirements

The audit must prove that:

- Every discovered file and every mixed-file scenario has a valid owner.
- A scenario moved to a specialized workflow exists in its new location and did not silently disappear.
- Daily and release collections equal the complete collection.
- A conditional workflow that did not trigger has an explicit reason; cancellation or skipping cannot masquerade as success.
- Aggregate check continues to reject failure, cancellation, skips, and missing required results.

## 6 Implementation order

1. **Establish the safety net first**: add `full.yml`, release dependencies, and path-triggered memory specialization without changing the PR collection.
2. **Register policy**: add file and scenario ownership audits and prove completeness through a full run.
3. **Move specialized acceptance**: move genuine offline installation and performance measurement first, reconciling before/after inventories.
4. **Enable the fast PR collection**: pure `unit` on one platform, critical `io/process` on both, and extended scenarios covered by specialization, daily, and release.
5. **Observe and roll back**: retain `VIVA_TEST_SCOPE=full` to restore the complete PR collection immediately; do not roll back the safety net.

Remove obsolete implementations in independent PRs rather than mixing them into these stages.

## 7 Acceptance criteria

- Daily and release runs execute 100% of the complete collection on free standard runners.
- Full jobs finish within 45 minutes and produce diagnosable artifacts and logs.
- `check.yml` remains at 15 minutes, without hiding failures through reruns or cancellation.
- An unregistered file or scenario always fails the audit.
- Neither `package` nor `full` failure permits publication.
- Observe at least the first five full runs, recording execution time, queueing, and per-scenario timeouts; do not claim stability from one run.
- If the complete collection consistently approaches 45 minutes, investigate real work and resource anomalies rather than extending timeouts again or deleting useful coverage.

The intended outcome is bounded PR feedback, complete specialized acceptance for affected changes, no missing scenarios in daily or release runs, and no additional runner expense for the public repository.

# CI Full Acceptance and Test Ownership Plan

English | [简体中文](ci-full-acceptance.zh-CN.md)

Date: 2026-11-18. Status: the safety net, conditional specialization gate, and file-level critical PR subset are implemented; pure-unit platform deduplication and scenario-level splitting of mixed files are not enabled. This document replaces earlier suggestions based on same-runner file splitting, temporary-directory redesign, and paid runners.

## 1 Decisions

- Use free standard GitHub-hosted runners for the public repository's daily and release acceptance.
- Use `macos-latest` and `windows-latest`; do not introduce paid larger runners or self-hosted machines.
- Give each full-acceptance job an independent **45-minute** budget. Keep `check.yml` PR jobs at 15 minutes rather than making them green by extending their timeout.
- Cover source tests, source smoke, performance, and installed-application acceptance every day; releases reuse the same callable workflows and package artifacts.
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
| `fast` | Pure logic plus reviewed SQLite, real-file, journal, and permission tests | PR on both platforms; a future pure-unit subset may run on one |
| `critical` | Key DSH lifecycle, primary recovery, safety, routing, and send barriers | PR on both platforms |
| `integration` | Complete fault combinations, deep regressions, and less common recovery paths | Affected-PR specialization, daily, and release |
| `package` | npm pack/install, installers, and installed-application acceptance | Affected PRs, daily, and release |
| `perf` | Benchmarks whose primary purpose is performance figures or large-load measurement | Daily, release, and manual |

Without selection environment variables, local `npm test` and `npm run smoke` still run complete collections.

Functional timing is not a performance benchmark. Classify `backend-wire-timing`, cancellation, recovery, request barriers, and timeout release by correctness purpose; elapsed duration does not turn them into `perf`.

## 4 Workflow design

### 4.1 Base PR checks

Keep the existing aggregate status names in `check.yml` and `retries: 0`:

- `headless`: both macOS and Windows run typecheck, documentation checks, and `npm run test:pr`, covering the fast, critical, and timing file subset. Extended integration belongs to affected specializations, daily, and release; package scenarios run only in package specialization.
- `core`: retain public UI smoke.
- `integration`: retain current lanes and one worker per desktop runner; do not rearrange them in the same change.
- Keep these jobs' `timeout-minutes` at 15.

### 4.2 Conditional specialization belongs to the same gate

Add reusable `memory.yml` to run the complete memory collection on macOS and Windows, with `workflow_dispatch` and `workflow_call`. Keep `workflow_call` in `package.yml` for affected PRs, daily acceptance, and releases.

A `scope` job in `check.yml` runs for every PR and main push and computes `memory-required` and `package-required`. Only this job sets `fetch-depth: 0` on `actions/checkout@v5` (or explicitly fetches both endpoints and their common ancestor); test-execution jobs remain shallow.

- `pull_request`: compare the merge-base diff between the PR base and head.
- Push to main: compare the event's `before` and `after`, covering the merged commit.
- Use NUL-separated records with rename detection, such as `git diff --name-status -M -z <range>`; match both old and new paths for renames and the original path for deletions. Do not use only the new paths returned by `--name-only`.
- If expected SHAs are missing for a known event, Git diff is unavailable, or the range cannot be computed reliably, enter an explicit conservative fallback that requires both specializations; never default to “not required.”
- Unknown events, exceptions in the scope script itself, and invalid output still fail `scope` and block the aggregate.

Scope tests cover an ordinary PR, a merged main push, running all specializations when a range is unavailable, blocking a scope-script exception, and moving `plugins/trace/lib/store.ts` to `archive/store.ts` while retaining `memory-required=true`. Also compare real shallow/full checkouts through a documentation PR: scope must obtain the comparison history and both specializations must skip as intended.

```yaml
memory:
  if: needs.scope.outputs.memory-required == 'true'
  needs: scope
  uses: ./.github/workflows/memory.yml

package:
  if: needs.scope.outputs.package-required == 'true'
  needs: scope
  uses: ./.github/workflows/package.yml
```

The final aggregate reads `scope`, both conditional specializations, and every base job:

| Scope evaluation | Specialized job | Aggregate outcome |
| --- | --- | --- |
| Scope-script exception or invalid output | Any | Fail |
| Range unavailable | Run both specializations | Judge both specialized results |
| Not required | Skipped because its condition was false | Allow |
| Required | Success | Allow |
| Required | Failure, cancellation, skip, or missing result | Fail |

Do not also run conditional specializations as separate path-triggered PR workflows, which would duplicate execution or leave their results outside the aggregate. Branch protection requires only the existing aggregate statuses; unrelated PRs never wait for a specialized status that will not be created.

Gate tests cover at least an unrelated PR passing, an affected PR being blocked by specialization failure, a merged main push using before/after, an unavailable range running every specialization, and a scope-script exception being blocked. `package` follows the same truth table.

### 4.3 Specialized trigger coverage

Memory scope cannot consist only of `src/memory/**` and `plugins/memory/**`. Include at least:

- Cross-directory production dependencies such as `plugins/trace/**`; `memory-handoff.test.ts` directly uses the trace store.
- Related `src/shared/**`, history, task, schedule, request, and provenance modules.
- Memory tests, `test/fixtures/**`, and related smoke engineering.
- `package.json`, `package-lock.json`, and build/test-selection scripts.
- Workflows, scope-evaluation scripts, and policy manifests themselves.

Each scenario or file's `watch` rules add its specific dependencies. The audit must include a case proving that changing only `plugins/trace/lib/store.ts` selects memory specialization. New cross-directory dependencies require corresponding watch updates; discovering an uncovered production dependency fails the audit instead of silently losing specialized acceptance.

`package.yml` scope covers memory sources, plugins, build scripts, lockfiles, and installed-artifact acceptance engineering. Ordinary PRs retain lightweight manifest, export, and dependency-closure checks.

Package jobs on both platforms explicitly run `npm run test:memory-plugin` after `npm ci` and before building the application installer. This executes the `memory-package.test.ts` scenarios for plugin npm pack, offline installation, exported APIs, and error boundaries. Gate acceptance includes a PR example that selects only package and asserts that every `memory-package` scenario actually ran, rather than merely checking that the workflow was called.

### 4.4 Daily and release full acceptance

Use three reusable entry points without duplicate builds:

- Add `npm run test:source` for the complete non-package source collection; local `npm test` continues to include package and therefore remains complete.
- `full.yml`: runs `npm ci`, `npm run typecheck`, `npm run test:source`, `npm run smoke`, and performance in order, with `workflow_dispatch` and `workflow_call`. Remove the explicit build before smoke; the existing `presmoke` performs the only source build for that round.
- `daily.yml`: calls both `full.yml` and `package.yml` every day, with `schedule` and `workflow_dispatch`.
- `release.yml`: calls `full.yml` and `package.yml` separately; `publish` needs both and publishes the installers uploaded by that `package` invocation.

Daily and release plugin offline installation belongs solely to `package.yml`; `test:source` in `full.yml` does not repeat `memory-package.test.ts`. Their union still covers complete product acceptance. Neither omits installed-application acceptance nor builds another copy of the installer. A tag-triggered `full.yml` must check out the release commit and complete typecheck at least once; a typecheck failure blocks `publish` just like a test failure. The first five runs must measure the 45-minute budget against this final deduplicated workload.

Add the top-level caller's run ID to the `package.yml` concurrency group, for example `package-${{ github.ref }}-${{ inputs.runKey || github.run_id }}`. The optional `workflow_call` input `runKey` receives the caller's own `github.run_id` from check, daily, and release; direct manual runs fall back to their current run ID. Cancellation for a newer PR commit remains the responsibility of the upper-level `check.yml` concurrency group. Manual packaging and daily acceptance use different groups and cannot cancel each other. Verify that manual packaging and daily acceptance on the same main branch can both complete.

The source and performance Playwright rounds in `full.yml` use different `VIVA_SMOKE_RUN` values:

```yaml
- run: npm run smoke
  env:
    VIVA_SMOKE_RUN: full-source-${{ matrix.os }}-${{ github.run_id }}-${{ github.run_attempt }}

- run: npm run smoke:perf
  env:
    VIVA_SMOKE_RUN: full-performance-${{ matrix.os }}-${{ github.run_id }}-${{ github.run_attempt }}

- if: always()
  uses: actions/upload-artifact@v4
  with:
    name: full-source-${{ matrix.os }}-${{ github.run_id }}-${{ github.run_attempt }}
    path: |
      smoke/full-source-${{ matrix.os }}-${{ github.run_id }}-${{ github.run_attempt }}/test-results
      smoke/full-source-${{ matrix.os }}-${{ github.run_id }}-${{ github.run_attempt }}/report
      smoke/full-source-${{ matrix.os }}-${{ github.run_id }}-${{ github.run_attempt }}/junit.xml

- if: always()
  uses: actions/upload-artifact@v4
  with:
    name: full-performance-${{ matrix.os }}-${{ github.run_id }}-${{ github.run_attempt }}
    path: |
      smoke/full-performance-${{ matrix.os }}-${{ github.run_id }}-${{ github.run_attempt }}/test-results
      smoke/full-performance-${{ matrix.os }}-${{ github.run_id }}-${{ github.run_attempt }}/report
      smoke/full-performance-${{ matrix.os }}-${{ github.run_id }}-${{ github.run_attempt }}/junit.xml
```

Source smoke retains traces, screenshots, and logs. Performance keeps its existing no-trace constraint and uploads only reports and results that actually exist. Both full jobs have a 45-minute budget. Scheduled runs may queue during busy periods; record queueing and execution separately.

## 5 Test policy and coverage reconciliation

### 5.1 Pure file-level policy

Turn `scripts/test-levels.ts` into explicit execution ownership while reusing JS/TS discovery, feature selection, and argument validation in `scripts/test-feature.ts`.

Register every purely file-owned test exactly once. Unregistered files, duplicate registrations, nonexistent paths, and empty intended selections fail. There is no default `unit`, and a new file cannot silently gain single-platform eligibility.

The existing `fast` tier includes SQLite and real files and cannot simply be renamed `unit`. Only reviewed pure-logic files may be deduplicated across platforms.

### 5.2 Mixed files use two-stage selection

A mixed file is marked `selection: 'scenario'` rather than assigned one forced tier. Every scenario has a stable ID, title, tier, and watch rules:

```ts
testCase({
  id: 'handoff/native-erasure-after-send-failure',
  title: 'Preserve the existing test title',
  tier: 'process-extended',
  watch: ['plugins/memory/lib/native/**']
}, options, fn)
```

Selection order is mandatory:

1. **File stage**: inspect every scenario in the file; if any scenario matches the current scope, pass the file to the test process.
2. **Scenario stage**: after loading the file, `testCase` registers only scenario IDs in the current scope.

Never exclude a mixed file through one file-level tier before scenario selection, or its critical scenarios will never load.

Additional rules:

- Unknown IDs, duplicate IDs, and title mismatches fail immediately.
- Mixed files cannot bypass the wrapper to register scenarios.
- Unselected scenarios are not registered and produce no misleading skipped results.
- Local and full runs register every scenario by default.
- Do not select scenarios through fuzzy name patterns.

For acceptance, use one file containing both `process-critical` and `process-extended` scenarios. Assert the actual IDs executed by an ordinary PR, an affected specialization, and a full run. Unselected IDs must neither execute nor appear as skipped.

### 5.3 Completeness requirements

The audit must prove that:

- Every discovered file and every mixed-file scenario has a valid owner.
- A scenario moved to a specialized workflow exists there and did not silently disappear.
- The combined daily and release source, performance, and installed-application collections equal the promised complete product collection.
- A conditional specialization may be skipped only when scope evaluation explicitly says it is not required.
- Aggregate check rejects scope failures and every unexpected failure, cancellation, skip, or missing result.
- The first source or performance failure has its own artifact; a later round cannot overwrite an earlier report.

## 6 Implementation order

1. **Establish the safety net first**: add `full.yml`, `daily.yml`, release dependencies, and complete installed-application acceptance without changing the PR collection.
2. **Connect conditional gates**: enable `scope`, reusable specializations, and the aggregate truth table before assigning PR scenarios to specializations.
3. **Register policy**: add file, scenario, and shared-dependency audits and prove completeness through a full run.
4. **Move specialized acceptance**: move genuine offline installation and performance measurement, reconciling before/after inventories and artifacts.
5. **Enable the fast PR collection**: pure `unit` on one platform, critical `io/process` on both, and extended scenarios covered by specialization, daily, and release.
6. **Observe and roll back**: retain `VIVA_TEST_SCOPE=full` to restore the complete PR collection immediately; do not roll back the safety net.

Remove obsolete implementations in independent PRs rather than mixing them into these stages.

## 7 Acceptance criteria

- Daily and release runs execute 100% of the promised collection on free standard runners, including installed applications.
- Unrelated PRs never wait for specialization; affected-PR specialization failures and scope-script exceptions block the aggregate gate.
- A merged main push uses before/after for scope; an unavailable range runs every specialization instead of falsely reporting none.
- Moving a file out of a watched directory matches both rename paths; a real documentation PR proves scope has the required Git history and skips both specializations.
- A package-only PR actually executes every `memory-package` offline-install and export scenario.
- Daily and release runs execute offline plugin installation only in package, and source smoke builds only once through `presmoke`; local `npm test` still runs the complete collection.
- Mixed files execute exactly the policy-selected scenario IDs in ordinary PRs, affected specializations, and full runs.
- Manual packaging and daily acceptance on the same main branch use different concurrency groups and can both complete.
- Full jobs finish within 45 minutes; the first five dual-platform full runs must validate whether this budget is sufficient.
- Source and performance reports use separate directories and upload their actual diagnostics even after failure.
- `check.yml` remains at 15 minutes, without hiding failures through reruns or cancellation.
- Unregistered files, scenarios, or shared dependencies fail the audit.
- The release commit completes typecheck at least once in `full.yml`; neither `package` nor `full` failure permits publication.
- If the complete collection consistently approaches 45 minutes, investigate real work and resource anomalies rather than extending timeouts again or deleting useful coverage.

The intended outcome is bounded PR feedback, merge-blocking specialized acceptance for affected changes, no missing source, performance, or installed-artifact coverage in daily and release runs, and no additional runner expense for the public repository.

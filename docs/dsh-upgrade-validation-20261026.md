# dsh upgrade compatibility validation (2026-10-26, Windows)

English | [简体中文](dsh-upgrade-validation-20261026.zh-CN.md)

## Conclusion and scope

Continue using ACP. Production stayed on `0.2.0-rc.2`; `0.2.1-rc.2` was tested in an isolated copy. Candidate dependencies/migration changes were not copied to the main project, installed, or released. This is a historical report, not verification of the current internationalization branch.

The candidate passed the listed checks after coordinating plugin peer versions, Zod, and the persona working-directory template; changing only three dsh package versions is insufficient. A production upgrade needs its own change and retest against current main.

- Original: `E:\viva\Viva`, workspace snapshot based on `c4c13d73a429d00ab2262e14119a4cb92f276fa4`, including concurrent background-task bubble changes but not subsequent P0/P1 session optimizations.
- Candidate: `E:\viva\dsh-upgrade-validation-20261026`.
- Outside-project packaged check: `E:\viva\dsh-packaged-validation-20261026`.
- Windows `10.0.26200`, Node `24.13.0`, Electron `44.7.0` with embedded Node `24.21.0`.
- Local fake Messages/SSE endpoints, test keys, and local MCP processes; no external model calls or messages.

## Version selection

At that time npm reported dsh `latest=0.2.1-rc.2`, `next=0.2.1-rc.3`; both were prereleases. The other packages' latest tags still pointed to older versions, so using latest everywhere was incorrect. The copy explicitly installed:

```text
@deepseek-ai/dsh                 0.2.1-rc.2
@deepseek-ai/dsh-native-command  0.2.1-rc.2
@deepseek-ai/dsh-tool-ask-user   0.2.1-rc.2
zod                            4.4.3
```

All Viva plugin exact dsh peers were aligned to rc.2. ACP SDK `1.9.0` and Electron `44.7.0` were unchanged.

## Breakages and fixes in the copy

### Removed system-prompt variable

Session creation succeeded, but prompting failed before any model request:

```text
Internal error: turn failed: unknown prompt variable "{{cwd}}" in section
"deployment:persona-suffix"; registered variables: provider, model
```

The original persona suffix used `{{cwd}}`. The candidate cleared it because the new default `dsh-working-directory` supplies `Current working directory: ...` as runtime context. The persona test was changed to assert that context. Model requests, memory, permissions, and streaming then resumed functioning.

### Exact Zod mismatch

The original root used `4.6.7`; candidate dsh session-projection/LLM packages required `4.4.3`. Initial typecheck exhausted roughly 4 GB heap; build reported `TS2589`/`TS2769` in memory projections with `_zod.version.minor` differing (`6` versus `4`). Aligning root Zod to `4.4.3` fixed both without casts or heap-limit masking.

### Temporary-directory permissions

Electron composition dumping initially hit `EPERM` creating a profile under system Temp. Pointing `TEMP`/`TMP` to the copy's existing `audit-temp` fixed it without product changes. This was an execution-environment permission boundary, not evidence of a candidate product regression.

## Results

| Check | Result | Scope |
|---|---|---|
| dsh/peer-only first attempt | Failed | Type/build errors; 15 of 17 critical tests failed, mainly the cwd template |
| Corrected typecheck/build | Passed | All project configs and out generation |
| Critical tests under Node | 17/17 | Streaming/cancel prefix, singleton MCP preparation isolation, auto/full permissions, no-send policy, memory tools/extraction/synthesis/resume, old-home migration |
| Same tests under Electron | 17/17 | Actual embedded Node runtime |
| Other plugin tests under Node | 31/31 | Config, preparation, fork, images, sources, model routing/switching, questions, steering, tasks, trace; some pure logic |
| Cross-version resume | Passed | Real old-version session resumed by candidate in same isolated home, same id and previous history in next request |
| Composition/dependency closure | Passed | Actual Electron ACP dump: 110 roots / 368 packages |
| Windows unpacked build | Passed | 368 packages, 36 added, 203 removed, 6,845 unused files removed; 9,973 asar files and 58 unpacked files |
| Packaged dsh outside project | Passed | Copied executable/asar ACP dump returned 98 config entries without repository node_modules fallback |
| NSIS install/upgrade, interactive GUI, real user data, other platforms | Not run | Unpacked/protocol tests are not substitutes |
| rc.3 full runtime/packaging regression | Not run | Only release notes/source reviewed; rc.2 passes do not extend to rc.3 |
| Candidate with latest P0/P1 changes | Not run | Copy preceded those changes; combination requires retest |

Passing covers only those scenarios, not arbitrary user MCPs, complex interrupted histories, or prolonged use.

## Reproduction

In the candidate copy, after explicitly changing package and plugin peer versions:

```powershell
npm install --no-audit --no-fund
npm install zod@4.4.3 --save-exact --no-audit --no-fund
npm run typecheck
npm run build
$env:DSH_NODE = (Get-Command node).Source
node --test test/stream-runtime.test.js test/prewarm-runtime.test.js test/permission-plugin.test.js test/policy-plugin.test.js test/memory-plugin.test.js test/dsh-home.test.js
node --test test/config-plugin.test.js test/followup-plugin.test.js test/fork-plugin.test.js test/images-bridge.test.js test/messages-plugin.test.js test/model-routes.test.js test/model-switch.test.js test/questions-plugin.test.js test/steer-plugin.test.js test/tasks-bridge.test.js test/trace-plugin.test.js
node audit-cross-version.mjs
```

Electron tests inherited output through a Node launcher so silent execution could not be mistaken for success:

```powershell
$env:TEMP = 'E:\viva\dsh-upgrade-validation-20261026\audit-temp'
$env:TMP = $env:TEMP
node -e "const env={...process.env,ELECTRON_RUN_AS_NODE:'1'};delete env.DSH_NODE;require('child_process').execFileSync(require('electron'),['--test','test/stream-runtime.test.js','test/prewarm-runtime.test.js','test/permission-plugin.test.js','test/policy-plugin.test.js','test/memory-plugin.test.js','test/dsh-home.test.js'],{stdio:'inherit',env})"
node -e "const r=require('./scripts/dsh-closure.cjs').shippedPackages(process.cwd());console.log(JSON.stringify({roots:r.roots,packages:r.keep.length}));require('fs').writeFileSync('closure-rc2.json',JSON.stringify(r,null,2))"
npx electron-builder --win --dir --publish never
```

The local audit copy retains `upgrade-0.2.1-rc.2.patch`, `upgrade-files.json`, `audit-cross-version.mjs`, `closure-rc2.json`, and `packaged-acp-dump.yml`. The patch includes lockfiles, manifests, and two source/test migrations; it was not applied to main. Compare newer changes before reuse rather than overwriting a live checkout.

## Benefits and remaining boundaries

Official 0.2.1 notes describe cancellation/timeouts, agent cleanup, resume compatibility, and persistent Windows PowerShell fixes. Source also improves ACP cancellation convergence. These warrant upgrade testing, but this run measured neither real-failure benefits nor faster new-topic creation.

ACP still mounts MCP per session sequentially and forwards committed assistant messages. Session preparation/switch orchestration remain useful; `viva-stream` cannot yet be removed. rc.3 mainly updates API-key-path model listings; its web menu/draft fixes do not directly improve Viva's frontend. Repeat compatibility checks before adopting it; the evidence did not justify skipping the tested rc.2 baseline.

Official release notes: [rc.1](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.1), [rc.2](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.2), [rc.3](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.3).

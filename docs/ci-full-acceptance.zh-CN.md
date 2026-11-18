# CI 完整验收与测试归属方案

[English](ci-full-acceptance.md) | 简体中文

日期：2026-11-18。状态：安全网、条件专项门禁和 package 分层已实施；PR 仍保留完整覆盖，快速集合尚未启用。本文取代此前以同机文件分片、临时目录改造和付费执行机为方向的建议。

## 1 当前决定

- 仓库是公开仓库，每日和发布完整验收使用免费的标准 GitHub-hosted runner。
- macOS 使用 `macos-latest`，Windows 使用 `windows-latest`，不引入付费 larger runner 或自托管机器。
- 完整验收的每个 job 使用独立的 **45 分钟**预算；PR 的 `check.yml` 仍保持 15 分钟，不靠提高 PR 超时获得绿色结果。
- 每日验收同时覆盖源码、源码冒烟、性能和安装后应用；发布复用相同的可调用工作流与打包产物。
- 不同机拆分测试文件、不修改临时目录生命周期、不自动重跑失败。
- 废弃功能清理只处理已证明没有生产消费者的实现和测试，不承担缩短 CI 的任务。

标准 runner 的单个 GitHub-hosted job 上限为 6 小时，因此 45 分钟完整验收不需要特殊机器。当前 Windows 失败来自项目工作流自行设置的 15 分钟上限，而不是 GitHub 对完整验收的固有限制。参考：[标准 runner](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) 与 [Actions limits](https://docs.github.com/en/actions/reference/limits)。

## 2 问题边界

#144 引入文件记忆和独立 DSH 插件后，完整源码测试显著增加。Windows headless 在资源紧张时接近或超过 15 分钟，个别真实进程场景还会触发自身的 15/45 秒功能超时。

因此需要分开处理：

1. **完整工作流的 job 总时长**：由独立的 45 分钟预算承接。
2. **单场景功能超时**：保留原期限和日志，逐个排查，不用 job 预算掩盖。
3. **PR 默认执行量**：通过显式测试归属控制，不通过删除有效覆盖控制。
4. **废弃实现**：单独清理，不与 CI 调整混在一个 PR。

## 3 执行归属

| 归属 | 内容 | 执行时机 |
| --- | --- | --- |
| `unit` | 纯函数、reducer、schema、无外部进程的纯状态/DOM 逻辑 | PR 单平台 |
| `io` | SQLite、真实文件、journal、权限、删除、索引和 WAL | PR 双平台 |
| `process-critical` | 关键 DSH 生命周期、主要恢复、安全和发送屏障 | PR 双平台 |
| `process-extended` | 完整故障组合、深度回归和较少见恢复路径 | 相关 PR 专项、每日、发布 |
| `package` | npm pack/install、安装包和安装后应用验收 | 相关 PR、每日、发布 |
| `perf` | 以性能数值或大型负载测量为主要目的的基准 | 每日、发布、手动 |

本地 `npm test` 和 `npm run smoke` 不设置选择环境变量时仍运行完整集合。

功能时限不是性能基准。`backend-wire-timing`、取消、恢复、请求屏障和超时放行继续按正确性归属分类，不因耗时较长而移成 `perf`。

## 4 工作流设计

### 4.1 PR 基础检查

保留 `check.yml` 现有聚合状态名称和 `retries: 0`：

- `headless`：当前完整覆盖阶段在 `package-required=false` 时运行完整 `npm test`，为 true 时运行 `test:source`，由 package 专项承接全部 4 个离线安装场景，避免重复执行。快速集合启用后，macOS 运行 typecheck、纯 `unit` 和文档检查；macOS 与 Windows 都运行 `io` 和 `process-critical`。
- `core`：保持公共 UI 冒烟。
- `integration`：保持当前 lane 和每个桌面 runner 单 worker，不与本方案同时重排。
- 这些 job 的 `timeout-minutes` 保持 15。

### 4.2 条件专项必须进入同一聚合门禁

新增可复用的 `memory.yml`，在 macOS 和 Windows 运行完整记忆集合，支持 `workflow_dispatch` 与 `workflow_call`。`package.yml` 同样保留 `workflow_call`，用于相关 PR、每日和发布。

`check.yml` 的每个 PR 和 main push 都运行一个 `scope` job，计算 `memory-required` 和 `package-required`。只有这个 job 的 `actions/checkout@v5` 设置 `fetch-depth: 0`（或显式获取比较双方及其共同祖先），其他执行测试的 job 继续使用浅克隆。

- `pull_request`：比较 PR base 与 head 的 merge-base diff。
- 推送到 main：比较事件的 `before` 与 `after`，覆盖合并后的提交。
- 使用带重命名检测的 NUL 分隔记录，例如 `git diff --name-status -M -z <range>`；重命名同时匹配旧路径和新路径，删除匹配原路径。不能只取 `--name-only` 返回的新路径。
- 已知事件缺少预期 SHA、Git diff 不可用或无法可靠计算范围时，明确进入保守回退，将两个专项都设为必需；不能默认成“不需要”。
- 未知事件、判断脚本自身异常或输出非法仍使 `scope` 失败并阻断聚合。

范围判断测试必须覆盖普通 PR、合并后的 main push、无法计算范围时运行全部专项、判断脚本异常被拦截，以及把 `plugins/trace/lib/store.ts` 移到 `archive/store.ts` 时仍得到 `memory-required=true`。另用一次真实浅/完整 checkout 对比验证文档 PR：scope 能取得比较历史，且两个专项均按预期跳过。

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

最终聚合读取 `scope`、两个条件专项及基础 job 的结果，按以下规则判断：

| 路径判断 | 专项状态 | 聚合结果 |
| --- | --- | --- |
| 判断脚本异常或输出非法 | 任意 | 失败 |
| 无法可靠计算范围 | 两个专项均运行 | 按两个专项结果判断 |
| 不需要 | 因条件未命中而 skipped | 允许 |
| 需要 | success | 允许 |
| 需要 | failure、cancelled、skipped、缺失 | 失败 |

条件专项不再以另一个独立、按路径触发的 PR 工作流重复运行，避免出现两份执行或一个游离于聚合之外的检查。分支保护只要求现有聚合状态即可，无关 PR 不会等待未触发的专项状态。

门禁测试至少覆盖：无关 PR 通过、相关 PR 专项失败被拦截、合并后的 main push 使用 before/after、范围不可用时全部专项运行、判断脚本异常被拦截；`package` 使用同样的真值表。

### 4.3 专项触发范围

记忆专项的判断范围不能只有 `src/memory/**` 和 `plugins/memory/**`，至少包括：

- `plugins/trace/**` 等跨目录生产依赖；`memory-handoff.test.ts` 直接使用 trace store。
- 相关 `src/shared/**`、history、task、schedule、request 和 provenance 模块。
- 记忆测试、`test/fixtures/**` 和相关 smoke 工程。
- `package.json`、`package-lock.json`、构建与测试选择脚本。
- 工作流、专项判断脚本和政策清单自身。

每个场景或文件的 `watch` 规则用于补充特定依赖。审计必须包含“只改 `plugins/trace/lib/store.ts` 会命中记忆专项”的用例。新增跨目录依赖时同步更新 watch；发现未覆盖的生产依赖应使审计失败，而不是静默失去专项验收。

`package.yml` 的触发范围同时覆盖记忆源码、插件、构建脚本、锁文件和安装后验收工程。普通 PR 保留轻量清单、导出和依赖闭包检查。

两个平台的 package job 都在 `npm ci` 后、应用安装器构建前显式运行 `npm run test:memory-plugin`，执行 `memory-package.test.ts` 的插件 npm pack、离线安装、导出 API 和错误边界场景。门禁验收包含一个只命中 package 的 PR 样例，断言实际执行全部 `memory-package` 场景，而不是只验证工作流被调用。

### 4.4 每日与发布完整验收

将职责拆成三个可复用入口，避免重复构建：

- 新增 `npm run test:source`，执行完整的非 package 源码测试集合；本地 `npm test` 仍包含 package，保持完整集合。
- `full.yml`：依次执行 `npm ci`、`npm run typecheck`、`npm run test:source`、`npm run smoke` 和 performance，支持 `workflow_dispatch`、`workflow_call`。不再在 smoke 前显式执行 build，由现有 `presmoke` 完成本轮唯一一次源码构建。
- `daily.yml`：每天同时调用 `full.yml` 与 `package.yml`，支持 `schedule`、`workflow_dispatch`。
- `release.yml`：分别调用 `full.yml` 与 `package.yml`，`publish` 同时依赖两者，发布直接使用该次 `package` 上传的安装器。

每日和发布的插件离线安装统一由 `package.yml` 执行，`full.yml` 的 `test:source` 不再重复 `memory-package.test.ts`；两个集合的并集仍覆盖完整产品验收。不会只跑源码而漏掉安装后应用，也不会重复构建安装器。发布标签触发的 `full.yml` 必须检出本次发布提交并至少完成一次 typecheck；类型检查失败与测试失败一样阻止 `publish`。前五次运行测量的 45 分钟预算必须基于这套去重后的最终工作量。

`package.yml` 的并发组加入顶层调用的 run ID，例如 `package-${{ github.ref }}-${{ inputs.runKey || github.run_id }}`。`workflow_call` 的可选 `runKey` 由 check、daily、release 分别传入自己的 `github.run_id`，直接手动运行时回退到本次 run ID。PR 新提交的取消仍由上层 `check.yml` 并发组负责；手动打包与每日任务使用不同组，不得互相取消。验收时验证同一 main 分支上的手动打包和每日验收可以各自完成。

`full.yml` 的源码与性能两轮 Playwright 使用不同的 `VIVA_SMOKE_RUN`：

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

源码 smoke 保留 trace、截图和日志；performance 继续遵循不记录 trace 的现有约束，只上传实际存在的报告与结果。两个完整 job 均使用 45 分钟预算。计划任务高峰期可能排队，排队时间与执行时间分别记录。

## 5 测试政策与覆盖对账

### 5.1 纯文件级政策

将 `scripts/test-levels.ts` 调整为显式执行归属，继续复用 `scripts/test-feature.ts` 的 JS/TS 发现、功能选择和参数校验。

纯文件级测试每个文件登记且只登记一次。未登记、重复登记、路径不存在或空目标集合均失败。没有默认 `unit`，新文件不能自动获得单平台资格。

现有 `fast` 包含 SQLite 和真实文件，不能整体改名为 `unit`。只有审定后的纯逻辑文件才能进行平台去重。

### 5.2 混合文件使用两阶段选择

混合文件不强行登记成唯一 tier，而标记为 `selection: 'scenario'`。文件内每个场景有自己的稳定 ID、标题、tier 和 watch：

```ts
testCase({
  id: 'handoff/native-erasure-after-send-failure',
  title: '保留现有测试标题',
  tier: 'process-extended',
  watch: ['plugins/memory/lib/native/**']
}, options, fn)
```

选择顺序必须是：

1. **文件阶段**：检查文件内所有场景；只要一个场景命中当前范围，就把文件交给测试进程。
2. **场景阶段**：文件加载后，`testCase` 只注册当前范围内的场景 ID。

不能先按文件的唯一 tier 排除混合文件，否则其中的关键场景永远不会被加载。

其他规则：

- 未登记 ID、重复 ID、标题不一致立即失败。
- 混合文件不能绕过封装直接注册场景。
- 未选中的场景不注册，不产生伪 skipped。
- 本地和完整运行默认注册全部场景。
- 不使用模糊名称正则选择场景。

验收使用一个同时含 `process-critical` 与 `process-extended` 的文件，分别断言普通 PR、相关专项和完整运行实际执行的 ID；未选中的 ID 不得执行或显示为 skipped。

### 5.3 完整性要求

审计必须证明：

- 完整发现集合中的每个文件和混合文件场景都有合法归属。
- 移入专项的场景在新位置存在，没有无声消失。
- 每日与发布的源码、性能和安装后验收合集等于承诺的完整产品集合。
- 条件专项只有在判断结果为“不需要”时才允许 skipped。
- 聚合 check 拒绝判断失败，以及所有非预期 failure、cancelled、skipped 和缺失结果。
- 首轮源码或性能失败均有独立 artifact；后一轮不能覆盖前一轮报告。

## 6 实施顺序

1. **先建立安全网**：上线 `full.yml`、`daily.yml`、发布依赖和完整安装后验收，暂不改 PR 集合。
2. **接入条件门禁**：让 `scope`、可复用专项和聚合真值表生效，再启用专项承接 PR 场景。
3. **登记政策**：加入文件、场景和共享依赖审计，完整运行证明无遗漏。
4. **迁移专项**：移动真实离线安装和性能测量，核对移动前后清单及 artifact。
5. **启用 PR 快速集合**：纯 `unit` 单平台，关键 `io/process` 保持双平台，扩展场景由专项、每日和发布承接。
6. **观察与回滚**：保留 `VIVA_TEST_SCOPE=full`，可立即恢复 PR 完整集合；安全网不回滚。

废弃实现清理由独立 PR 完成，不与上述阶段混合。

## 7 验收标准

- 每日与发布在免费标准 runner 上执行 100% 承诺集合，包括安装后应用。
- 无关 PR 不被迫等待专项；相关 PR 的专项失败或判断脚本异常都会被聚合门禁拦截。
- 合并后的 main push 使用 before/after 计算范围；无法可靠计算时全部专项运行，不得误判为不需要。
- 文件移出受监控目录时同时匹配重命名前后路径；真实文档 PR 验证 scope 具有所需 Git 历史且两个专项均跳过。
- 只命中 package 的 PR 实际执行全部 `memory-package` 离线安装与导出场景。
- 每日与发布只由 package 执行离线插件安装，源码 smoke 只经 `presmoke` 构建一次；本地 `npm test` 仍运行完整集合。
- 混合文件在普通 PR、相关专项和完整运行中执行的场景 ID 均符合政策。
- 同一 main 上的手动打包与每日验收使用不同并发组，可以各自完成。
- 完整 job 在 45 分钟内完成；该预算是否足够仍由前五次双平台完整运行验证。
- 源码与性能报告使用独立目录，并在失败时也上传实际存在的诊断。
- PR 的 `check.yml` 保持 15 分钟，没有通过重跑或取消隐藏失败。
- 未登记文件、场景或共享依赖在审计中失败。
- 发布提交在 `full.yml` 中至少完成一次 typecheck；`package` 或 `full` 任一失败都无法发布。
- 若完整集合持续接近 45 分钟，先排查真实工作量和资源异常，不继续扩大超时或删除有效覆盖。

最终目标是：PR 反馈有明确边界，相关变更有可阻断合并的完整专项，每日和发布不遗漏源码、性能或安装后验收，公开仓库无需承担额外执行机费用。

# CI 完整验收与测试归属方案

[English](ci-full-acceptance.md) | 简体中文

日期：2026-11-18。状态：方案已更新，尚未实施。本文取代此前以同机文件分片、临时目录改造和付费执行机为方向的建议。

## 1 当前决定

- 仓库是公开仓库，每日和发布完整验收使用免费的标准 GitHub-hosted runner。
- macOS 使用 `macos-latest`，Windows 使用 `windows-latest`，不引入付费 larger runner 或自托管机器。
- 完整验收的每个 job 使用独立的 **45 分钟**预算；PR 的 `check.yml` 仍保持 15 分钟，不靠提高 PR 超时获得绿色结果。
- 每日完整验收使用 `schedule`，同时支持 `workflow_dispatch`；发布通过 `workflow_call` 强制执行同一集合。
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
| `package` | npm pack/install、安装包和安装后应用验收 | 相关 PR、手动、发布 |
| `perf` | 以性能数值或大型负载测量为主要目的的基准 | 每日、手动、发布 |

本地 `npm test` 和 `npm run smoke` 不设置选择环境变量时仍运行完整集合。

功能时限不是性能基准。`backend-wire-timing`、取消、恢复、请求屏障和超时放行继续按正确性归属分类，不因耗时较长而移成 `perf`。

## 4 工作流设计

### 4.1 PR `check.yml`

保留现有 job 名称、聚合状态名称和 `retries: 0`：

- `headless`：macOS 运行 typecheck、纯 `unit` 和文档检查；macOS 与 Windows 都运行 `io` 和 `process-critical`。
- `core`：保持公共 UI 冒烟。
- `integration`：保持当前 lane 和每个桌面 runner 单 worker，不与本方案同时重排。
- `timeout-minutes` 保持 15。

### 4.2 相关 PR 的记忆专项

新增 `memory.yml`，在 `src/memory/**`、`plugins/memory/**`、相关宿主适配和对应测试变化时运行完整记忆集合：

- macOS 和 Windows 都执行。
- 支持 `workflow_dispatch` 和 `workflow_call`。
- 相关 PR 必须成功，不能因 PR 使用快速集合而绕过。
- 完整专项使用自己的时长预算，不改变 `check.yml` 的 15 分钟限制。

### 4.3 打包与性能验收

扩展现有 `package.yml` 的记忆源码、插件和构建脚本路径覆盖，并在其中运行 `npm run test:memory-plugin`。普通 PR 保留轻量清单、导出和依赖闭包检查。

Playwright 已有独立 `performance` project；由完整工作流调用 `npm run smoke:perf`，不另建一套性能框架。

### 4.4 每日与发布完整验收

新增 `full.yml`：

```yaml
on:
  schedule:
    # UTC 19:17，即北京时间每天 03:17；避开整点/半点
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

`release.yml` 中 `publish` 必须同时依赖 `package` 和 `full`。任一完整验收失败、取消或缺失都阻止发布。

计划任务可能在高峰期排队，尤其 macOS；排队与执行耗时分别观察。45 分钟只限制 job 执行，不承诺消除平台排队。

## 5 测试政策与覆盖对账

### 文件级政策

将 `scripts/test-levels.ts` 调整为显式执行归属，继续复用 `scripts/test-feature.ts` 的 JS/TS 发现、功能选择和参数校验。

每个文件必须登记且只登记一次。未登记、重复登记、路径不存在或空目标集合均失败。没有默认 `unit`，新文件不能自动获得单平台资格。

现有 `fast` 包含 SQLite 和真实文件，不能整体改名为 `unit`。只有审定后的纯逻辑文件才能进行平台去重。

### 混合重型文件的场景级政策

不迁移全部测试到新框架。只对同时包含关键与扩展场景的重型文件使用窄封装：

```ts
testCase({
  id: 'handoff/native-erasure-after-send-failure',
  title: '保留现有测试标题',
  tier: 'process-extended',
  watch: ['plugins/memory/lib/native/**']
}, options, fn)
```

规则：

- ID 稳定且唯一，标题保留用于日志对照。
- 未登记 ID、重复 ID、标题不一致立即失败。
- 混合文件不能绕过封装直接注册场景。
- 未选中的场景不注册，不产生大量伪 skipped。
- 本地默认注册全部场景。
- 不通过模糊名称正则选择场景。

### 完整性要求

审计必须证明：

- 完整发现集合中的每个文件和混合文件场景都有合法归属。
- 移入专项的场景在新位置存在，没有无声消失。
- 每日和发布集合等于完整集合。
- 条件工作流未触发时有明确原因；被取消或跳过不能冒充成功。
- 聚合 check 继续拒绝 failure、cancelled、skipped 和缺失必需结果。

## 6 实施顺序

1. **先建立完整安全网**：上线 `full.yml`、发布依赖和路径触发的记忆专项，暂不改 PR 集合。
2. **登记政策**：加入文件和场景归属审计，完整运行证明无遗漏。
3. **迁移专项**：先移动真实离线安装和性能测量，核对移动前后清单。
4. **启用 PR 快速集合**：纯 `unit` 单平台，关键 `io/process` 保持双平台，扩展场景由专项、每日和发布承接。
5. **观察与回滚**：保留 `VIVA_TEST_SCOPE=full`，可立即恢复 PR 完整集合；安全网不回滚。

废弃实现清理由独立 PR 完成，不与上述阶段混合。

## 7 验收标准

- 每日与发布在免费标准 runner 上执行 100% 完整集合。
- 完整 job 在 45 分钟内完成，artifact 和日志可用于诊断。
- PR 的 `check.yml` 保持 15 分钟，且没有通过重跑或取消隐藏失败。
- 未登记文件或场景在审计中必然失败。
- 发布时 `package` 和 `full` 任一失败都无法发布。
- 初始至少观察 5 次完整运行；记录执行时长、排队和单场景超时，不用单次结果宣称稳定。
- 若完整集合持续接近 45 分钟，先排查真实工作量和资源异常，不继续扩大超时或删除有效覆盖。

最终目标是：PR 反馈有明确边界，相关变更有完整专项，每日和发布不遗漏任何场景，公开仓库无需承担额外执行机费用。

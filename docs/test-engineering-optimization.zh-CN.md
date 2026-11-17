# Viva 测试工程优化方案

[English](test-engineering-optimization.md) | 简体中文

日期：2026-11-17。本文定义测试工程与 CI 的优化顺序。PR 0 的 metrics 入口、PR 1 的统一夹具回收和 lane 拆分，以及 PR 2 的重型文件分片已在当前工作区实施；PR 3 及以后仍为后续计划。目标是缩短反馈时间，同时保留进程隔离、故障恢复、隐私和双平台行为验收。

## 1 当前证据与判断

### 1.1 测量口径

本方案分别记录以下指标，不能混用：

1. **workflow 总耗时**：从 workflow 创建到聚合 check 完成，包含所有 job 的等待与执行。
2. **job 总耗时**：从 job 开始到结束，包含 checkout、依赖安装、构建、测试、产物上传和收尾。
3. **测试步骤耗时**：某个 `npm test` 或 Playwright 步骤本身的时间。
4. **Node runner 报告耗时**：测试运行器输出的 `duration_ms`。
5. **文件墙钟与 case duration**：文件从首个场景开始到最后场景结束的时间为文件墙钟；每个场景报告的 duration 为 case duration。并发文件的 case duration 合计不等于 job 墙钟，也不直接等于文件墙钟。

评审报告 [TEO-03](qa-test-engineering-optimization-review-20261117.zh-CN.md#teo-03-统一测量口径并更新场景清单) 指出了此前将 job 耗时写成 `npm test`、将 case duration 合计写成文件耗时的问题。后续基线与收益比较必须使用同一层级，环境准备时间不能被移出口径后计为测试优化收益。

### 1.2 Workflow 与 job 基线

| 运行 | workflow 总耗时 | Windows headless job | Windows 测试步骤 | macOS memory integration job / Playwright |
| --- | ---: | ---: | ---: | ---: |
| [记忆改造前 #143](https://github.com/JNS0724/Viva/actions/runs/43679429767) | 5 分 32 秒 | 5 分 20 秒 | 3 分 46 秒 | 3 分 27 秒 / 约 2 分 36 秒 |
| [`c3224d7` 主线](https://github.com/JNS0724/Viva/actions/runs/44004336689) | 11 分 39 秒 | 11 分 28 秒 | 10 分 13 秒 | 6 分 14 秒 / 约 4 分 46 秒 |
| [最新 UI PR](https://github.com/JNS0724/Viva/actions/runs/44060528772) | 13 分 03 秒 | 12 分 57 秒 | 约 11 分 15 秒；Node runner 约 11 分 9 秒 | 5 分 18 秒 / 约 4 分钟 |

主要瓶颈是 Windows headless，而不是 core UI 冒烟。当前 `timeout-minutes: 15` 已接近被用满。

### 1.3 重型文件基线

以下数字均为 **case duration 合计**，只用于识别重型场景和后续分片参考，不作为文件或 job 墙钟：

| 基线 | 文件 | 场景数 | case duration 合计 | 主要成本 |
| --- | --- | ---: | ---: | --- |
| 最新 UI PR | `test/memory-handoff.test.ts` | 38 | 485.473 秒 | 真实 Backend/DSH、进程恢复、文件与原生副本 |
| `c3224d7` | `test/memory-file-host.test.ts` | 47 | 约 143 秒 | owner、文件 journal、来源与遗忘 |
| `c3224d7` | `test/memory-document-store.test.ts` | 29 | 约 80 秒 | SQLite、文件提交与恢复 |
| `c3224d7` | `test/memory-package.test.ts` | 4 | 约 65 秒 | 离线打包和安装 |

PR 0 必须按同一提交重新生成完整文件与场景清单，并记录提交、运行、平台和上述口径。当前 38 个 `memory-handoff` 场景是拆分前后集合一致性检查的基线，不能沿用早期 27 个场景的记录。

当前 `fast` 分类包含真实 SQLite 和临时文件操作，已经不能代表低成本测试。`memory-handoff` 单文件内部串行，是关键路径；UI 的 memory、schedules、lifecycle 三条独立场景也在同一 lane 串行。

结论：先做重型文件分片、夹具回收和 CI 归属调整，不先删除核心回归，也不先提高超时。

## 2 目标和约束

### 2.1 量化目标

完成前三个阶段后，以至少三次成功 CI 的结果评估：

- 整体 **workflow 总耗时**的 p50 不超过 7 分钟，p95 不超过 8 分钟。
- Windows **headless job 总耗时**的 p95 不超过 7 分钟，不再接近 15 分钟超时。
- macOS **memory integration job 总耗时**的 p95 不超过 3 分钟。
- 不减少已承诺的正常、失败、崩溃恢复和双平台覆盖。
- 新增 CI runner-minute 尽量控制在 20% 以内，以墙钟时间下降为主目标。

同时报告测试步骤、Node runner、文件墙钟和 case duration，用于解释优化来源，但它们不替代上述 workflow/job 目标。移动环境准备步骤、依赖安装或产物上传不计为测试执行优化收益。package 与 performance 专项单独计时，不得只因场景移出 check 就宣称整体工程耗时下降。

这些是初始门槛，应根据后续基线调整，不用单次成功运行宣称达标。

### 2.2 不可破坏的约束

- Playwright 同一桌面 runner 保持 `workers: 1` 和 `fullyParallel: false`，通过独立 job 并行，而不是共享桌面并发。
- 不用重跑掩盖失败；保留原始 trace、截图和日志。
- 不共享有状态的 DSH、应用实例或业务数据库来换取速度。
- 不删除原生涯灭、请求屏障、崩溃恢复和 Windows 文件语义测试来缩短时间。
- 不将简单提高 job 超时作为优化方案。

## 3 测试分层与覆盖策略

将当前 `fast / integration / timing` 调整为以下四类：

| 层级 | 内容 | PR 运行策略 |
| --- | --- | --- |
| `unit` | 经审定只含纯函数、reducer、schema、无外部进程的 DOM 与纯状态逻辑 | 一个平台运行一次 |
| `io` | SQLite、真实文件、journal、权限、删除、索引和 WAL | macOS 与 Windows 都运行 |
| `process` | DSH、HTTP、Worker、真实进程生命周期、恢复及功能时限契约 | macOS 与 Windows 都运行 |
| `perf` | 以性能数值和大型负载测量为主要目的的基准场景 | 专项或定期 workflow，发布前必跑 |

**每个测试文件仍必须显式归入且只归入一个层级。** 不设置默认 `unit`，也不让未登记文件自动获得单平台资格。可以通过按目录维护清单、合并重复登记结构等方式降低维护成本，但不能取消分类审计。

未登记的新文件必须使审计失败；不能仅通过类别数量检查。只有明确审定为纯逻辑的 `unit` 文件才能参与平台去重。验收时使用一个 feature 可识别但未登记成本的虚拟测试路径，必须得到分类错误；同时保留 JS/TS 发现完整性和重复分类检查。

`perf` 只描述测量目的，不按等待时长归类。`backend-wire-timing.test.ts` 中“空闲连接后 RPC 仍成功”和“前序序号缺失后按期限放行”是功能正确性契约，必须留在双平台 `process` 的 PR 集合。取消、恢复、请求屏障、超时放行等其他功能时限测试也不得仅因等待较长而移出 PR。旧 `timing` 分类不能整体迁移为 `perf`。

## 4 重型文件分片

### 4.1 `memory-handoff`

按职责拆成约四个文件：

1. 来源摄取与路由。
2. 原生工具、输出和副本擦除。
3. 遗忘、崩溃恢复与上下文重建。
4. 后台任务与定时任务。

公共 setup 提取为共享 fixture；各测试继续使用独立临时状态。保留原测试名称和断言，不用名称模式在 CI 中选择测试，避免新增场景漏跑。

### 4.2 `memory-file-host` 与 `memory-document-store`

- `memory-file-host` 拆成读取/写入与遗忘/恢复两组。
- `memory-document-store` 拆成提交恢复与修订管理两组。
- 以 CI 实测关键路径平衡文件，不按行数或测试数量机械平均。

拆文件的目的，是让 Node 的文件级并发能够覆盖原关键路径，不是减少测试。

## 5 夹具生命周期优化

`startHarness` 与其他临时目录 fixture 统一使用 `scratch`。每个文件的用例共享一个外层容器，但保留独立子目录，并在各用例的资源关闭后立即回收自己的目录；文件结束时只删除已经清空的外层容器：

```text
文件级临时容器
  ├─ test-a 独立子目录：资源关闭后立即回收
  ├─ test-b 独立子目录：资源关闭后立即回收
  └─ test-c 独立子目录：资源关闭后立即回收

每个用例仍关闭自己的 DSH、Worker、SQLite 和 fake LLM
文件结束后删除空容器
```

要求：

- 每个用例继续使用独立子目录和业务状态。
- 先关闭进程和数据库，再回收该用例目录；清理顺序保持后进先出，Windows 删除等待上限仍为 15 秒。
- 任一用例清理失败时保留诊断目录，不因为复用外层容器而掩盖失败。
- 不把仍可能被子进程占用的用例目录推迟到文件末尾递归删除；首轮 Windows CI 已验证这种做法会触发清理失败和进程超时。

后续才评估共享只读构建产物、profile 模板和 fake provider 配置，不共享可变会话。

## 6 CI 编排调整

### 6.1 保留的现有边界

- `core` 继续运行公共 UI 冒烟，当前不是主要瓶颈。
- `package.yml` 继续负责安装包和安装后应用验收。
- `check` 聚合所有必需结果，现有状态检查名称不变。
- 每个桌面 runner 仍然只运行一个桌面 worker。

### 6.2 UI integration lane

将当前两条 lane：

- `interaction`
- `memory`（memory + schedules + lifecycle）

调整为三条：

- `interaction`
- `memory`
- `schedules-lifecycle`

三个场景已经使用独立 Scenario 和应用实例，可以安全拆 job。先增加这一条 lane，不继续细分，控制环境准备成本。

### 6.3 Headless 分层后的目标形态

完成测试分类和重型文件分片后，目标为：

| Job | 平台 | 内容 |
| --- | --- | --- |
| `headless-unit` | macOS | typecheck、全部经审定的 `unit`、check:i18n |
| `headless-integration` | macOS + Windows | 全部 `io` 与 `process`，按实测分片；包含功能时限契约 |
| `core` | macOS + Windows | 现有公共 UI 冒烟 |
| `integration` | macOS + Windows | interaction、memory、schedules-lifecycle |
| `package` | 路径过滤、手动、发布 | 离线安装、安装包和安装后验收 |
| `performance` | 专项、定期、发布 | 以测量为目标的大型种子和性能基准 |

重型文件拆分后先保留全部 `io/process` 双平台执行，再根据 CI 数据决定是否需要第二个 process 分片。不要一开始增加过多 job。

## 7 专项验收归属

### 离线插件安装

`memory-package` 的完整 npm pack/install 移到打包或记忆插件专项 workflow。PR 普通检查保留：

- 安装清单与导出契约。
- 依赖闭包和禁止宿主导入。
- 离线错误码与超时时限。
- 轻量 Node API smoke。

当构建脚本、插件清单、运行时依赖或记忆公共代码改变时，专项仍必须通过。

### 性能与大型种子

只将以性能数值或大型负载测量为主要目的的场景移到 `smoke:perf` 或定期性能 workflow。每个移动场景必须记录其基准性质，以及普通 PR 在哪个层级保留正确性断言。

功能时限不属于本迁移范围。普通 PR 的双平台 `process` 清单必须继续包含 `backend-wire-timing.test.ts` 的两个功能契约，以及取消、恢复、屏障和超时放行测试。普通 PR 可保留大型种子的轻量身份、迁移和正确性断言，但不重复构造性能数据。

### 重复 happy path

建立一张覆盖矩阵，明确每项能力的 canonical 层级：

- Core 行为：单元测试。
- Host/owner 契约：真实进程集成。
- 用户主路径：UI 冒烟。
- 安装产物：package。

相同 happy path 不应在三层重复；但平台差异、崩溃恢复、功能时限和安全边界不能只因“看起来重复”就删除。

## 8 分阶段实施

### PR 0：基线与观测（已实施）

- 按同一提交保存完整文件与场景清单，记录提交、运行、平台和分类。
- 分别输出 workflow、job、测试步骤、Node runner、文件墙钟与 case duration，附 Top 20 慢文件及统计口径。
- 建立当前 38 个 `memory-handoff` 场景的名称集合，拆分前后必须完全一致。
- 在 CI summary 汇总 job 耗时和 runner-minute；package 与 performance 单独列示。

### PR 1：低风险夹具与 lane 优化（已实施）

- 统一临时目录夹具，按用例回收目录、按文件回收空容器。
- 拆分 schedules-lifecycle UI lane。
- 保持全部测试和断言不变。

### PR 2：重型文件分片（已实施）

- 拆分 `memory-handoff`、`memory-file-host`、`memory-document-store`。
- 共享 fixture，保持测试名称、覆盖和双平台执行。
- 删除无生产消费者的 `createMemoryService/createMemoryClient` 通用协议及其测试，现行协议保持 `HostMemoryApi + remote-memory-channel`。
- 对比实际文件关键路径，确认不是仅增加环境启动次数；分片前后场景集合一致。

### PR 3：验收归属与分类

- 引入 `unit / io / process / perf`，所有文件显式且唯一分类，不设默认层级。
- 增加未登记路径审计用例：必须失败，不能自动成为仅 macOS 的 `unit`；保留重复分类和 JS/TS 发现检查。
- 将 `backend-wire-timing.test.ts` 明确登记为双平台 `process`，逐项审定其他功能时限测试。
- 只移动真正的离线安装和性能基准场景，检查完整测试发现集合，确保只是调整执行位置，没有漏跑。

### PR 4：按数据决定是否继续去重

只有目标仍未达成时才执行：

- 仅将明确审定为纯逻辑的 `unit` 改为一个平台运行。
- 对 `process` 再做一个成本均衡的分片。
- 删除经覆盖矩阵确认的三层重复 happy path。

## 9 验证与交付门槛

每个阶段必须：

1. 运行相关测试和 `npm run typecheck`；测试发现配置改变后，核对完整测试集合。
2. 修改冒烟工程或进程生命周期时，运行 `npm run build` 和对应 smoke 阶段。
3. 保持测试数量与覆盖清单可解释；移动场景列明原位置和新位置。
4. 检查 macOS 与 Windows CI 的当前提交结果，不用本地结果替代 CI。
5. 比较至少三次运行的 workflow/job p50/p95、测试步骤、最慢文件和 runner-minute；按相同口径比较，不能用 job 总耗时替代测试耗时，也不能用 case duration 合计替代墙钟。
6. 拆分后核对场景集合，尤其当前 38 个 `memory-handoff` 场景不得丢失或重复。
7. 失败先看 trace、截图和日志；只有确认偶发才重跑，并记录原因。

最终交付不是测试文件变少，而是：关键路径更短、分类更准确、隔离不变、失败可诊断、完整覆盖可证明。

## 10 风险与停止条件

| 风险 | 处理 |
| --- | --- |
| 分片增加启动开销，墙钟反而变长 | 回退过细分片，按实测重新平衡 |
| 共享 fixture 引入跨用例状态 | 每用例独立子目录和资源；失败时停止复用可变状态 |
| 未登记文件被误判为单平台 `unit` | 分类审计必须失败；只有显式审定的纯逻辑文件才能去重 |
| 功能时限被误移出 PR | 按验证目的分类，`backend-wire-timing` 及取消、恢复、屏障测试保持双平台 `process` |
| 专项移动造成验收漏跑 | PR 路径过滤和发布聚合中显式包含专项，保留发现清单 |
| 为追求时长删去安全覆盖 | 停止该优化项，不将时长置于隐私和恢复正确性之上 |

如果前两阶段不能改善关键路径，先分析新增 setup 和回收成本，不进入大规模测试删除阶段。

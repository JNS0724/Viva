# Viva 测试工程优化方案

[English](test-engineering-optimization.md) | 简体中文

初稿：2026-11-17。重新审计：2026-11-18。本文取代此前按“同机文件分片、文件级临时目录回收”推进的阶段方案。目标是缩短 CI 关键路径，同时保留进程隔离、故障恢复、隐私和双平台行为验收。

## 1 重新审计的结论

### 1.1 同口径证据

| 运行 | Windows headless job | Windows Node runner | 结果 |
| --- | ---: | ---: | --- |
| [`c3224d7` 主线](https://github.com/JNS0724/Viva/actions/runs/44004336689) | 688 秒 | 约 613 秒 | 成功，但接近 15 分钟上限 |
| [`a134bac` 同机分片](https://github.com/JNS0724/Viva/actions/runs/44117048557) | 724 秒 | 622.4 秒 | 测试执行结束；metrics 路径断言失败 |

同机分片没有缩短 Windows 关键路径，反而增加约 36 秒 job 耗时。单次运行不能用于计算 p95，但已经足以否定“继续在同一 runner 上细拆重型文件”这一主要方向。

独立 UI job 的结果不同：[run 44112795498](https://github.com/JNS0724/Viva/actions/runs/44112795498) 中，macOS memory integration 从主线 374 秒降为 169 秒。有效的是把已有独立场景交给独立 runner，不是增加同一进程内的文件数量。

两轮临时目录改造还暴露了资源生命周期顺序问题：`scratch` 的目录删除 hook 先于 `startHarness` 的 DSH 关闭 hook 执行。虽然后续已修正顺序，但没有证据表明目录改造本身带来收益，因此不再保留这项风险和复杂度。

### 1.2 对前阶段的处理

| 前阶段改动 | 决定 | 理由 |
| --- | --- | --- |
| metrics、JSON artifact、慢文件摘要 | 保留并修正 | 能定位真实成本；需统一 Windows 路径并排除文件级 runner 事件 |
| interaction、memory、schedules-lifecycle 独立 UI job | 保留 | 已有独立应用实例，实测缩短 memory 关键路径 |
| `memory-handoff`、`memory-file-host`、`memory-document-store` 同机分片 | 撤回 | 没有墙钟收益，增加初始化与维护成本 |
| 文件级临时目录容器和统一 `scratch` 改造 | 撤回 | 无实测收益，曾破坏资源关闭顺序 |
| 删除无生产消费者的通用 memory client/service 协议 | 作为独立架构清理保留 | 减少无用代码，但不计为测试提速收益 |
| 文档清理和评审报告 | 保留 | 与 CI 性能收益分开记录 |

## 2 测量口径与目标

分别记录以下指标，不能混用：

1. **workflow 总耗时**：从创建到聚合 check 完成，包含排队。
2. **job 总耗时**：包含 checkout、npm 安装、构建、测试、artifact 和收尾。
3. **测试步骤耗时**：某个 Node 或 Playwright 命令本身的时间。
4. **Node runner 报告耗时**：runner 输出的 `duration_ms`。
5. **文件墙钟与 case duration**：文件完成事件包含该文件的 setup/hook；case duration 是单场景报告耗时。并发场景的 case duration 合计不等于墙钟。

metrics 文件路径统一使用 `/`，保证跨平台可比较。文件级 pass/fail 事件只用于完成文件记录，不能计入场景总数。artifact 名称保留平台、run id 和 attempt；比较时必须注明提交和运行链接。

以至少三次成功 CI 评估后续收益：

- workflow 总耗时 p50 不超过 7 分钟，p95 不超过 8 分钟。
- Windows headless 或其后续等价 job 集合的 p95 不超过 7 分钟。
- macOS memory integration p95 不超过 3 分钟。
- 新增 runner-minute 尽量控制在 20% 以内。
- 不减少正常、失败、崩溃恢复、隐私和双平台覆盖。

移动环境准备、依赖安装或 artifact 上传不计为测试执行收益。移入专项 workflow 的场景必须单独计时，不能只从 PR check 消失就宣称整体工程耗时下降。

## 3 当前成本应如何使用

分片运行的 metrics 仍可用于识别成本，但不再作为文件边界建议：

- `memory-handoff-tasks`：文件墙钟约 190 秒，包含后台与定时任务的真实等待和恢复。
- `memory-package`：约 102 秒，主要是离线打包和安装。
- `memory-plugin`：约 72 秒，需要逐项区分安装验收与轻量协议检查。
- file-host erasure、handoff recovery/native 等场景各约 76–86 秒，涉及真实文件、进程和原生副本。

撤回分片后，应通过场景名称和 case duration 分析这些成本，不重新按上述名称建文件。功能等待时间不是可以直接删除的“冗余”，离线安装和大型性能测量也应先确认专项归属再移动。

## 4 修订后的优化路线

### 阶段 A：恢复可信基线（当前 PR）

- 恢复原来的三个重型测试文件及其全部场景，不保留同机分片和共享可变 fixture。
- 恢复原有按用例关闭资源、删除临时目录的生命周期。
- 保留 metrics，修正 Windows 路径和场景计数。
- 保留三条独立 UI integration lane。
- 取得 macOS 与 Windows 的完整绿色结果，记录新的同口径基线。

这一阶段的目标是让 PR 可审查、可合并，不承诺 Windows 已提速。

### 阶段 B：显式分类与纯逻辑平台去重

将现有 `fast / integration / timing` 调整为：

| 层级 | 内容 | PR 策略 |
| --- | --- | --- |
| `unit` | 纯函数、reducer、schema、无外部进程的纯状态/DOM 逻辑 | 一个平台运行一次 |
| `io` | SQLite、真实文件、journal、权限、删除、索引、WAL | macOS 与 Windows |
| `process` | DSH、HTTP、Worker、真实进程生命周期、恢复及功能时限 | macOS 与 Windows |
| `perf` | 以性能数值或大型负载测量为主要目的的基准 | 专项、定期、发布前 |

约束：

- 每个测试文件必须显式且唯一分类，不设默认 `unit`；未登记文件必须使审计失败。
- 现有 `fast` 包含 SQLite 和真实文件，不能整体改名为 `unit`。
- `backend-wire-timing`、取消、恢复、请求屏障和超时放行属于双平台 `process`，不能按耗时移成 `perf`。
- 只有审定后的纯 `unit` 才能平台去重；先证明集合完整，再改变 CI。

### 阶段 C：专项验收归属

- 将 `memory-package` 的完整 npm pack/install 移到打包或记忆插件专项 workflow。
- 逐项审定 `memory-plugin`，只移动真实离线安装或产物验收，保留轻量协议和错误契约。
- 只将以测量为目的的大型种子和性能基准移到 `smoke:perf` 或定期 workflow。
- 每个移动场景记录原位置、新位置及 PR 中保留的正确性断言；构建、清单或公共代码变化时专项仍是必需门槛。

### 阶段 D：仍不达标时拆独立 job

如果阶段 B、C 后 Windows 仍超过目标，优先把完整 `io/process` 集合分到**独立 CI job**，而不是继续拆文件：

- 先只增加一个成本均衡的 process shard，比较墙钟收益与额外 npm/setup 成本。
- 分片清单必须显式、稳定，并验证各 shard 与 unit/perf 专项的并集等于完整发现集合，交集符合设计。
- 不用临时名称正则选择测试，避免新增场景漏跑。
- 每个桌面 runner 仍只运行一个桌面 worker，不共享可变 DSH、应用实例或业务数据库。

### 阶段 E：最后才删除重复覆盖

建立覆盖矩阵，明确单元、host/owner、UI 和安装产物的 canonical 层级。只有同一 happy path 在多层重复、且平台差异和失败边界另有覆盖时才删除。

原生涯灭、请求屏障、崩溃恢复、功能时限、隐私和 Windows 文件语义不能因“看起来重复”而删除。

## 5 验证与停止条件

每个阶段必须：

1. 运行相关测试和 `npm run typecheck`；发现或分类配置变化后核对完整集合。
2. 修改冒烟工程或进程生命周期时，运行 `npm run build` 和对应 smoke。
3. 保留移动前后场景清单，确保测试只是移动而不是消失。
4. 检查当前提交的 macOS 与 Windows CI，不用本地结果替代线上结果。
5. 比较至少三次运行的 workflow/job p50/p95、测试步骤、慢场景和 runner-minute。
6. 失败先看日志、trace 和截图；只有确认偶发才重跑，并在 PR 说明。

出现以下情况立即停止对应优化：

- 分片或新 job 的墙钟收益被 setup、安装和进程启动成本抵消。
- 共享 fixture 引入跨用例状态或资源关闭顺序变化。
- 分类审计允许未登记文件自动成为单平台测试。
- 专项移动或覆盖删除无法证明完整验收仍会执行。

最终交付不是测试文件更多或更少，而是关键路径更短、分类准确、隔离不变、失败可诊断、覆盖可证明。

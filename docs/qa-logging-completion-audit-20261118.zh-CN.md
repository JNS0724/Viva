# 日志方案完成性核对（2026-11-18）

工作区 `/private/tmp/viva-local-diagnostics`，分支 `codex/local-diagnostics`。此记录按方案核对实际实现，不把既有测试通过等同全部阶段完成。原工作区和 ReMe 不变。

## 本批补齐的遗漏

- 活动表满时新增 `untrackedCount`，保留已跟踪 span。旧 `0401ca0` logger 的隔离复现为 2048 → 2047：未跟踪子操作的终态删除了父项。现在未知显式操作建立独立诊断上下文，终态只结算匹配的操作，新增回归通过。证据为 `/private/tmp/viva-l3-old-untracked-parent-repro.json`。
- Node writer 就绪后异步检查同组件最近一个已确认全部关闭的旧 writer。未确认退出、PID 复用或仍活跃的 writer 不作为历史扫描对象。最多读 32 MiB、保留 2048 项、控制快照最多 16 项，扫描期限 2 秒；JSONL 每 64 行让出事件循环，坏行也遵守该规则。
- 历史缺少终态只标记诊断 `incomplete`，不推断业务未提交。检查只读取诊断目录，不参与记忆恢复、请求准入或回执。强杀真实测试进程的回归确认已提交业务文件保持不变。
- 扫描超时后继续保留实际 I/O 结算，清空和退出不能提前回收未关闭句柄。复现过迟到 close 将 partial 改成 complete 的问题，已补 `throwIfAborted` 与回归；安全错误码、截断、遗漏与未知范围明确报告。证据为 `/private/tmp/viva-l3-late-history-close-repro.json`。
- 导出和启动检查共用有界 JSONL 分帧。旧 span 只保留固定操作/阶段和既有不透明别名；导出时与原记录各自重新别名一次，引用一致。六组件最大控制回复实测 46603 字节，仍低于 64 KiB。

## 发布产物的直接证据

`0401ca0` 为现有安装包用例增加真实诊断检查，没有修改运行器、分路或另一个 agent 的工程。macOS 干净 DMG 已只读挂载，仓库外完成记忆/重启、debug 元数据落盘、子进程 ZIP 导出、正文/路径/身份哨兵排除、清空、保留旧 ZIP 和业务 PID/后续读取，1/1 通过（2.3 分钟）。ZIP 为 12802699 字节、19276 行诊断，构建提交均为 `0401ca0855f7f8695b87466fcff5d2e7b6281c5a`。日志为 `/private/tmp/viva-l3-final-installed-diagnostics-smoke.log`，产物在 `smoke/l3-final-installed-diagnostics/`，自有挂载已卸载。

旧 `b165003` 安装包 CI 的 Windows job 已通过安装、记忆/重启、许可证和卸载；macOS job 没有执行步骤，GitHub 注释为 hosted runner 未分配及 arm64 容量不足，实际结论是 cancelled，不能记为应用失败或通过。新增安装包诊断检查及本批运行时修复仍需对应当前源码的后续平台验证。

## 当前验证与未完成项

- 本批第一轮全量 2215 项，2213 通过、2 跳过；发现并补充迟到 close 与历史上下文冲突后，最终全量 2217 项，2215 通过、2 跳过、0 失败（169.2 秒）。类型检查和构建通过，当前产物完整桌面冒烟 15/15（4.6 分钟）；独立插件构建包含 149 个模块，离线封装及普通 Node 测试 4/4 通过。心跳冒烟现只接受 operation=process 的超时，避免把启动检查的诊断超时误当作进程失联证据。

当前产物的真实 owner 暂停验证通过：10005.9ms、10004.2ms 超时，3.1ms 返回满额 busy，恢复后新读取/手动重试、草稿及附件均正常。Backend 沉默检测及清空恢复通过：2003.2ms 返回 cleanup_pending，实际恢复后盐轮换，业务进程 PID 不变，memory:get 正常。日志分别为 `/private/tmp/viva-l3-recovery-owner-smoke.log`、`/private/tmp/viva-l3-recovery-controls-smoke.log`；冻结 Backend/Renderer 的原生导出另见 `/private/tmp/viva-l3-recovery-export-smoke.log`。
- 原有日志性能门槛没有改动。当前双平台 CI 仍因 5% 门槛失败；固定对象布局的仓库外探针也未改善完整负载，未并入生产。
- 第 4 节的后台/定时任务独立根 trace 与触发 links 尚需补齐。现有持久化 operationId/task 身份关联已实现，但 `DiagnosticContext` 还没有 links，`withOperation` 仍沿用父 trace，不能以现有身份关联替代该项。
- 第 11 节的身份内容保护还需核对缓存边界：当前 HMAC 在编码落盘前完成，活动表与待写队列仍保存已校验的身份输入。对于可能含正文的 effect key、模型名称和路径身份，需要在进入这些缓存前别名化；原始业务身份和协议保持既有职责。

以上继续归入已有 L1/L2/L3，不新增开发阶段。性能、后台关联和缓存边界尚未全部验收，因此整个日志方案保持未完成。

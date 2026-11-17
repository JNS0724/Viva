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

旧 `b165003` 安装包 CI 的 Windows job 已通过安装、记忆/重启、许可证和卸载；macOS job 没有执行步骤，GitHub 注释为 hosted runner 未分配及 arm64 容量不足，实际结论是 cancelled，不能记为应用失败或通过。后续 [44180472449](https://github.com/JNS0724/Viva/actions/runs/44180472449) 的 head 为 `64b82f5739802a323b6887b5c420e4b351d652be`，mac/windows 两项均已实际 success，包含新增的安装后诊断检查。之后的 L1b 与缓存入口修改仍需对应源码的最终发布验证，不能沿用旧安装包证明。

## 缓存入口跟进

L1b 的额外流缺口、重复推送及重试水位修复已本地提交 `7c52db2`，全量 2221 项、2219 通过、2 跳过，完整冒烟 15/15。详见 [L1b 记录](qa-logging-l1b-implementation-20261118.zh-CN.md)。没有修改另一工作区或 ReMe。

随后为 Node 缓存入口增加类型区分：只有已验证事件才能捕获，只有已捕获事件能进入待写/活动表及 formatter。身份 HMAC 在 emit 返回前完成，formatter 不再二次 HMAC；文本不会成为显式操作 map 的键。私有 HMAC 相关键只负责诊断匹配，不进入业务协议，也不是持久化身份。启动盐未知时记录明确的 partial/not_ready 并计元数据丢失，保持 start/end 匹配，不以诊断 I/O 阻塞业务。

context 的字段单次读取、校验后冻结。Node 的弱键映射只保存原对象到安全副本的映射，活动表、formatter 和 ALS 保留安全副本，不持有外部对象图。清空/退出丢弃别名缓存和 formatter 绑定。另复现并修复了清空后新 writer 未就绪时旧 run 进入活动表的窗口；managed 端使用已确认的新 run 拒绝，通用 writer 在身份就绪时清理不匹配的活动项，并在编码前复核。

修复前回归分别记录于 `/private/tmp/viva-log-ingress-repro.log`（同步别名化与 getter）和 `/private/tmp/viva-log-generation-readiness-repro.log`（两个真实就绪窗口）。首轮诊断专项 68/68、类型检查和构建通过；首轮全量 2227 项：2225 通过、2 跳过、0 失败（171.0 秒），日志为 `/private/tmp/viva-log-ingress-final-{diagnostics,typecheck,build,full-tests}.log`。

最后自检发现：仅凭 UUID/十六进制格式不能证明模型或资源名不含内容，因此去掉事件身份的原文 alias-cache key。该回归在收紧前为 `1 !== 2`（第二次未重新 HMAC），见 `/private/tmp/viva-log-opaque-identity-cache-repro.log`。收紧后诊断专项 69/69，类型检查、构建均通过，日志前缀为 `/private/tmp/viva-log-ingress-hardened-`。第二轮全量仅文档检查失败：更新双语方案后漏同步审阅 hash，实际为 2228 项、2225 通过、2 跳过、1 失败；证据保留在 `viva-log-ingress-hardened-full-tests.log`。补齐 hash 后文档专项 2/2，最终完整复验为 2228 项、2226 通过、2 跳过、0 失败（169.4 秒），见 `/private/tmp/viva-log-ingress-verified-full-tests.log`。其中已包含重新编译、离线 npm 安装及仓库外普通 Node API 验收。

性能固定负载仍使用 500 次/模式、100 轮交错、20ms 请求间隔、真实 HTTP/owner/五读。首轮 P95 2.270000 → 3.083625ms，增加 0.813625ms / 35.8425%，见 `/private/tmp/viva-log-ingress-performance.json`。收紧原文缓存后的当前源码为 2.484083 → 3.014541ms，增加 0.530458ms / 21.3543%，见 `/private/tmp/viva-log-ingress-hardened-performance.json`。两次均零丢弃、结束时零排队/活动项，均按原门槛返回失败；不是对同一源码重跑以掩盖失败，也不据基线波动推断优化效果。该基准只覆盖空 owner 读取，不能代表全部主线。

最终构建的 macOS 故障专项通过：owner 暂停后两次读取为 10002.7ms、10004.9ms，满额 2.7ms busy；实际恢复后新读取、页面手动重试、草稿和附件均保留。Backend 沉默被独立心跳识别，清空先在 2003.8ms 返回 cleanup_pending，恢复后轮换盐，业务 PID 不变且 memory:get 正常。Backend 与 Renderer 都暂停时，原生菜单仍导出 59691 字节 ZIP。日志为 `/private/tmp/viva-log-ingress-verified-{owner,controls,export}-smoke.log`，没有把这些就绪后故障用例冒充启动 I/O 挂起用例。后者的新缺口仍明确保留在下方清单。

## 当前验证与未完成项

- 本批第一轮全量 2215 项，2213 通过、2 跳过；发现并补充迟到 close 与历史上下文冲突后，最终全量 2217 项，2215 通过、2 跳过、0 失败（169.2 秒）。类型检查和构建通过，当前产物完整桌面冒烟 15/15（4.6 分钟）；独立插件构建包含 149 个模块，离线封装及普通 Node 测试 4/4 通过。心跳冒烟现只接受 operation=process 的超时，避免把启动检查的诊断超时误当作进程失联证据。

当前产物的真实 owner 暂停验证通过：10005.9ms、10004.2ms 超时，3.1ms 返回满额 busy，恢复后新读取/手动重试、草稿及附件均正常。Backend 沉默检测及清空恢复通过：2003.2ms 返回 cleanup_pending，实际恢复后盐轮换，业务进程 PID 不变，memory:get 正常。日志分别为 `/private/tmp/viva-l3-recovery-owner-smoke.log`、`/private/tmp/viva-l3-recovery-controls-smoke.log`；冻结 Backend/Renderer 的原生导出另见 `/private/tmp/viva-l3-recovery-export-smoke.log`。
- 原有日志性能门槛没有改动。当前双平台 CI 仍因 5% 门槛失败；固定对象布局的仓库外探针也未改善完整负载，未并入生产。
- 第 4 节的后台/定时任务独立根 trace 与触发 links 尚需补齐。现有持久化 operationId/task 身份关联已实现，但 `DiagnosticContext` 还没有 links，`withOperation` 仍沿用父 trace，不能以现有身份关联替代该项。
- 第 11 节的 Node 活动/待写/显式操作缓存入口已经别名化；长生命周期 `withOperation` 和可移植 observation 闭包仍会持有初始 fields，需要继续通过有界字段绑定消除可能的身份原文引用。原始业务身份和协议保持既有职责，不能以丢弃全部关联替代该项。
- 独立探针新确认一条实际生命周期缺口：暂停 identity.json 读取后，close 返回 false，但 released 已为 true；放行迟到读取后，state=closed 的 writer 又恢复 identity。证据 `/private/tmp/viva-log-initialization-close-proof.json`，探针为 `/private/tmp/viva-log-initialization-close-probe.ts`。下一批需要将初始化及重试身份 I/O 计入真实结算，超时不能释放、关闭后不能重新绑定；继续归入既有 L1c，不新增阶段。

以上继续归入已有 L1/L2/L3，不新增开发阶段。性能、后台关联和缓存边界尚未全部验收，因此整个日志方案保持未完成。

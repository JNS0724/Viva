# 日志方案完成性核对（2026-11-18）

工作区 `/private/tmp/viva-local-diagnostics`，分支 `codex/local-diagnostics`。此记录按方案核对实际实现，不把既有测试通过等同全部阶段完成。原工作区和 ReMe 不变。

## 剩余开发顺序与退出条件

1. **L1b 结项**。当前业务实现已通过真实 owner、DSH 重试和持久化恢复回归，全量 2242 项中 2240 通过、2 跳过。当前桌面构建跑完 15 项及 owner 暂停/恢复专项后结项。以后只有读取预算、真实执行结算、启动同步或 dream 隔离发生变化或出现新复现，才重开对应检查。
2. **L1c 故障与性能**。覆盖在清空前或清空期间结束的操作、导出固定文件范围时配额锁由暂停进程持有。用同机固定负载测默认开销，根据热点修复，保留原 5% 和 10ms 双指标，并按用户接受的小绝对增量评估实际交互，同时检查零丢弃、零积压和业务结果。
3. **L2 后台关联**。后台任务、定时执行分别建立根 trace，连接实际触发方；逻辑操作在各次尝试中使用稳定身份，重启按持久化身份关联，清空换代移除旧链接。验证实际写盘和导出后的引用一致。
4. **L3 发布验收**。最终源码跑类型、全量测试和完整冒烟，汇总前台、任务、定时与检索的负载数据，验证同一提交的 macOS 与 Windows 安装包及故障诊断。发布以该提交的实际结果为准。

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

## 字段绑定与身份 I/O 生命周期跟进

本批继续在独立工作区推进，没有修改另一 agent 的测试工程或 ReMe。初始启动及失败重试的身份读取都纳入实际未结算 I/O：prepare 超时返回 false，released 保持 false，resume 不接受换代；实际读取结束后，同一个清空身份可恢复，迟到数据不能再绑定关闭的 writer，也不能创建新日志目的端。修复前两条回归均为 `true !== false`，见 `/private/tmp/viva-log-identity-lifetime-repro.log`；修复后 sink 专项 7/7 通过。没有通过强制取消 Promise 或释放业务屏障换取成功。

可移植端口增加可选 bind 能力，Node 负责字段校验、别名化和有界绑定表，Core 只持有绑定后的端口。Node withOperation、Core observation 和梦境计算均不再把初始 fields 留在长生命周期闭包中。最多 2048 项，包含未开始的绑定；终态和清空都集中移除身份数据，旧 handle 不可复活。emit-only 端口仍可记录直接事件，但不能隐式缓存环绕字段；缺失/失败绑定降级为空观察，保留原业务 Promise。测试录制端口显式实现绑定能力，没有在生产端加入不安全的原文字段 fallback。

GC 夹具在已结束的同步栈中创建输入，再保持观察挂起并主动收集。e23c2e4 的 Node、可移植、async 三条路径都保留调用方的额外对象图，分别见 `/private/tmp/viva-log-binding-gc-old-{node,portable,async}.log`；当前三条路径均允许收集，并能正常完成业务和生命周期。最初夹具把对象创建放在 async 函数中，会被该函数保存的临时寄存器干扰；现已消除该夹具自身保留源，仍对旧版复现失败。

清空后的续接不会保留原文以便重算，也不会二次 HMAC 旧别名；只用固定标量状态及新 trace，明确标记 partial/continued_after_clear。新提交的身份仍按当前盐正常别名化。另修复字段 getter 失败时的终态回收、失败辅助函数隔离，以及未拥有父 span 的终态误写成父终态的历史问题；相应旧行为证据为 `/private/tmp/viva-log-failure-field-getter-old-proof.json` 和 `/private/tmp/viva-log-bound-parent-terminal-repro.log`。

HTTP 原先只编码 trace/span，漏掉 diagnosticRunId，导致有效接收端丢弃关联；现在保留 run，仍省略发送 span 的 parent。修复前证据为 `/private/tmp/viva-log-http-run-binding-repro.log`。新回归覆盖实际 loopback HTTP 的根 trace、即时父 span 及无 epoch_changed 丢弃，并验证新增字段的实际字节上限和业务原编码回退。绑定、清空、GC、dream 可用性和检索定向 161 项通过，类型检查通过。首轮全量为 2240 项、2232 通过、2 跳过、6 失败（167.4 秒），证据为 `/private/tmp/viva-log-binding-full-tests.log`；失败均为旧测试录制端口缺少新增 bind 能力，丢失生命周期元数据或产生额外缺失能力报告。已将这些测试端口接入显式录制适配器，保留原业务断言，并分别完成定向验证；没有给生产端恢复原文字段缓存 fallback。

随后补充启动时未绑定 run 的上下文回归：同一上下文的不同视图在换代后必须共享一个新根；启动前创建且从未读过当前上下文的静默 scope 也不能在清空后复用旧 trace。修复前两项均失败，见 `/private/tmp/viva-log-silent-startup-context-repro.log`；现用弱键共享换代记录，并在 writer 身份就绪时登记原 scope 的所属代次。最新诊断、会话计时及定时恢复专项 103/103，类型检查通过，见 `/private/tmp/viva-log-binding-final-regressions.log` 与 `/private/tmp/viva-log-binding-verified-typecheck.log`。本批全量 2242 项、2240 通过、2 跳过、0 失败（180.4 秒），见 /private/tmp/viva-log-binding-verified-full-tests.log。L1b 结项构建的桌面冒烟 15/15。真实 owner 两次超时分别为 10003.9ms、10006.2ms，满额后 3.1ms 返回 busy。恢复后重新加载成功，草稿和附件保留。日志为 /private/tmp/viva-l1b-exit-desktop.log 和 /private/tmp/viva-l1b-exit-owner.log。

## 当前验证与未完成项

- 本批第一轮全量 2215 项，2213 通过、2 跳过；发现并补充迟到 close 与历史上下文冲突后，最终全量 2217 项，2215 通过、2 跳过、0 失败（169.2 秒）。类型检查和构建通过，当前产物完整桌面冒烟 15/15（4.6 分钟）；独立插件构建包含 149 个模块，离线封装及普通 Node 测试 4/4 通过。心跳冒烟现只接受 operation=process 的超时，避免把启动检查的诊断超时误当作进程失联证据。

当前产物的真实 owner 暂停验证通过：10005.9ms、10004.2ms 超时，3.1ms 返回满额 busy，恢复后新读取/手动重试、草稿及附件均正常。Backend 沉默检测及清空恢复通过：2003.2ms 返回 cleanup_pending，实际恢复后盐轮换，业务进程 PID 不变，memory:get 正常。日志分别为 `/private/tmp/viva-l3-recovery-owner-smoke.log`、`/private/tmp/viva-l3-recovery-controls-smoke.log`；冻结 Backend/Renderer 的原生导出另见 `/private/tmp/viva-l3-recovery-export-smoke.log`。
- 原有日志性能门槛没有改动。当前双平台 CI 仍因 5% 门槛失败；固定对象布局的仓库外探针也未改善完整负载，未并入生产。
- 第 4 节的后台任务派发、继续/恢复和定时执行使用独立根 trace，根记录保留触发链接，子 span 继承新 trace。定时操作的逻辑 ID 跨 retry 不变，attempt 单独计数。实际 JSONL/ZIP 关联及定时重启回归已通过。
- L1c 已复现清空后迟到进度错误恢复两个已结束操作，修复后活动数为零。真实配额事务持锁进程被冻结时，导出会在有界等待后返回 busy，未生成 ZIP；恢复后再次导出成功。此低概率边界按产品决定降级为占用提示和重试，设置页和原生菜单都保留直接打开日志目录。
- 第 11 节的缓存入口与环绕字段绑定已经实现，定向 GC 及清空回归通过；当前源码仍需本批完整集成与发布复核，原始业务身份、协议和回执没有改变。
- 先前身份读取未结算时误报 released、迟到恢复 identity 的探针缺口已在启动和重试两路修复，原始失败证据仍保留为 `/private/tmp/viva-log-initialization-close-proof.json`。完整平台复核仍属于既有 L1c，不新增阶段。

以上继续归入已有 L1/L2/L3，不新增开发阶段。性能、后台关联和缓存边界尚未全部验收，因此整个日志方案保持未完成。

## L2/L3 固定负载与当前验收

本机固定请求交错对照每模式 500 次，整页五项读取 P95 2.984 → 4.080 ms（+1.096 ms / +36.71%），零丢弃，两个进程结束时积压和活动数均为零。原相对目标仍记录失败。根据实际交互的小增量约定，CI 同时报原指标，以最多 2ms 作为约 1ms 成本的保守验收带，超过时仍检查原双指标。所有默认负载要求已写出日志、零丢弃及结算完成。

另外四条路径每模式 100 次、交错执行。采用真实 ACP 操作、任务持久化、定时 SQLite 派发与本地全文检索；模型回复固定，不测云端延迟或用户主观感受。macOS 上主对话 +0.344ms，后台任务 +0.606ms，定时 +0.536ms，检索 −0.362ms。负增量只视为波动。没有排队或丢弃。证据为 /private/tmp/viva-l1c-bound-benchmark.json 和 /private/tmp/viva-flow-benchmark.json。已确认 b3b3123 原生 CI 唯一失败步骤为旧性能门槛，macOS 增加 1.757ms，Windows 增加 0.539ms。

# L1b 记忆可用性实施记录

日期：2026-11-18。分支 `codex/local-diagnostics`，worktree 为 `/private/tmp/viva-local-diagnostics`，延续已本地提交的 L1a/L1b 实现。原工作区和 ReMe 分支未被修改。本轮没有新增运行时依赖。

## 实现与分层

- 共享的请求预算只负责本进程的单调期限、取消信号和剩余时长。Renderer actions 控制同页刷新合并及旧结果失效，view 只显示已有状态、绑定重试，不直接 IPC。
- Shell 对 memory:get 的 HTTP 与 host mark 追赶执行 10 秒总预算；必要会话快照为 30 秒。Backend 业务请求上下文独立于可选日志 ALS。
- Viva client 保留 profile、onboarding、cleanupPending、revision、fileProfile 五项读取。实际批次与执行名额在可信 owner 通道中，诊断关闭或丢失不改变结算。协议 3 的 readBatchId、剩余时长为业务字段。
- Core、Node owner 和 DSH 发送屏障保留既有业务职责。未通过清空屏障、假 ready 或停止 dream 来换取页面响应；owner 恢复时明确返回不可用，dream 的异步模型与持久化重试不成为管理读取的依赖。
- 新的 Backend 发布适配器负责会话推送游标与有限回放；快照、历史保存和水位经过同一个同步发布边界。旧选题保存、旧初始化回调与旧流代次均不能回退当前视图。
- 主会话启动不再等待可选记忆资料。前台缓冲有数量、序列化持有量和年龄上限；失败后停止积压，保留草稿、文件、图片，提供手动重试并阻止模型发送。边界或回放不完整时显示缺口并保持失败。

## 重点回归

`test/memory-availability.test.ts` 使用真实 owner 和物理发送许可：dream 模型保持未返回时可完成五项页面读取；两轮失败重试后仍可读取；持久化失败任务在重启恢复时继续独立执行。另覆盖两次调用方超时占满两个真实执行名额、第三次即时 busy、迟到终态先结算后第四次独立读取成功、同 epoch recovering/unavailable 不释放名额、换代隔离、HTTP 丢响应及快照 HTTP 期限。

`test/renderer-initialization.test.ts` 与现有 ingress/actions 测试覆盖快照先安装再有序回放、水位前的重复推送过滤、旧代次与旧异步快照拒绝、30 秒预算的短时钟验证、数量/字节/年龄超限、停止积压、手动重试、同页读取合并及超时后独立重试、迟到结果不覆盖、日志端口抛错，以及撤回缓存不复活。

原抽屉冒烟直接使用 webContents.send 注入无业务水位事件，与新增同步契约冲突，导致第一轮构建冒烟失败。已读取错误上下文、应用日志和诊断附件，保留失败产物；合成流改由现有自动化驱动进入真实 Backend 发布入口，定向重跑通过。没有放宽生产校验，也没有修改测试运行器、CI 或另一工作区。

## 最终验证

| 检查 | 结果 |
| --- | --- |
| 全量测试 | 最终 2157 项：2155 通过、2 跳过、0 失败 |
| 定向启动/预算/owner 回归 | 38 项通过；补充撤回交错后初始化回归 10 项通过；发送屏障与 owner 定向复核 45 项通过 |
| 类型检查 | 通过 |
| 构建与完整冒烟 | 构建通过；完整冒烟 15/15 通过。随后补充快照 HTTP 的取消期限，再次构建通过，并由独立故障注入复核当前产物 |
| 独立插件及 DSH Web | 通过，modelRequests 为 47，pageErrors 为空 |
| macOS owner SIGSTOP 故障注入 | 通过：两次超时约 10005.2ms、10003.0ms；满额 4.4ms 返回 busy；恢复后新读取成功，手动重新加载、草稿和文件附件保留通过 |
| 双语与文档检查 | 通过 |

故障脚本最初使用了猜测的“重试”按钮文案，实机实际为既有“重新加载”；另一次误把 owner 恢复等同于页面必然自动刷新。夹具按真实 UI 文案及方案要求的手动重新加载修正，未改动应用行为来迁就测试。最终 `smoke/l1b-availability/result.json` 已记录成功结果，`owner-busy.png` 和 `recovered.png` 保留实机截图。两个先前超时不代表 owner 执行结束：恢复前即时 busy、恢复后成功的实测同时覆盖了执行结算。

末轮自检补齐撤回与快照返回的交错：先收到 trace/生成副本或报告撤回通知时，不能再安装旧水位的快照；重复的旧通知也不能降低撤回水位。快照重试必须证明边界完整，否则继续显示缺口。对最终构建的完整冒烟另存于 `smoke/l1b-final`，继续验证，不使用失败重跑覆盖原证据。

该追加完整运行实际为 13/15：拖拽 trace 显示模拟按住期间插入了测试未发送的原生 `buttons=0` 事件；记忆场景则由新日志定位到 `recordSession → bindProject` 重复执行两次，第二次撞上 owner 的约 100ms 恢复窗口。新会话本已由桥接层 onSessionCreated 完成登记，故移除选中后的重复登记，不增加自动写入重试。真实 DSH 回归在旧代码得到 `2 !== 1`，修复后通过；记忆与拖拽按已读取的证据定向复核 2/2 通过。完整运行的失败证据保留，不将其改记为通过，后续阶段仍需对当前提交再跑完整验收。

## 边界与剩余工作

本轮不放宽 L1a 的性能门槛；上一轮 P95 增加 0.426792ms / 13.0762% 的失败仍有效。L1c 的心跳、清空协调与 Windows 故障矩阵、L2 其余主线日志覆盖、L3 双平台安装包和发布性能验收仍未完成。Windows 实机验证未在本轮 macOS 环境执行。本记录是实施自检，不代表新增了独立子 agent 的全面代码评审。


## 追加：dream 重试与前台发送

已确认一条风险路径，不将它等同于另一台电脑现场的唯一原因：`runJob` 无条件通过全局物理发送 fence 执行 notes/documents recovery，即便没有待恢复的文件提交。每次失败重试都可能关闭前台准入、撤销未提交的前台 transport；若 transport 尚未真实 settlement，fence 仍须保持等待。

修复在存储端提供只读 `needsRecovery()`，Core 仅在确有 journal/清理待办时进入原有 mutation；不释放实际 transport、不改变 owner epoch，不绕过来源变更/遗忘准入。同时修复临时准入不满足的扫描：保留当前 dream 待办并等待下一次 wake，不能把暂时不可用的笔记视为已完成的空扫描、推迟到次日。

复现与回归：

- 用本地提交 `63043ac` 的旧 `memory-dream-jobs.ts` 在隔离临时模块运行同一回归，得到前台 permit 的 `true !== false`（被错误撤销）；当前源码通过。临时模块已删除，失败日志保留于 `/private/tmp/viva-l1b-old-fence-repro.log`。
- 模型超时、无效 JSON、语义校验拒绝、取消，连续失败和 runner 恢复均不撤销无关的前台发送；真正的 prepared 文件恢复继续撤销并等待 transport settlement。
- 真实嵌入式 DSH 使用本机 HTTP 503 和无效 JSON，实际发生至少两轮失败后，带已许可记忆的前台请求能够送到模型；再次重启恢复 dream 后仍能发送，memory:get 可读，owner 没有遗留 source-change intent。
- 首轮实机回归误把冷启动尚未选择模型的 unavailable route 计为模型失败；修正为先通过真实前台读取已许可记忆、选定模型，再等待实际失败次数。未放宽生产准入。

完整测试及 L1c 故障验证的最终追加记录见 [L1c 实施记录](qa-logging-l1c-implementation-20261118.zh-CN.md)。

追加修复已本地提交 `254dc2e`。最终完整测试 2182 项：2180 通过、2 跳过、0 失败；完整冒烟 15/15 通过，另有最终构建的进程暂停/清空恢复与原生导出故障冒烟通过。

后续日志批次再次复核本轮行为：全量 2206 项、2204 通过、2 跳过，完整桌面冒烟 15/15。改用测试专用进程暂停适配器后，macOS 两次真实 owner 读取分别在 10003.6ms、10004.8ms 超时，第三次 2.9ms 返回 busy；恢复真实执行后，新读取、页面手动重试、草稿和附件保留均通过。日志为 `/private/tmp/viva-l3-portable-owner-smoke.log`，实机结果保存在 `smoke/l1b-availability/result.json`。Windows 适配代码还需原生 CI 验证，不将它计入已通过平台。

随后原生 Windows CI 实际通过该 owner 故障专项：两次超时 10011.8ms、10002.2ms，满额 2.3ms busy，恢复后新读取、手动重试、草稿与附件保留通过。证据见 [b165003 诊断专项](https://github.com/JNS0724/Viva/actions/runs/44163578395)。该 workflow 仍因独立的 5% 日志性能门槛失败，不能将 L1b 的通过概括为日志方案整体通过。

## 本轮 L1b 复核：初始化缺口与重试水位

本轮继续仅修改 `/private/tmp/viva-local-diagnostics`，保持 `codex/local-diagnostics` 分支；没有修改另一个 agent 的工作目录、测试运行器、测试分路或 CI。没有新增依赖。

先补回归再修复了三类实际同步问题：首条收到的增量为游标 3、快照水位为 0 时，原实现没有识别游标 1/2 的缺口；同一游标的缓冲推送会被重复应用；失败时丢弃的事件未必被手动重试返回的较旧快照覆盖。前三项在修复前均失败，记录为 `/private/tmp/viva-l1b-startup-boundary-repro.log`。补充检查还复现了流换代时沿用旧流缺口的问题，记录为 `/private/tmp/viva-l1b-replacement-boundary-repro.log`。

Renderer actions 现在独立校验本次初始化的首个游标、缺口及重试前已收到的水位，快照覆盖缺口时仍可正常初始化；同流重复或较旧推送不会再次应用，换代使用新流自己的首游标和缺口。不能证明完整性时保持 gap 失败，不安装快照或释放模型发送。所有检查只保留有界同步元数据，不增加事件缓冲容量。

Backend 的页面读取方法准入改为依赖 `memory/contracts/host.ts` 的业务定义，不再依赖 `READ_STAGE` 日志标签表；该表现在只生成诊断阶段。真实执行名额、readBatchId 结算与物理发送屏障语义保持不变。

本轮全量测试为 2221 项：2219 通过、2 跳过、0 失败，168.8 秒。包含真实 owner 的 dream 模型等待、两轮超时失败及持久化恢复期间五项页面读取；真实 DSH 的 HTTP 503/无效 JSON 连续失败、重启恢复后前台发送和 `memory:get` 均通过。初始化定向回归 14/14，类型检查、构建通过。日志分别为 `/private/tmp/viva-l1b-current-full-tests.log`、`/private/tmp/viva-l1b-startup-final-targeted.log`、`/private/tmp/viva-l1b-current-typecheck.log` 和 `/private/tmp/viva-l1b-current-build.log`。

当前构建完整桌面冒烟 15/15 通过（4.6 分钟），日志为 `/private/tmp/viva-l1b-current-full-smoke.log`，独立产物目录为 `smoke/l1b-stream-boundary/`。macOS 真实 owner 暂停专项也通过：两次请求分别在 10005.4ms、10004.1ms 超时，第三次在 3.0ms 返回满额 busy；恢复真实进程后，新读取、页面手动重新加载、草稿与附件保留均通过。日志为 `/private/tmp/viva-l1b-current-owner-smoke.log`，实机结果为 `smoke/l1b-availability/result.json`，截图为该目录的 `owner-busy.png` 和 `recovered.png`。本轮新增的同步边界修改尚未在原生 Windows 执行，不将先前提交的 Windows 验证冒充本轮证据；日志整体的原始性能门槛结论也没有改变。

# 日志 L3 发布收尾进展（2026-11-18）

本记录对应独立工作区 `/private/tmp/viva-local-diagnostics`、分支 `codex/local-diagnostics`。L2 已在 `a109f42` 本地提交。本阶段尚未通过全部发布验收。

## 已实现的收尾

- 设置页提供本地诊断包导出、打开日志目录、清空/重试清空、限时调试及刷新状态。直接调用现有 Shell 控制面，不依赖 memory:get、Backend HTTP 或 owner。状态读取有 2 秒预算，导出沿用原生 30 秒和配额限制。
- UI 采用纯 state/actions/view 分层，沿用设置页组件和样式；所有新文案同时提供中英版本。状态明确是桌面进程日志，不将它的 droppedCount 冒充所有进程合计。未保存的 API key 在重绘和清空后保留。
- 复用 `keepingInput` 时发现受控调试复选框会被恢复成旧 checked 值：真实清空后 Shell 已关闭 debug，UI 仍勾选。已用受控值和 busy 状态的 `data-version` 修复，没有关闭输入/焦点保护。实机回归确认清空后状态与 UI 同时关闭。
- 应用和独立插件构建均生成诊断 build-info。仅将干净 Git checkout 的实际 40 位 HEAD 写入产物，未提交源码或无 Git 的源包明确为 unknown，不把本地改动标成旧提交。输出只允许十六进制提交或 unknown，不接受任意环境/路径文本。

## 当前验证

- 设置状态/actions 回归 4/4，涵盖迟到状态、导出重复点击、状态期限、清空恢复、调试过期、IPC 失败及异常文本不泄漏。
- 构建、IPC、模块分层和初始化相关定向集通过；独立插件产物测试 4/4 通过。最终 `npm test` 为 2203 项、2201 通过、2 跳过、0 失败（153.6 秒），记录为 `/private/tmp/viva-l3-verified-tests.log`；`npm run typecheck` 通过。完整桌面冒烟 15/15（4.7 分钟），记录为 `/private/tmp/viva-l3-full-smoke.log`。
- `scripts/smoke-diagnostics-settings.ts` 在 macOS 实际窗口验证宽窗/880px 窄窗、导出、临时调试、清空及输入保留，ZIP 中无未保存 key 和本地 profile 路径。截图保存在 `smoke/l3-settings/`。
- 实机冒烟的第一次失败是测试按钮定位文案与实际文案不同；第二次则发现上述真实 checked 恢复问题。两次均核对日志后修复，不以重跑掩盖。
- 新增虚拟时钟测试曾在实际 IPC request 开始前推进时间，导致后续读仍使用第一条永久 pending fixture；已先等待请求启动，再推进期限，旧测试进程已清理。
- 本批第一轮全量为 2203 项、2200 通过、2 跳过、1 失败：模块守卫发现 action-types 与 diagnostics-state 的类型导入环。已将独立状态类型移入 diagnostics-types，保留守卫原断言，定向分层与 actions 共 8 项通过，重新运行后的全量全部通过。

## 性能与平台门槛仍未完成

固定真实 memory:get、500 次/模式、100 轮交错、每请求间隔 20ms 的最新对照：关闭诊断 P95 2.442958ms，开启 2.770125ms，增加 0.327167ms / 13.3922%，零丢弃，末尾队列和活动 span 都为零。记录为 `/private/tmp/viva-l2-latency.json`。仍未通过原门槛（增幅不超过 5% 且增加不超过 10ms），没有修改阈值或用饱和/丢日志的结果替代。

此前 CPU profile 将热点定位到事件接收/活动登记、身份脱敏和 Pino 编码；后续优化须基于这个证据重新测量，同时保留统一内存/在途计账、实际关闭回执、清空换代和异常隔离。Windows 原生故障与安装包验收尚未执行，macOS 的 Windows 布局模拟不算该平台实测。

另外在仓库外建立编码工作线程原型，仅用于判断收益，没有合入生产 logger。相同完整固定负载测得 2.546083→2.804250ms，增加 0.258167ms / 10.1398%，仍未达标；总 CPU 开销和最大写入延迟反而上升（约 57–61ms）。因此没有仅为这点收益引入新的生产线程、关闭回执及双份消息计账复杂度。原型及结果位于 `/private/tmp/viva-diagnostic-encoder-prototype/` 与 `/private/tmp/viva-encoder-prototype-latency.json`，不作为发布通过证据。

同样 500 次/模式的上下文隔离对照（无 sink，保留实际环绕、ALS 和跨进程上下文）为 2.453667→2.472750ms，增加 0.019083ms / 0.7777%，记录为 `/private/tmp/viva-l3-context-latency.json`。这支持继续检查日志端口之后的校验、活动登记、编码与写入，而不是把请求期限、真实执行名额或业务上下文机制删掉。它不代表完整日志性能验收通过。

## 追加：隐私边界、安装包与跨平台故障夹具

自检复现 `safeDiagnosticEvent` 对事件名等字段校验后再次读取的问题：动态 getter 可在第二次读取时返回未校验文本。旧提交的临时模块得到 `oldGuardAllowedChangedName=true`，当前实现将每个字段及 identities/metrics 信封只读取一次，再复制通过白名单的原始值。新增回归同时检查 guard 输出和真实 Pino/SonicBoom JSONL，不以类型断言替代运行时校验。没有改用无界字段枚举。

修改后的固定完整负载仍未通过性能门槛：2.387292→2.781333ms，增加 0.394041ms / 16.5058%，零丢弃，最终队列和活动数为零，记录为 `/private/tmp/viva-l3-captured-event-latency.json`。仅保留接收校验/活动登记、不编码写入的隔离试验为 2.373250→2.711250ms；它用于区分开销，不是性能通过证据。CPU profile 会明显影响绝对时延，不能用 profile 结果替代相同条件下的正式测量。本次 getter 修复属于隐私修复，不声称已优化性能。

macOS 已实际构建 DMG、只读挂载并从卷内启动安装产物，在仓库外完成完整记忆与重启验收：`smoke:package` 1/1，通过真实打包的本地向量模型；控制台无异常。日志为 `/private/tmp/viva-l3-installed-mac-smoke.log`，产物证据在 `smoke/l3-installed-mac/`。该 DMG 包含 `50406fa` 和本次 getter 修复，尚未包含随后增加的跨平台故障夹具/托盘菜单 ID；未提交源码构建的 buildCommit 正确为 unknown，不将它标成干净提交。自有挂载卷已卸载，没有安装到用户的 Applications 或修改用户配置。

新增测试专用进程暂停夹具：Unix 用 SIGSTOP/SIGCONT；Windows 通过独立 PowerShell/Win32 调试进程持有初始断点，先关闭 debugger-exit 杀目标行为，收到恢复指令或 stdin EOF 后继续并分离。只允许测试自有进程，拒绝自进程和非法 PID。测试确认真实心跳暂停与恢复，恢复可重复调用。三个自有故障脚本改用该夹具，原生导出在 Windows 复用真实托盘菜单，不新增应用自动化接口。设置冒烟也纳入严格类型检查。新增独立 `local-diagnostics.yml`，没有改动现有 check/package 工作流或另一工作区的测试运行器；其中固定负载性能门槛保持真实失败，不允许 continue-on-error。

本批最终全量测试 2206 项：2204 通过、2 跳过、0 失败（169.7 秒），类型检查、构建和双语检查通过。完整桌面冒烟 15/15（4.6 分钟），记录为 `/private/tmp/viva-l3-portable-fault-full-smoke.log`。本地夹具运行在 macOS；Windows 分支仍等待原生 CI 验证，不因增加夹具就算验收完成。

三个故障专项均通过：owner 两次实际读取约 10003.6ms、10004.8ms 超时，满额 2.9ms busy，恢复后新读取/手动重试成功并保留草稿和附件；Backend/Renderer 同时暂停后原生导出 60562 字节 ZIP，保留到 `smoke/l1c-export/`；Backend 沉默被心跳识别，清空先在 2003.1ms 返回 cleanup_pending，恢复后实际关闭并轮换盐，Backend/owner PID 均不变，memory:get 正常。相应日志为 `/private/tmp/viva-l3-portable-{owner,export,controls}-smoke.log`。设置宽/窄窗、导出、清空、临时 debug 和未保存 key 保留再次通过，日志为 `/private/tmp/viva-l3-portable-settings-smoke.log`。

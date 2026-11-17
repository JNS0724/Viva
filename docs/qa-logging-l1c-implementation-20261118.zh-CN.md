# L1c 诊断加固实施记录

日期：2026-11-18。分支 `codex/local-diagnostics`，独立工作目录 `/private/tmp/viva-local-diagnostics`。原开发工作区、测试工程改造分支和 ReMe 分支均未修改。本批没有新增运行时依赖，继续使用锁定的 Pino、SonicBoom 和 yazl。

## 实现与分层

- 可移植 contracts/health 只定义固定元数据与校验；Node 诊断层负责心跳、监督、单个实际在途控制、拓扑收集、可替换 writer 和清空协调。它不导入 Backend、Shell、Core、DSH 或业务状态。
- Shell/Backend/DSH 在既有进程消息入口分流诊断控制。Backend 启动握手显式等待 ready/failed，健康消息不会被误当成启动结果。DSH 插件没有额外安装一个 process message listener，也不在串行业务检查点等待诊断 I/O。
- Backend→Shell、DSH→Backend 约 5 秒发健康摘要，监督者约 15 秒无消息记录 suspect；每个子进程始终最多一个已发送但未确认结束的控制。调用方超时后仍保留实际占用，迟到终态或实际退出才回收。健康消息、控制应答各自有严格数量和字节上限，不经过 HTTP、effects 或 memory:get。
- 两个 Renderer preload 各自只保留一个待应答健康调用；Shell 分别监督各 WebContents，岛响应不能掩盖主窗口无响应。Renderer 的文件 sink 状态采用 Shell 所拥有的真实 writer 状态，不能因 preload 仍响应就声称文件日志正常。
- 原生 macOS 菜单和 Windows 托盘提供清空及 15 分钟 debug。debug 只增加白名单元数据，仍不记录正文和原始错误；后续启动的子进程在首次心跳后同步剩余时限，过期不会无限保留 debug。
- 清空先持久化目录配额准入闸门，阻止新进程在清空窗口预留旧代次 writer，再递归停止诊断写入。只有实际文件关闭、无活跃槽/导出 pin、旧文件删除后才换盐与 diagnosticRunId；导出和清空互斥。
- 未确认关闭或 I/O pending 时，操作按期返回 cleanup_pending，真实任务仍单飞。重试使用原 clearId；轮换完成后仅重试 resume，不能再次删除已恢复组件的新日志。新 writer 的 runId 必须与目录配额代次一致。
- 日志清空不取消业务、不修改 owner epoch、会话、水位、readBatchId 执行名额、effects 回执或 transport settlement。跨清空的本地 continuation 使用新 trace；旧远程诊断数据丢弃，业务仍按原契约执行。启动时首次补绑的上下文也不能在下一次清空后沿用旧 trace。

## 故障回归

`test/diagnostics-health.test.ts` 覆盖心跳单飞、sink 故障与进程沉默的区别、监督异常不影响业务、15 秒后只报一次 suspect、恢复、晚到控制应答、健康 IPC 堵塞时只保留一个控制应答、严格字段白名单、清空配额闸门、未知活跃 writer、导出 pin、盐轮换、跨清空业务 continuation、永久 pending 清空、轮换后的恢复重试和 debug 到期。

`test/diagnostics-sink.test.ts` 通过真实 Pino/SonicBoom 与 Node fs 边界注入 ENOSPC/EAGAIN/EACCES、部分写入、永久 pending 写入/关闭及洪泛。每个异步写失败均保持业务值，部分写入产生完整合法 JSONL 且按实际字节结算；关闭超时不释放实际文件槽，只有观察到真实 close 后重试才能确认关闭与删除。队列峰值不突破 4MiB。

`test/diagnostics-export.test.ts` 新增真实子进程先发 heartbeat、再发 ready 的回归。既有畸形完整行 A/秘密坏行/B、UTF-8 尾片、过大行、ZIP CRC、挂起 memory:get、quota 永久 pending 及导出监督继续验证。

并补齐 dream 的业务风险：没有待恢复文件时不进入全局物理发送 mutation；存在 prepared 提交则继续严格等待真实 settlement。临时准入未满足时保留 dream 待办而不错误排到次日。旧源码可复现前台 permit 被撤销；当前的超时、解析失败、语义拒绝、取消、runner 恢复及真实嵌入式 DSH HTTP 503/无效 JSON + 跨重启前台发送回归通过。详见 [L1b 追加记录](qa-logging-l1b-implementation-20261118.zh-CN.md)。

## 运行证据

- 最终冻结源集全量测试：2182 项中 2180 通过、2 跳过、0 失败（153.9 秒）。基础设施专项 23/23 通过。另一次在编辑方案/hash 的过程中启动的运行仅文档一致性失败；固定文档并重新检查后才执行这次最终全量验证，不把中间失败记为通过。
- 完整构建冒烟：`smoke/l1c-native` 为 15/15，通过记忆、后台任务、定时任务、会话恢复和桌面岛。末轮只调整日志清空恢复及摘要来源的诊断边界，继续执行相关构建故障冒烟。
- macOS 原生导出：暂停测试自己的 Backend 和 Renderer，最终构建原生菜单成功导出 ZIP（52478 字节；前一次为 57127 字节）。不依赖 memory:get 的完成，也不依赖 Renderer 回调。
- macOS 真实控制：Backend SIGSTOP 后记录健康超时；清空约 2003.2ms 返回 cleanup_pending，旧盐/代次不提前变更。SIGCONT 后重试完成，盐与 runId 改变；Backend 和 DSH PID 保持不变，memory:get 继续成功，过程中没有模型请求。产物见 `smoke/l1c-controls/result.json`。
- 真实前台发送专项：两项嵌入式 DSH 回归通过（无效 JSON 约 8.7 秒、HTTP 503 约 14.6 秒），实际至少两轮失败和再次重启恢复后仍能发送带已许可记忆的请求。
- 独立打包插件 + DSH Web：最终复核通过，47 个本机模型请求，pageErrors 为空。初轮因看到 TAG 文件就立即检查最终 checkpoint 而失败，停止进程后保存的数据库中三条 daily 均已 revision=processed，dream 已完成并重排下次计划。夹具改为等待实际 durable checkpoint 条件，未改生产行为或放宽条件。失败产物保留于 `smoke/memory-plugin-l1c-checkpoint-failure`。
- 最终类型检查、构建、双语与文档 hash 检查均通过。测试入口、CI、测试 runner 均未改造；只为新增测试补成本归属，为已有独立插件夹具补精确完成等待。

## 性能与尚未完成的验收

性能门槛仍为 P95 同时不超过 5% 与 10ms，不作放宽。更新真实五项读取 benchmark 使其使用当前生产 readBatch，非饱和 CPU profile 对照（500 样本/模式、100 交错轮、请求间隔 20ms）为关闭 3.460417ms、开启 3.776ms，增加 0.315583ms / 9.12%，仍失败，无丢弃、最终 queue/active 为零。

采样显示主进程 formatter/标识别名、Pino 编码及同步事件登记都有成本；饱和运行会触发有界丢弃，不能用饱和运行偶然较低的延迟来宣称默认门槛通过。CPU profile 仅用于定位，最终发布测量还须关闭 profiler 并覆盖有实际数据的工作负载与两平台。未为此引入新的复杂缓存或擅自变更门槛。

Windows 原生进程故障、托盘交互和安装包尚未实测；macOS 下模拟 Windows 布局不等于 Windows 原生验收。设置页入口与其余主线日志覆盖归后续 L2/L3。本记录是实施自检，未调用新的代码评审子 agent，也不声明 L1 整体或所有阶段已通过。

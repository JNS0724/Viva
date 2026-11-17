# Viva 日志与故障诊断方案

[English](logging-design.md) | 简体中文

更新时间为 2026-11-17。本文定义日志架构、关键流程覆盖和验收要求。L1a 的首批运行时代码已落地，实施状态见第 14 节；方案评审通过不等于全部阶段已完成。

已吸收[追加独立复审报告](qa-logging-design-independent-review-20261117.zh-CN.md)中的诊断校验隔离、L1 分批验收、清空时轮换诊断身份及 JSONL 残片处理建议，取舍见[评审记录](qa-logging-design-review-20261117.zh-CN.md)。

Viva 默认在本地保存结构化诊断日志。一次会话、记忆请求或后台任务能够跨 Renderer、Shell、Backend、DSH 插件和 Worker 关联到具体步骤。请求卡住时，记录当前等待资源与持有者；跨重启恢复时，通过业务操作身份连接前后的执行。另一台电脑可以直接导出诊断包，定位到故障所在进程和阶段。

## 1 现状和问题

以下依据合入主线的 `c3224d7` 及当前工作区中正在进行的前端改动。用户报告另一台电脑出现 `memory:get` 卡住，并怀疑与 dream 持续重试有关。这是待验证的因果假设。

| 已确认的行为 | 对诊断和设计的影响 |
| --- | --- |
| [memory:get](../src/backend/memory-ipc.ts) 串行读取 profile、onboarding、cleanupPending、revision、fileProfile | 一条总耗时无法分辨卡在哪个子请求，需要分别记录 |
| [远程 owner 通道](../src/backend/remote-memory-channel.ts) 每个请求默认超时 30 秒，已带 requestId 和 epoch | 复用这些关联字段，增加外层总预算与超时后的实际执行状态 |
| [owner](../src/memory/node/owner.ts) 非 ready 或存在未完成来源变更时拒绝普通读取 | 记录 owner 状态、变化原因及相关操作，拒绝和挂起分别计数 |
| [dream](../src/memory/core/memory-dream-jobs.ts) 可以持续重试，退避上限为 60 秒，部分 catch 丢失错误原因 | 记录阶段、错误分类、进展和下一次尝试，不据此推断它阻塞读取 |
| [effects](../src/memory/node/effects.ts) 在同一轮中依次等待各类 runner | 记录 runner 耗时、队列积压和唤醒来源，识别后台工作之间的等待 |
| [请求屏障](../src/memory/core/send-fence.ts) 等待实际传输尝试确认结束 | 记录取消请求与确认结束两个节点，以及尚未结束的 attempt |
| 已合入的 app 启动路径在资料加载后绑定输入；当前工作区已提前绑定，但事件 initialize 仍在 Promise.all 后 | 按最终代码保留提前绑定，拆开可选记忆加载和必要事件初始化，避免覆盖正在进行的修改 |
| [会话计时](../src/backend/session-timing.ts) 主要在结束时输出，Backend stdout/stderr 由 Shell 继承 | 增加开始与等待事件，使用正式本地文件 sink |

普通读取没有直接 `await dream`。只有日志能够证明共同等待资源、owner 状态依赖或进程阻塞时，才能把 dream 与读取失败关联为因果。一次 RPC 失败不等于 RPC 永不返回，也不等于所有 RPC 都被串行阻塞。

## 2 范围和边界

范围包括启动与恢复、主对话、插话取消、后台任务、定时任务、记忆写入与遗忘检索、索引维护、工具连接及桌面窗口生命周期。

日志提供诊断证据，不承担业务回执、幂等、任务调度或记忆真值。`app.db` 事件 journal、记忆文档 journal、`trace.db` 用户可见过程、原生 DSH 会话日志继续使用现有语义。诊断日志独立存储，数据库故障时仍有独立证据。

首版采用 Pino 日志框架与 SonicBoom 异步目的端，复用现有业务传输。L1a 锁定 Pino 10.4.0、SonicBoom 4.2.1；后者与 Pino 的依赖范围一致，避免安装两套目的端。ZIP 使用 Yazl 3.3.1 做流式归档。三项 Node 运行时依赖分别承担结构化日志、有界异步落盘和标准 ZIP 编码；已验证 Electron 内置 Node 与独立 DSH。Renderer 不新增运行时依赖，使用现有 Preload 桥接。所有诊断字段均按事件定义白名单，不能把任意业务对象交给 logger 序列化。

## 3 架构与模块归属

```text
Renderer actions / transport
  -> 受校验、限流的 Preload 单向诊断入口
  -> Shell 文件 sink

Shell IPC -> Backend HTTP -> DSH host channel -> Memory owner / core
    |              |                  |                |
    +-- 独立文件    +-- 独立文件         +-- DSH 文件     +-- 注入诊断端口

Embedding Worker -> Worker 独立文件或父进程的有界诊断通道

Shell 导出器 -> 已保存日志 + 有时间上限的状态快照 -> 本地 ZIP
```

| 层 | 职责 |
| --- | --- |
| `src/diagnostics/contracts.ts` | 无 Node、Electron、DSH 依赖的事件联合类型、上下文和诊断端口 |
| `src/diagnostics/node/` | Pino/SonicBoom 薄适配、上下文和环绕入口、容量与文件策略、活动 span、快照和安全字段处理 |
| Shell | 分配应用 runId、传递配置、保存自身和 Renderer 日志、监督 Backend、离线导出 |
| Backend | HTTP 与领域边界埋点，监督 DSH，传递上下文，不实现另一套记忆状态机 |
| Memory Core | 接收可选诊断端口并报告领域阶段，缺省为空实现，不直接访问 console、文件或 Electron |
| DSH 插件及 Node owner | 记录 host 请求、状态、恢复、传输边界和存储适配器阶段，独立运行时自行建立 sink |
| Renderer | actions 记录操作，通信适配器记录请求，state/reducer 保持纯函数，view 只展示状态 |

通用诊断模块不得反向依赖任何产品层。插件打包脚本目前只允许 `plugins/memory` 与 `src/memory`，实施时显式加入通用诊断子树并保留对其他仓库内部模块的拒绝，不放宽成任意源码打包。对应更新类型检查、独立插件构建与隔离运行验证。[插件装配](../scripts/build-memory-plugin.ts)

独立 DSH 与 dsh-web 使用同一插件诊断端口和 Node sink。宿主可以提供不含密钥的日志目录与关联上下文，未提供时使用插件自己的本地诊断目录。Viva 的设置页和 Shell 导出能力不成为插件启动条件。

诊断端口采用同步、有界、非抛出的 `emit(event): undefined` 契约，不返回 Promise。通用安全适配器捕获诊断端口自身异常，降级为空实现并增加有界失败计数。sink 的创建、异步拒绝和 flush 均在适配器内处理，业务不等待它们。业务异常继续沿原路径传播，不能被诊断异常处理吞掉。

### 3.1 成熟框架选型

Pino 提供日志级别、JSON 序列化、child logger、serializers 与 redact。通过统一适配器配置它们，避免业务各自建立 logger。默认不绑定 hostname，异常使用本方案的安全 serializer，不能使用会输出 message/stack 的默认错误序列化。child logger 只绑定受校验的关联元数据。redact 是白名单之后的第二层保护。[Pino API](https://github.com/pinojs/pino/blob/main/docs/api.md)

直接创建 SonicBoom 异步目的端并传给 Pino，配置 `sync: false`、`fsync: false`、有限 `maxLength`、`maxWrite` 和定期 flush，使用其 drop/error/write 事件观察积压与失败。受管轮转使用库的 end/close 生命周期，确认旧目的端 close 后才创建新目的端，由薄 destination 适配切换输出。reopen 的 ready 只表示新 fd 打开，不能证明旧 fd 已关闭，因此不据它回收槽或连续切换。关闭未确认时保留槽和句柄账目，停止轮转并按容量策略丢弃。文件打开、批量写入与关闭交给成熟库。两项依赖在根应用和独立插件中显式声明，不依赖偶然的传递依赖。[SonicBoom API](https://github.com/pinojs/sonic-boom#api)

显式设置公开 retryEAGAIN 策略为不在库内持续重试，EAGAIN/EBUSY 结束本次目的端尝试并交给诊断层有界退避。正常周期 flush 使用不带回调的公开形式；生命周期若使用带回调 flush，其异步 fsync 同样包含在总退出期限与在途资源计账内。停止准入、flush 超时或 destroy 发出均不等于已确认关闭，不能立即新建目的端扩大资源占用。

默认使用上述进程内异步批量目的端，避免额外 transport Worker 的内存、启动与打包成本。异步落盘仍有序列化和上下文开销，必须实测。生产路径禁止同步 flush、普通流程调用 fatal，以及在退出钩子中无界刷盘。明确管理目的端生命周期，不使用隐式退出同步刷盘的便利入口。L1a 验证所锁版本的默认行为，不能仅凭 async 或 worker 标签宣称不会阻塞。

### 3.2 环绕日志与上下文

统一提供 `withOperation` 作为薄环绕入口，在已知的 RPC、任务执行、存储和 Worker 边界记录 start、耗时、结果、异常与清理。IPC/HTTP 注册入口通过同一个包装器统一覆盖。Node 侧使用稳定的 AsyncLocalStorage.run 传播上下文并绑定 Pino child logger，跨进程仍显式传递受校验元数据。[Node 异步上下文](https://nodejs.org/api/async_context.html)

环绕入口只读白名单元数据，不自动记录函数参数、返回值或原始异常。同步函数保持同步返回，异步函数只记录最终结算，原返回值、异常身份、this 和取消语义必须保留。后台脱离调用方的工作建立新上下文并链接触发方，避免继承已结束操作。使用普通高阶函数，不引入需要转译的装饰器、全局 monkey patch 或新的 AOP 框架。

Pino 的日志 hook 包装日志调用，不能自动知道业务函数在等待哪个资源。通用开始/结束由环绕入口覆盖，dream 阶段、屏障持有者和恢复原因由对应领域模块显式报告。这些薄适配是应用诊断策略，日志编码、级别和文件 I/O 继续复用成熟实现。

### 3.3 DSH 公开诊断能力与本地接入

按当前安装的 DSH `0.2.2-rc.2` 公开文档、类型和源码建立以下复用边界。DSH 仍在 RC 版本，接口随依赖锁定并通过契约测试，不能把当前实现细节称作跨版本稳定标准。官方源码为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。

| DSH 能力 | 本方案用法与边界 |
| --- | --- |
| Cordis ctx.logger 与 exporter | 早期注册本地 exporter，将等级、来源、序号和时间映射到 Pino；logger args、格式化字符串与原始 Error 不直接保存。观察器非抛出并随插件作用域卸载 |
| tools/execute around-dispatch waterfall | 优先复用官方工具环绕接口，next 恰好调用一次，保留 normalized result、signal 与 quiescence。tools/result 的 emit 只观察结果元数据 |
| agent/status、agent/error、agent/request-error | 记录状态和安全错误分类。request-error 是 waterfall，必须继续原重试链，不能改变重试决定；不新增已 deprecated 的 agent/request listener |
| session/event 与本地 Session Log | 复用 native sessionId、事件类型、seq、turn/step 等已验证元数据。会话正文仍在原生持久化中，不复制进诊断日志，不把 session seq 当作 Viva UI 的流切换水位 |
| ctx.sessionQuery | 本机主动深入排查时使用公开历史查询，避免自行解压私有持久化格式；普通日志和默认诊断包不扫描正文 |
| llm/stream waterfall | 只在需要的已知边界观察，不改请求、提前消费或重复迭代。流终态以迭代结束/取消为准，拿到 stream handle 不证明 provider 已发送 |
| SessionTelemetryBackend/Sink 与 record waterfall | 这是公开扩展面，但 ledger body 默认镜像完整事件。首版不新建另一套 backend、不复制 capture 队列，使用元数据观察入口即可 |
| 启动诊断与本地 inspector | 利用启动结果和插件状态定位未加载/PENDING；原始启动报告可能含凭证，不自动入包。inspector 属研发手动本机工具，默认诊断不启用其原始 fetch capture |

核对入口为安装包中的 `docs/user/develop/framework/events.md`、`docs/subsystems/session-telemetry.md`、`@deepseek-ai/cordis/src/logger.ts`、`@deepseek-ai/dsh-tools/src/events.ts`、`@deepseek-ai/dsh-agent/src/runtime-types.ts` 及 `@deepseek-ai/dsh/src/startup-diagnostics.ts`。实施时以锁定包的导出类型再次验证。

emit 观察器只做有界元数据投递。waterfall 环绕保持 next、原始返回/异常及取消语义，serial 检查点如 agent/turn-stopping 中禁止等待诊断落盘、flush 或快照。DSH 的公开 hook 与 Viva 自定义 memory_host 协议分别适配；ACP 也不自动提供 Shell、Renderer 与自定义记忆请求的完整诊断链。

DSH 在 ACP 模式下的 stdout 保留给协议帧。Pino 使用明确的本地文件目的端，不能向 stdout 插入日志或盲目收集原始 stderr。插件加载失败时保存宿主观察到的退出、状态与安全错误分类，原始启动报告继续留在 DSH 本地供主动排查。

### 3.4 本地保存与联网边界

诊断只使用本地文件、本机 IPC 和 loopback HTTP，不启动云采集器、远程日志上传或远程查看端口，不把诊断 trace 自动附加到模型服务请求。人工导出只保存到用户选定的本机位置，不自动发送。

Viva 受管 profile 明确禁用 DSH 的会话遥测上传与模型请求附带原生日志两条独立路径。session-telemetry-otel 使用 DISABLED 或不挂载，FEEDBACK_ONLY 仍会在反馈时上传，不能视为本地模式。session-log-deepseek 保持 enabled:false 与既有 memory exclusion。检查其他已挂载的产品分析/exporter，不能仅改一个环境变量就宣称全部禁用。只记录检查结果，不导出完整配置。

独立插件自身诊断保持本地，不暗改宿主全局遥测设置。独立 DSH/dsh-web 的本地接入验收使用明确关闭上传的 profile；若外部宿主仍有上传能力，准确报告宿主条件未满足，不能把插件本地日志等同整个宿主不联网。模型正常业务联网与诊断不出机是两个独立边界。

## 4 事件契约和关联

| 字段组 | 契约 |
| --- | --- |
| 版本与来源 | schemaVersion、appVersion、构建提交、platform、arch、组件版本 |
| 时间与顺序 | UTC 时间、diagnosticRunId、processInstanceId、进程内递增 sequence、进程内单调时间及 durationMs；持久化关联 ID 使用当前诊断代次的别名 |
| 调用链 | traceId、spanId、parentSpanId，可选 links 连接独立异步工作 |
| 业务身份 | 经过白名单校验的不透明 operationId、requestId、taskRunId、jobId、generation、ownerEpoch |
| 事件与结果 | component、固定 event 名、level、stage、outcome、reasonCode |
| 诊断摘要 | attempt、retryDelayMs、queueDepth、completedCount、remainingCount、waitFor、blockingSpanId 等按事件定义的标量字段 |

每次用户操作生成根 trace，每次 RPC、恢复尝试和模型实际传输生成子 span。一个逻辑操作的不同重试复用 operationId，各自生成 attempt span。后台任务和定时任务开始新 trace，通过 links 连接触发方。进程重启生成新的 processInstanceId；恢复日志沿持久化 operationId 连接旧执行，不假定内存 trace 能恢复。

跨进程只传递固定长度、格式受校验的关联元数据。诊断上下文不得用于权限、scope、来源验证、幂等或请求屏障。Renderer 上送的 trace 不能成为可信业务身份，Shell 在可信 IPC 边界创建或校验自己的关联映射。

Preload 的诊断入口只接受已知事件及有限标量字段，不接收自由文本、文件路径或任意对象。HTTP、host 协议和 Worker 消息使用独立、可选、带自身版本的 diagnostics envelope，与业务参数分别校验。已识别消息只分离这一固定诊断字段，其余字段仍经过原有业务 schema；diagnostics 不进入 parseHostMemoryCommand 的 input，也不参与业务指纹与签名。

先维持既有认证、消息类型、业务协议与传输大小限制，再分别 safeParse 业务内容和诊断上下文。业务非法仍按原规则拒绝。诊断缺失时建立本地 root，诊断版本未知、格式非法、含未知字段或缺少必要 span 时丢弃该上下文、建立本地 root，并按固定原因增加 context_dropped 计数。不能记录原值或校验错误正文，不能让诊断解析异常改变业务结果。独立的纯诊断消息非法时直接丢弃，不返回业务失败。

发送端先对诊断执行有界校验，再分别计算业务消息和可选诊断的实际编码开销，使用该传输两端共享的既有限额。HTTP/JSON 按 UTF-8 字节计数，包含转义、字段名和封装分隔符，不按字符串 length 或对象大小估算。若完整消息加入诊断后超出原 body/frame/header 限额（如适用），只丢弃诊断、计 context_dropped(reason=transport_budget)，按原业务编码发送；不得压缩、截断或重写业务来腾空间。诊断校验或编码失败也直接走无诊断路径。复用现有业务编码和小型诊断编码，避免为统计而再次遍历/复制大型业务对象；无法低成本证明完整编码在限额内时，保守不携带诊断。

接收端仍对完整传输消息执行原大小限制。当前 loopback HTTP 在解析 JSON 前以 32 MiB 限制完整 body，超限返回 413，不能承诺从任意超大或未解析完的外部消息中剥离诊断后恢复业务。诊断降级语义适用于已通过传输准入的消息；Viva 自有发送端通过前述预算回退，保证诊断开关不改变原本有效业务消息的大小准入。原业务编码本身已超限时仍按原规则拒绝。诊断功能不提升既有传输上限，也不为原本无限额的传输新增业务大小限制。[接收端限额](../src/backend/rpc-server.ts) [发送端编码](../src/shell/backend-client.ts)

仅增加诊断 envelope 不提升 MEMORY_HOST_PROTOCOL。缺失、未知或非法诊断字段的交错组合属于故障降级验收，不承担旧业务协议或旧数据兼容；业务协议版本不匹配仍按原规则处理。L1b 新增的真实批次与快照同步字段属于业务契约，不能伪装为可丢弃的诊断字段。

跨进程的墙钟时间只用于阅读，不能据其差值计算耗时或证明执行顺序。因果关系来自 span、请求和响应关系，各进程耗时来自自己的单调时钟。

## 5 生命周期和等待诊断

关键操作在 await 前将 `start` 事件放入日志队列，并加入有界活动 span 表。随后记录重要 progress、wait.begin、wait.end 及一个本地终态。终态包括 completed、failed、timed_out、cancelled；调用方超时后服务端继续运行，由服务端记录 late_completed 或实际失败，通过同一请求身份关联，不能伪造服务端已取消。

等待日志必须由持有真实资源的模块报告。记录资源类别、对应操作或 span、开始时间、最老等待时长和数量。不能因为两个任务时间重叠就填写 blockingSpanId。无法识别持有者时明确记录 unknown，并留下最后成功阶段。

覆盖的等待资源包括 owner readiness、恢复操作、effects runner、发送屏障中的 transport attempt、数据库 busy、模型响应、Embedding Worker、HTTP 响应与 SSE host mark 追赶。记录准入拒绝和等待是两个不同结果。

默认慢请求阈值为 2 秒。第一次超过阈值记录快照，仍未结束时最多每 30 秒补一次摘要，结束时记录完整耗时。后台长任务同样报告阶段进展，其成功期限独立配置，不能把跨越慢阈值直接当作失败。

活动表默认每进程最多 2048 条，满时保留现有 span，统计未被跟踪的新增数量，业务照常执行。业务状态是权威来源，快照只引用既有状态，不建立第二套任务或屏障状态机。

## 6 memory:get 和 dream 的首批覆盖

`memory:get` 记录 Renderer 发起、Shell 收到、HTTP 发出、Backend 收到、五个 owner 子读取、结果生成、HTTP 接收、host mark 追赶及 Renderer 应用结果。每个边界分别记录开始和结果，未完成的子步骤可以单独识别。

每个 dream 任务记录 Extract、Integrate、Verify、Tag 的开始与结束、处理数量、操作身份及检查点提交。retry.scheduled 保留失败阶段、稳定 reasonCode、尝试次数、下一次执行时间和进展摘要。等待新依据的 deferred、外部唤醒的 wait、无新增内容的成功空结果，与技术失败重试分别记录。

内层模型纠正尝试、队列再次执行、SDK 的实际传输重试分别计数。只在现有适配器能够观察实际发送边界的位置埋点，不通过修改 SDK 私有行为猜测发送是否发生。catch 转 retry 前报告安全错误类别，保留原业务结果。

owner 状态快照包含 ready/recovering/unavailable、replayingWrites、待来源变更数量、待 host effect 数量、屏障 pending attempt 数量及最老等待时间。状态变化附原因和相关操作，计数从原有权威状态读取。

诊断输出应区分以下情况。

| 情况 | 能够支持结论的证据 |
| --- | --- |
| dream 失败但读取正常 | 相同时间段 dream retry 与 memory.get completed，owner ready |
| owner 正在恢复，读取被拒绝 | memory.get failed 的拒绝原因和对应 owner 状态及恢复操作 |
| Backend 已发送，DSH 未处理 | Backend 请求发出而插件无接收，结合 DSH 心跳和进程退出信息 |
| 插件已接收，存储步骤未结束 | owner span 开始和存储子阶段缺失终态，结合事件循环及存储证据 |
| 结果已生成但页面仍等待 | 插件响应、Backend HTTP 响应、Shell mark 等待、Renderer 应用各边界的缺口 |
| 屏障无法释放 | 具体 mutation、待确认 transport attempt、取消时间和 settlement 缺口 |

诊断只能把故障缩小到有证据的边界。缺少接收日志时，还需结合 sink 丢弃或失效状态，不能直接宣告请求没有到达。

## 7 L1b 启动隔离和请求期限

本节属于独立的 L1b 可用性修复，L1a 日志交付不以这些业务改造完成为条件。保留当前提前绑定基础交互的改动，把可选记忆资料加载从必要启动任务中拆开。历史快照、当前会话选择与事件回放保留既有初始化顺序，必须在有效快照建立后释放缓冲事件，防止旧快照覆盖新推送。记忆加载完成不再作为释放主会话事件的条件。

必要快照一次初始化最多等待 30 秒。前台事件缓冲最多 1024 条、2 MiB，最老事件最多等待 15 秒，任一限制先达到即结束该次初始化并进入可恢复错误状态。容量包含实际持有的事件内容，但日志只记计数。停止为该初始化继续积压，保留草稿和附件，不静默丢弃事件后继续应用增量。手动重试使用新的初始化 generation，重新取得可信会话选择和必要快照，再关联该 generation 的有序事件；旧快照与旧推送不能混入。沿现有重连/快照入口重同步，无法重放的流式尾部明确显示缺口，重新建立安全状态前不发送模型请求。记录溢出、最后接收序号和重同步结果，相关回归验证属于 L1b。

Renderer 的本地初始化 generation 只用于拒绝旧异步回调，不能证明同一会话推送的新旧。L1b 补充最小可信同步契约，由 Backend/Shell 的业务事件发布入口提供 streamGeneration 和递增 eventCursor，必要快照在同一发布顺序中返回对应的 cutoverCursor。重试校验会话身份和流代次，先安装快照，再只应用该水位之后的有序增量。快照与水位获取必须经过同一发布边界，不能在异步快照后随意读取一个游标。无法证明边界或重放不完整时保持初始化失败并展示缺口。日志 traceId 不承担这些业务同步字段的职责。

为 memory:get 设置 10 秒端到端预算，子请求继承剩余预算并受现有 30 秒 owner 上限约束。跨进程传递剩余时长，接收端建立本地单调期限，每个阶段扣除自身等待，不能把不同进程的单调时间戳直接比较。外层期限独立覆盖通信丢包与 host mark 追赶，页面获得明确 unavailable/timeout 状态及手动重试入口，不能返回伪造空记忆作为成功。

调用方超时不代表服务端已停止。仅合并同一页面中尚未过期的刷新。期限到达时结束调用方 span、从合并表移除、释放调用方并发占位并关闭该请求可取消的 HTTP 资源。新的手动重试获得新 requestId，不复用旧 Promise。迟到结果只记诊断，不更新 UI。

尚未确认结束的服务端读取另行计入有界执行名额，同一 owner epoch 的记忆页面读取最多 2 个批次。超时批次保留其名额，直到服务端确认结束或 owner 实例退出/epoch 改变，因此首次挂起后仍允许一次独立重试。名额全部被未结束批次占用时，新请求立即返回明确 busy 状态，不进入无期限等待，也不继续堆积 owner 请求。清理已到期批次的诊断记录不能释放真实执行名额。采用此上限的正常并发读取与恢复都必须测试。

批次名额归可信 host/owner 业务请求协调层管理，使用独立 readBatchId，不属于诊断活动表。保留五个读取方法的现有语义，为每个已发出的子请求登记执行身份和 owner 实例。调用方超时后结束批次的后续派发，但保留已发出且未结束的执行记录。通道收到可信 owner 终态时，先结算执行记录，再决定是否存在可交付的 caller waiter；现有 pending 映射超时删除、迟到结果被忽略的行为不能直接用于结算名额。只有可证明未发送、全部已发子请求真实结束、owner 退出或 epoch 更换才能释放。日志只观察此状态，丢日志不影响名额。

取消使用已有可取消边界，不用 Promise.race 后丢掉仍在执行的任务。写入、遗忘和撤销沿 operationId 查询回执，不因超时自动生成新操作重试。

UI 可操作与模型请求获准分别判断。owner 未恢复时仍执行现有 DSH 请求屏障，明确显示暂不可发送的原因。禁止通过假 ready、清空屏障、忽略撤回或超时强制放行来恢复可用性。

## 8 全部关键流程覆盖

| 流程 | 必须记录的节点 | 阶段 |
| --- | --- | --- |
| 启动与进程恢复 | 启动请求、ready、插件加载、owner 恢复、事件初始化、退出原因、重启尝试 | L1a 记录、L1b 修复、L1c 加固 |
| 记忆读取与 dream | 完整跨进程边界、五个子读取、四阶段、重试与进展、屏障及恢复 | L1a 记录、L1b 期限与结算 |
| 主对话与插话 | 发送、来源摄取、上下文注入、准入、实际发送、首响应、结束、取消及 settlement | L2 |
| 后台任务与路由 | 创建、领取、路由、启动、等待用户、恢复、回传、回执及幂等命中 | L2 |
| 定时任务 | 到期、领取、派发、执行、下一次时间、回执、崩溃恢复和重复拦截 | L2 |
| 会话与 daily 摄取 | 接收、日期归属、待处理数量、检查点、回执、拒绝与恢复 | L2 |
| 写入与管理 | 草稿校验、自动替换、修订发布、撤销、按需澄清、失败和幂等 | L2 |
| 遗忘与清理 | 来源排除、屏障、各副本清理阶段、pending、host ACK、完成 | L2 |
| 检索与索引 | 全文、向量、融合、关系展开的数量与耗时，模型加载、重建、过期结果拒绝 | L2 |
| 基础设施和工具连接 | HTTP/SSE 中断与重连、generation 切换、数据库事务/busy、Worker、MCP 连接与工具调用边界 | L2 |
| 桌面交互 | 窗口和桌面岛创建/销毁/展开/收起、焦点请求、操作失败，不记录逐帧拖拽 | L2 |
| 导出与日志自身 | 文件写失败、队列丢弃、轮转、导出缺口与完成、离线使用 | L1a 安全基础、L1c 故障验证、L3 发布验收 |

流式输出只记录首响应、定期数量摘要和最终状态，不逐 token 记录。工具名使用内置枚举或不透明 ID，不直接保存第三方提供的任意名称、参数或输出。

## 9 文件保存与容量

Viva 使用 userData 下的 diagnostics 目录。每个进程实例写自己的 JSONL 文件，不跨进程共享文件句柄。Renderer 由 Shell 记录并保留 Renderer processInstanceId。Worker 通过有界消息队列转给父进程时，记录此依赖，父进程失联由其监督者观察。

默认保留 7 天，受管诊断文件的逻辑字节硬预算为 100 MiB，单文件最多 8 MiB。Shell 管理 Viva 配额，独立插件由自己的 Node 管理器承担同一职责。配额在分配文件槽时预留，活动文件、已关闭文件、控制清单和导出固定范围均计入同一个预算。写入器只向已获配额的槽写入，不等待新配额；预算不足、管理器失联或删除失败时停止新增文件并丢弃计数，不能靠无限轮转绕过上限。

每个诊断目录最多 8 个独立写入器，额外 Worker 使用现有父进程的有界通道。配额只回收已关闭且未固定的普通文件。writer 登记包含 runId、processInstanceId 与监督者持有的退出证明，不只检查 PID。确认退出后关闭的槽可清理；Shell 崩溃后，下次启动先确认上次实例不再持有目录和旧写入器已经退出，再收回槽。无法确认的槽继续占预算，允许降级丢日志，不能继续分配无界空间。ZIP 与临时导出文件位于用户选择的目标目录，独立受下节导出上限约束。

单条事件最多 8 KiB，每进程排队与在途日志数据合计最多 4 MiB，预算覆盖适配器和 SonicBoom 内部缓冲，不能各自配置 4 MiB 后叠加。用库的 maxLength/maxWrite 和 write/drop 事件加上适配器准入计账共同约束，在途字节直到实际 write 确认才释放；适配器按最长转义后的编码上界预留，计入框架附加字段。每个 sink 同时最多一个文件写入，单次最多 64 KiB，文件切换同样串行。写入超时或永久 pending 时停止后续准入，不反复创建 Promise 或新目的端。Renderer 单批最多 64 KiB、每秒最多 10 批。字段先在生产边界白名单化，格式不合法或过大的事件在交给 Pino 前丢弃并计数，不截断成不可解析 JSON。

薄 destination 收到 Pino 已编码的一行后，用实际 UTF-8 字节与预留对账并退回差额；大小越界则整条丢弃。级别过滤、序列化失败和准入拒绝退回整笔预留。SonicBoom drop 对未接收的字节单独结算，write 对实际写入的字节按 FIFO 结算，部分 write 只释放已确认部分，不重复释放。write 返回 false 只表示背压，不能据此认定丢弃或重复投递。error 将目的端标记失效，未确认的数据和文件配额保留到真实释放/关闭后再对账；无法确认则保守占位并停止新增目的端。

默认 info 记录关键步骤，warn 记录慢请求、重试及可恢复异常，error 记录终止失败。debug 限时 15 分钟，不改变敏感字段规则。先丢 debug 和重复摘要，预留部分容量给失败、开始和终态事件；队列彻底耗尽仍以计数报告，不承诺无损审计。

异步写入不反压业务调用。写入失败时短时保留有界内存摘要并退避恢复，避免递归打印。启动时检查上次运行没有终态的 span，标记 incomplete，不能推断对应业务未提交。退出时最多等待 2 秒 best-effort flush，崩溃和断电可能丢失尚未落盘的尾部。

## 10 心跳与导出

Backend 向 Shell、DSH 向 Backend 每 5 秒发送不含正文的健康摘要，包含进程实例、事件循环延迟、活动请求数量、最老阶段及 sink 状态。使用独立于业务 HTTP 和 effects 的有界子进程 IPC 消息，与 ready 握手显式分流，不能把健康消息当作启动应答。连续 15 秒未收到时由监督者记录 suspect。它只用于诊断，不自动结束进程、撤销业务或解除屏障。心跳接收和文件日志分开，sink 故障与子进程无响应分别显示。Renderer 心跳通过 Preload 发送，只保留汇总状态。

设置页和原生应用菜单均提供导出诊断入口。Renderer 无响应时用户仍可从原生菜单操作。Shell 直接读取日志目录，不通过 memory:get 或 Backend RPC 获取文件。向存活组件索取快照总共最多等待 2 秒，其他文件的导出继续完成，缺失组件在 manifest 中标记。

ZIP 包含版本清单、日志、已取得的活动 span 快照、进程退出与导出摘要。默认不包含数据库、记忆文件、原生会话、工具 trace 正文、截图或内存转储。

每个应用实例最多一个导出任务，重复点击复用当前进度，不创建额外任务。Shell 监督独立导出子进程，整体期限 30 秒，包含文件枚举、打开、读取、ZIP 写入与收尾；2 秒快照期限包含在总期限内。导出最多固定 32 MiB 的既有文件截止范围，输出及唯一临时 ZIP 最多合计 40 MiB。读、写各最多一个在途操作，使用有界流缓冲，不把整包放入内存。manifest 列出每个文件的截取范围、缺失、丢弃计数及失败。

JSONL 按固定的源文件截止位置读取，只处理以完整换行结束的记录。截止位置落在最后一行中间时，不等待 writer 补齐，不解码或导出残片，将实际读取终点退到最后一个完整换行；没有完整记录则输出空片段。manifest 分别记录 rawCutoffBytes、exportedThroughByte、trailingBytesOmitted、partial_trailing_record，以及脱敏重编码后的 outputBytes，不能把输出字节数当作源文件游标。尾部残片不计作日志损坏，已经换行但无法解析的记录另按 invalid_record 计数且不复制原文。测试覆盖 UTF-8 多字节字符、首行未完成、崩溃尾部和导出时继续追加，源范围与缓冲仍受既有上限约束。

完整非法记录的验收使用三条均以换行结束的源记录：合法 A、包含秘密哨兵的非法 JSON、合法 B。预期 A/B 正常安全导出，invalid_record 恰好增加 1，秘密和非法原文不进入 ZIP/manifest，导出继续处理 B；因该源文件没有尾部残片，partial_trailing_record 为 false、trailingBytesOmitted 为 0。若同时存在真正的尾部残片，两项分别报告，不能把完整坏记录归入尾部截断。此用例归 L1a 的基础导出验收，L1c/L3 再做故障与发布集成验证。

Shell 的独立 watchdog 超期终止导出子进程，及时报告失败或已成功封装的部分结果。未完成 ZIP 不能报告成功。退出确认后释放固定范围并清理临时文件。若子进程未确认退出或文件未能删除，记录 cleanup_pending，保留其配额并拒绝新增导出任务，直到清理确认，不能重复产生进程或临时文件。下次启动按实例身份回收未完成导出，无法确认时继续保守计账。日志目录始终可从原生菜单打开。磁盘不可写时允许导出明确失败，要求按期结束等待，不要求生成成功 ZIP。

## 11 内容保护和遗忘

正常日志与 debug 都只允许固定事件名、受限错误码、计数、版本、耗时及受校验的不透明身份。拒绝提示词、消息和记忆正文、模型思考、请求体、工具参数/结果、Authorization、API key、连接配置、任意 URL 或原始文件路径。

Error.message、cause、stack 不直接序列化。已知错误映射成 reasonCode，未知错误类型统一记为固定枚举 unknown_error，禁止原样记录 Error.name。堆栈只保留构建清单能够验证的模块 ID、行列号与可信静态符号，未知帧省略或作不透明映射，不保留动态函数名、插件路径及 eval 名称。业务 ID 先校验不透明格式，调用链和业务关联 ID 持久化前统一生成当前诊断代次的带盐别名，可能包含正文的 effect key 和模型生成名称同样在生产端做 HMAC。业务在线协议使用的真实身份保持原值，日志映射不进入业务判断。导出在同一包内保持别名一致，清空前后的稳定别名不复用。

诊断盐与日志分开保存，导出不携带盐。默认日志从不保存正文或可用于字典还原正文的裸 hash，因此记忆遗忘不会额外遗留日志正文副本。日志保留期限不替代业务遗忘流程。

主动清空时轮换诊断盐，生成新的 diagnosticRunId，清理旧映射、有界缓存及诊断活动表，并使旧 child logger 绑定失效。仍在执行的业务不取消，后续诊断按新代次重新绑定，必要时记录 continued_after_clear，不能带旧 ID 链接回旧代次。应用运行身份、owner epoch、readBatchId 执行名额及业务回执保持不变。时间、进程与版本等元数据仍可能支持推断关联，不宣称跨包匿名。

清空只在诊断控制面暂停旧代次准入、等待旧 writer 关闭并删除文件，不等待或解除业务屏障。确认新代次和文件槽后恢复诊断写入，迟到的旧代次消息及缓冲丢弃。沿用有界 I/O 与 2 秒控制等待，未确认关闭或删除失败的资源保守计账并显示 cleanup_pending，不能报告清空已完成。已导出的 ZIP 不受影响，由用户自行管理。清空流程不删除业务数据库、回执或真实执行记录。

## 12 实施顺序

### L1 建立记忆故障诊断闭环

L1 保持一个顶层阶段，内部按以下三个批次分别实现、验证和提交。L1a 可以先交付诊断能力，L1b 的业务修复独立验收，L1c 集中验证故障与平台差异，不把它们合成一个大改动。

| 批次 | 实施范围 | 独立退出条件 |
| --- | --- | --- |
| L1a 只读诊断闭环 | 锁定 Pino/SonicBoom，端口/环绕/上下文与失败隔离；memory:get 五读、dream、owner/屏障与进程退出埋点；DSH 本地接入和独立插件打包；带基本安全边界的原生导出 | owner 不回包或 dream 失败时仍可导出并找到阶段；启停诊断、非法上下文和 sink 失败不改变业务返回/异常/准入/取消/回执。保持现有业务期限、请求名额和 UI 初始化契约；固定基础负载的性能对照达到第13节门槛 |
| L1b 记忆可用性修复 | 第 7 节的启动解耦、可信流代次和快照水位、10 秒总预算、readBatchId 真实结算及读取限额 | logger 为空实现时仍通过启动/记忆/事件回放回归，超时后可重试、迟到结果与旧推送不覆盖新状态，安全屏障不被绕过 |
| L1c 诊断加固 | 心跳与监督，容量/轮转/清空/导出故障注入，独立插件隔离运行、macOS/Windows 定向验收和初步性能测量 | 验证永久 pending、进程退出、清理失败和洪泛均有界，导出与不出机约束成立，结果附测试证据 |

L1a 从第一批就包含白名单与安全错误序列化、非抛出端口、限流、有界内存/在途 I/O、配额、串行轮转与有界退出、导出总期限/并发/大小限制、JSONL 完整记录处理和本地上传关闭。框架选型同时进行基础性能对照，L1c 扩展压力和平台测量，L3 完成全主线发布测量。若交付清空入口，则同批交付盐/诊断代次切换及未完成状态；清空完整故障矩阵在 L1c 验证。安全基础不能推迟到加固批次。

L1 整体完成需三个批次均通过；这不阻止 L1a 先作为独立诊断交付。L1b 的同步水位和真实执行名额属于业务生命周期，诊断自身失败不能改变它们。

### L2 覆盖全部关键流程

按第 8 节补齐其余主线，以统一事件与关联语义替代相关散落 console。复用现有 SessionTiming 的测量入口，将其连接到统一 span，不保留只在 finally 才有证据的关键路径。为后台/定时任务重试和跨重启恢复保留业务身份及前后关联。

退出条件为覆盖表中的每条流程均有正常、失败和适用的恢复证据，并能从一个 operationId 找到对应的宿主请求、业务提交与后台继续执行。

### L3 故障注入与发布验收

在前述批次与 L2 主线覆盖的基础上完成全矩阵集成回归、脱敏/容量/性能测量及发布安装包验证。两个平台都检查故障时导出可用。L3 不替代 L1a/L1b/L1c 各自的准入检查，阶段完成以实际测试证据为准。

## 13 验收矩阵

L1a 执行诊断无业务影响、基础资源边界、隐私和导出用例；第 7 节的 10 秒预算、快照水位与批次名额用例归 L1b，不阻塞 L1a 单独验收。L1c 完成诊断压力/故障与双平台专项，L2 为新增主线补相应用例，L3 汇总发布验证。

| 注入场景 | 必须验证的结果 |
| --- | --- |
| dream 连续模型失败、校验失败、来源过期 | 每次重试原因/阶段/进展可见，wait/deferred 与 retry 区分，健康读取不受误判 |
| owner recovering、owner 不回包、Backend HTTP 响应丢失 | 10 秒总预算结束，定位具体边界，迟到结果不覆盖新请求 |
| 资料加载永久 pending | 基础交互和必要事件回放不等待它，缓冲有界且不乱序 |
| 必要快照永久 pending 并持续推送，缓冲超条数/字节/年龄限制 | 按期进入可恢复错误，停止积压；新 generation 重同步，草稿附件保留，旧快照不能覆盖新状态 |
| 首次读取永久 pending，到期后手动重试成功；连续读取都 pending | 释放调用方占位、不复用旧 Promise，首次可独立重试；达到真实执行上限后立即 busy 而非继续积压 |
| 两次读取都超时但随后真实完成，第三次读取 | waiter 已删除仍能结算 readBatchId，名额恢复，第三次成功 |
| 同一会话在重同步时收到旧推送、快照前后有增量 | 可信流代次与快照水位切换，无重复/遗漏/倒退；边界不明时明确失败 |
| 插话、请求取消、撤回期间 transport 不确认 | 能找到尚未 settlement 的 attempt，不提前释放屏障 |
| 主对话、后台与定时任务在各阶段失败或崩溃恢复 | 同一业务操作跨尝试可关联，超时不触发重复写入 |
| DSH/Backend 事件循环阻塞或进程退出 | 监督者记录心跳缺失或退出，原生导出可完成 |
| 数据库 busy、Worker 卡住、SSE host mark 追赶 | 明确等待资源、阶段及耗时，不把全部归类为模型失败 |
| 日志磁盘满、权限不足、超大事件与洪泛 | 业务继续执行，队列和目录有界，丢弃或 sink 故障可见 |
| 诊断端口抛异常、目录创建失败、异步 sink 拒绝 | 原写入、遗忘、检索与屏障结果不变，不吞业务异常，诊断自行降级 |
| 业务有效且诊断缺失、版本未知、trace/span非法或含未知字段 | 仅本地root/context_dropped变化，业务输出、回执、准入及MEMORY_HOST_PROTOCOL不受影响 |
| 自有发送端诊断开关切换，业务/完整编码恰好达到既有上限、加入诊断多1字节，含多字节UTF-8和转义 | 用最终编码字节判断，超预算只丢诊断并发送原业务；业务准入与关闭诊断一致，不放宽32 MiB或其他既有限额 |
| 非法/超大诊断从自有发送端发起，或绕过发送端直接送入超限完整消息 | 自有端有界校验/编码失败回退无诊断；完整超限消息在接收端仍按原规则413，不承诺解析后恢复业务 |
| 业务认证/协议/输入非法，同时诊断有效或非法 | 业务仍按原规则拒绝，诊断降级不放宽业务边界，不记录原始非法值 |
| 日志写入永久 pending | 包含在途的内存预算不超限，仅一个在途 I/O，后续事件丢弃可见，业务不等待 |
| 环绕同步/异步函数、嵌套并发、取消、抛出同一个异常对象 | 返回值/异常/this/取消不变，上下文不串任务，诊断失败不改变业务 |
| Pino/SonicBoom 启动失败、drop、部分 write、轮转、flush 与退出 | 预留与实际编码逐笔对账，差额不泄漏，背压不等于drop，两层缓冲统一计账 |
| EBUSY/EAGAIN 持续失败、flush 的 fsync 挂起、旧文件关闭失败 | 库内不无限重试，关闭未确认不回收槽或创建新目的端，退出等待有期限 |
| 写入正文、路径、密钥、URL 到 message/name/函数名/模块名与动态名称 | 普通/debug 日志与 ZIP 中均找不到这些测试哨兵 |
| 遗忘后检查诊断日志与活动缓存 | 无被遗忘正文副本，操作回执不受清日志影响 |
| 执行中清空、旧代次迟到、writer不响应或删除失败 | 换盐与diagnosticRunId，旧别名/缓存不复用，业务不取消、不释放真实名额，未完成时显示cleanup_pending |
| 清空前后相同原始关联ID及已导出ZIP | 新代次生成不同日志别名，旧ZIP不改写；不承诺时间等元数据不可关联 |
| Renderer 卡住、Backend 卡住、导出中轮转与重复点击 | 原生菜单可用，至多一个任务，固定范围与日志共用硬预算，ZIP 有明确缺失/截取范围 |
| 活跃JSONL截止于半行、UTF-8半字符、未完成首行或崩溃尾部 | 只导出完整换行记录，manifest报告原始截止/实际源范围/输出字节与partial_trailing_record，不误报日志损坏 |
| 合法A、含秘密哨兵的完整非法JSON、合法B，三条均换行结束 | A/B仍导出，invalid_record增加1，ZIP/manifest无非法原文或秘密；partial_trailing_record=false，trailingBytesOmitted=0 |
| 导出文件读永久 pending、ZIP 写永久 pending、终止后未确认退出 | 30 秒内结束用户等待，未完成 ZIP 不报成功，限制进程/临时文件数量并保留 cleanup_pending 配额 |
| 活跃文件、固定文件、进程反复退出、PID 复用与清理失败 | 文件槽硬预算不突破，仅凭 PID 不能回收，无法清理时丢日志而非增长 |
| 独立 DSH/dsh-web 插件隔离运行 | 不依赖 Viva 模块或进程，能记录写入/遗忘/检索诊断 |
| DSH emit/waterfall/serial hooks、流取消、插件卸载 | next恰好一次，结果/异常/重试/signal不变，无诊断I/O阻塞，无遗留observer |
| 本地 profile 触发反馈、会话结束与诊断导出 | 无非loopback诊断连接，不初始化远程exporter，不附带原生日志或诊断trace到模型请求 |
| Cordis原始args、原生Session body、启动报告与fetch capture含秘密 | 默认日志/ZIP只出现白名单元数据，原文与凭证哨兵不存在 |

日志契约、限流、轮转、关联、超时与状态处理使用 TypeScript 回归测试并进入现有类型检查。修改 IPC、进程生命周期、构建或插件打包时，本地运行 build 与完整 smoke，PR 在 macOS 和 Windows 执行 CI。文档运行 check:i18n。

性能验收在同一台机器对相同固定负载分别测量开启与关闭诊断，报告事件量、落盘延迟、峰值队列、丢弃数和主流程 P95。默认负载以 P95 增幅不超过 5% 且增加不超过 10ms 为初始门槛，后台饱和负载须证明队列内存有界且业务不等待 sink。日志 I/O 挂起时不得阻塞调用方。达不到门槛先调整日志实现与频率，再评估上线。

## 14 L1a 实施状态

首批实现位于独立分支 `codex/local-diagnostics`，基于 `84c16d3`，与原工作区中的测试工程改造分开开发。只在本分支登记新增测试的责任归属与成本，没有改动原工作区的测试执行器。

- [可移植契约](../src/diagnostics/contracts.ts)不导入 Node、Electron 或 DSH；Core 使用可选、非抛出的诊断端口。Node 适配器负责 ALS、Pino/SonicBoom、身份别名、配额和导出，不反向导入产品代码。
- L1a 已接入 Renderer 的记忆读取入口、Shell/Backend RPC、owner 通道、五个读取步骤、dream 四阶段及解析/校验重试、effects、物理发送屏障和进程退出/重启。模型请求和业务回执保持原有语义；仅 L1a 诊断没有提升 MEMORY_HOST_PROTOCOL，后续 L1b 业务升级见第 15 节。
- 诊断字段先走白名单，再由 Pino redact 保护。排队对象按保守内存上界预留，编码后按实际 UTF-8 计账，覆盖目的端在途数据；摘要洪泛保留开始/终态/失败的空间。轮转和退出等待实际文件关闭及配额回执，退出总期限仍为 2 秒。
- 目的端先独立异步取得独占文件句柄，再交给 SonicBoom，避免库在打开失败后继续定时 flush。文件打开失败、配额不足和诊断端口异常均自行降级；SonicBoom 不自动无界重试 EAGAIN。RPC 以原始业务字节视图加小型后缀分块发送，避免为追加诊断复制大型 body；超过既有 32 MiB 限额时只撤去诊断。
- macOS 原生菜单和 Windows 托盘提供本地 ZIP 导出、打开日志目录。导出由独立子进程完成，不依赖 memory:get；并发、总期限、源范围和输出大小受限，损坏整行与尾部残片分别报告。首批仅收集 Shell/Renderer 实时快照并报告缺失组件，后续监督能力见第 16 节。
- Viva profile 明确关闭 DSH OTEL；独立 DSH Web 验收 profile 同时关闭 OTEL 与原生日志上传。插件不修改外部宿主的全局遥测设置。

导出临时路径只保存在私有配额清单中，用于子进程异常退出后清理已确认属于该导出的临时文件；它不进入 JSONL 或 ZIP。首批构建提交写为 `unknown`，没有交付清空、debug 开关或设置页入口。后续原生控制面见第 16 节，已实现的设置入口与提交注入见第 18 节。

验证命令包括 `npm run typecheck`、`npm test`、`npm run build`、`npm run smoke`、`npm run test:memory-plugin`、`npm run smoke:memory-plugin`、`npm run check:i18n`。另有[框架微基准](../scripts/benchmark-diagnostics.ts)、[真实 memory:get 交错对照](../scripts/benchmark-memory-diagnostics.ts)和[原生导出故障注入](../scripts/smoke-local-diagnostics.ts)：后者在 macOS 暂停测试自己的 Backend 与 Renderer，确认原生菜单仍可导出，再恢复并关闭进程。Windows 的定向故障注入与安装包验证留在 L1c/L3，本轮不声明已经验证。

首批最后一轮真实 memory:get 对照为 3.263875ms → 3.690667ms，增加 0.426792ms / 13.0762%，无丢弃。它未通过第 13 节原始性能门槛，未放宽门槛。该批证据与待验证项保留在[实施记录](qa-logging-l1a-implementation-20261117.zh-CN.md)，后续性能工作见第 18 节。

L1a 的记录不包含 L1b 业务修复；L1b 当前实施状态见第 15 节，L1c 进展见第 16 节，L2 进展见第 17 节。L3 发布验收仍未完成。

## 15 L1b 实施状态

L1b 在同一独立 worktree 实现，不修改原工作区的测试工程。启动只等待可信会话快照；记忆、设置、工作目录、动态与独立任务加载不阻塞主会话初始化。必要快照有 30 秒总预算，Shell 关闭到期 HTTP 资源。前台初始化与选题缓冲均限制为 1024 条、2 MiB 保守持有量和 15 秒最老年龄；缓存保存序列化内容，不保留额外事件对象图。失败后停止积压，保留草稿、图片和文件，显示缺口及手动重试入口，在安全状态恢复前不发送模型请求。

Backend 的独立发布适配器为实际推送赋予 `streamGeneration` / `eventCursor`。历史保存同时提交所属会话及已应用水位，旧会话或倒退水位不能覆盖新状态；必要快照同步读取历史和发布边界，并附带水位后的有序前台回放。Renderer 拒绝旧初始化回调、旧代次、重复游标和不完整回放；无法证明完整性时保持失败，不能静默跳过缺口。撤回后的生成内容不会从回放缓存复活。

memory:get 在 Renderer、Shell、Backend 和 owner 通道分别建立本地单调期限，只传递剩余时长，合计不超过 10 秒，子读取也受原有 30 秒上限约束。超时、不响应和 host mark 追赶不能无限拖住页面。原有五项读取语义保留；同页只合并仍有效的刷新，超时后新重试使用新的请求身份，迟到结果不覆盖 UI。

真实执行批次由可信 Backend owner 通道管理，使用独立 `readBatchId`，每 owner epoch 最多两个页面读取批次。调用方超时或恢复/不可用状态不释放尚未结束的实际执行；可信终态先结算执行，再查 caller waiter。只有全部已发读取结算、已证明未发出、owner 退出或换代才释放。满额即时返回 busy，恢复期间返回 unavailable，不改变写入/遗忘/撤销回执或 DSH 发送屏障。业务协议升级为 `MEMORY_HOST_PROTOCOL = 3`；这与 L1a 可丢弃的诊断 envelope 分开。

回归包含真实 owner 的 dream 模型等待、连续超时重试及持久化恢复期间五项页面读取，两个超时后 busy、迟到终态后再次成功、同 epoch 恢复/不可用、换代、HTTP 丢响应、必要快照超时、缓冲上限、旧推送和日志端口故障。实际 SIGSTOP 故障注入入口为[记忆可用性冒烟](../scripts/smoke-memory-availability.ts)。抽屉冒烟的合成流改走现有自动化驱动和真实 Backend 发布入口，运行器与 CI 未改。最终测试与平台限制见[实施记录](qa-logging-l1b-implementation-20261118.zh-CN.md)。L1a 性能门槛的失败结论仍保留，L1b 不将其改为通过。


## 16 L1c 实施进展

2026-11-18 已接入独立的 Backend→Shell、DSH→Backend 有界 IPC 心跳和诊断控制，以及两个 Renderer preload 的分别监督。ready 握手显式分流健康消息；监督仅记录 suspect、恢复和 sink 状态，不结束进程、不解除业务屏障。快照由诊断拓扑递归收集，每层预留应答时间，未响应组件仍明确缺失。

原生 macOS 菜单和 Windows 托盘已提供清空与限时 15 分钟 debug。清空先关闭目录配额中的新 writer 准入，等待已知组件和实际文件关闭回执；所有槽都关闭、无导出 pin 且旧文件删除后才轮换盐和 diagnosticRunId。超时显示 cleanup_pending，实际未结束的控制仍占名额；恢复后重试同一清空身份。轮换后的恢复重试不重复删除新代次文件。跨清空继续执行的本地业务使用新 trace，旧远程诊断元数据失效；readBatchId 名额、owner epoch、任务及发送屏障不变。

首批 macOS 实测与故障矩阵见 [L1c 实施记录](qa-logging-l1c-implementation-20261118.zh-CN.md)。永久 pending 写入/关闭、部分写入、ENOSPC/EAGAIN/EACCES、IPC 无响应、清空失败恢复、队列洪泛、旧代次回调和插件独立运行均有回归。后续 Windows 原生故障和安装包结果见第 18 节。性能门槛仍未通过，因此不声明 L1 整体完成；L2/L3 继续按原范围推进。

## 17 L2 实施进展

已补主对话发送与取消后真实结算、SessionTiming、后台任务及路由、定时任务与报告、daily 摄取、管理写入与撤销、清理 ACK、检索与重建、SQLite、Worker、HTTP/SSE、MCP 和窗口生命周期的关键元数据。Core 只依赖可移植观察端口，Node 层拥有 ALS、存储和宿主适配。检索词、正文、路径、报告令牌、工具输入输出与 Error.message 不进入新增事件；流式响应只记录一次首响应，不逐 token 或逐帧记录。

提交与重试事件以实际持久化结果为准，回滚和已失效 generation 不误报成功。诊断关闭时可移植异步环绕直接返回原业务 Promise，避免增加会影响真实回执顺序的微任务。daily 也修复了与 dream 相同的无恢复工作仍关闭发送屏障的问题：仅存在实际文件意图或清理时才进入恢复屏障，模型失败重试和 runner 重启不干扰无关前台请求，真实提交与恢复仍等待物理请求结算。

回归及集成验证进展见 [L2 实施记录](qa-logging-l2-implementation-20261118.zh-CN.md)。性能门槛与 Windows 原生验收仍按原要求保留，不因主线埋点覆盖而改为通过。

## 18 L3 发布收尾进展

设置页已接入现有 Shell 诊断控制面，提供导出、目录、清空重试、限时调试与状态读取，不等待业务 Backend 或 memory:get。应用与独立插件构建注入干净源码 checkout 的实际提交；脏构建和无 Git 源包仍明确为 unknown。中英 UI、state/actions/view 分层、输入保护及实际窄窗验证见 [L3 进展记录](qa-logging-l3-progress-20261118.zh-CN.md)。已只读挂载 macOS DMG，在仓库外通过记忆与重启验收。诊断字段改为单次读取后校验及复制，动态 getter 的回归覆盖真实落盘。测试自有进程暂停夹具已有 Unix/Windows 适配，独立诊断故障工作流不修改现有测试工程分路。双平台原生故障和设置检查均已实际通过，干净 b165003 的 Windows 安装包也通过安装、记忆/重启及卸载；对应 macOS CI job 仍在排队。两个诊断 job 均仅在原始性能门槛失败：macOS 增加 0.621583ms/20.2759%，Windows 增加 0.261400ms/12.8623%，零丢弃。原门槛未改，不能声明整个日志方案完成。

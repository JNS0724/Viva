# Viva 日志方案追加独立复审报告

评审对象为 [Viva 日志与故障诊断方案](logging-design.zh-CN.md)。日期为 2026-11-17。

本报告记录一次追加独立复审，不替代既有 [日志方案评审记录](qa-logging-design-review-20261117.zh-CN.md)，也不修改原方案。本轮只对方案、当前代码和锁定依赖进行静态核对；运行时代码尚未按方案实施，未执行运行时故障注入或性能测试。

处理状态已回填到本文末尾。以下原始评审意见保留；四项建议均已落实到中英文方案，代码实施与运行验收待完成。

## 总体结论

方案的核心架构和故障边界成立，未发现新的 P0/P1 设计错误。日志不承担业务真值、调用方超时与服务端结算分离、容量保守计账、隐私白名单、本地导出和故障注入矩阵均是合理的决策。

实施前建议明确两项 P2，并补充两项 P3。首要事项是确保诊断元数据校验失败不会影响业务请求，其次是将 L1 中相互独立的日志建设与业务改造拆开验收。

## 1. P2：诊断元数据校验失败时不能拖垮业务请求

方案第 4 节要求 HTTP、host 和 Worker 中的诊断元数据经过协议校验，但没有明确字段缺失、格式错误或版本不一致时的处理语义（`docs/logging-design.zh-CN.md:128`）。

如果实现时直接把诊断字段并入现有 strict 业务 schema，可能出现：

```text
诊断字段不合法或新旧版本不一致
→ 整个 memory_host_request 被拒绝
→ 日志功能改变业务结果
```

这与诊断异常不影响业务的约束（`docs/logging-design.zh-CN.md:64`）以及诊断上下文不参与权限、来源、幂等和请求屏障的约束（`docs/logging-design.zh-CN.md:126`）冲突。

### 建议

- 诊断信息使用独立、可选、带自身版本的 envelope，不进入 `parseHostMemoryCommand` 的业务输入。
- 业务参数与诊断元数据分别 `safeParse`。
- 诊断字段缺失、未知或非法时，只丢弃关联上下文并增加本地 `context_dropped` 计数，业务请求继续。
- 不因为新增诊断字段提升 `MEMORY_HOST_PROTOCOL`。
- 增加新旧端交错、未知字段、非法 trace、缺失 span 的兼容性测试。

## 2. P2：L1 同时承担日志建设和多项业务改造，交付风险过高

方案 L1（`docs/logging-design.zh-CN.md:244-248`）同时包含：

- Pino/SonicBoom、容量、轮转、导出和心跳。
- DSH 与独立插件接入。
- `memory:get` 和 dream 埋点。
- 启动加载解耦。
- 新的 `streamGeneration`、`eventCursor`、`cutoverCursor` 同步契约。
- 10 秒请求预算。
- `readBatchId` 与真实执行名额管理。

其中后四项不是单纯日志工作，而是会改变启动、UI 状态切换和 owner 请求生命周期的业务改造。放在同一个退出条件里，任何一项未完成都会阻塞全部日志能力交付，也会扩大回归范围。

### 建议拆成三个独立验收批次

1. **L1a：只读诊断闭环。** 契约、sink、跨进程关联、`memory:get` 与 dream 埋点、基础导出，不改变业务结果。
2. **L1b：记忆可用性修复。** 启动解耦、可信快照水位、请求预算和读取批次结算，独立运行现有记忆与启动回归。
3. **L1c：诊断加固。** 容量、心跳、故障注入、独立插件和双平台验收。

## 3. P3：手动清空诊断日志时应轮换诊断盐

方案使用本地诊断盐对可能含正文的业务标识做 HMAC，并规定导出不携带盐（`docs/logging-design.zh-CN.md:238`）。但“主动清空诊断日志”目前只要求清理文件和有界缓存（`docs/logging-design.zh-CN.md:240`），没有说明盐是否保留。

如果盐不变，清空前后的日志仍可通过同类 HMAC 标识关联。

### 建议

手动清空时轮换诊断盐并生成新的诊断 runId，清除本地映射和活动缓存；明确已导出的 ZIP 不受影响，新日志不再与清空前的导出包保持 ID 可关联性。

## 4. P3：导出活动 JSONL 时需要处理不完整的最后一行

方案允许 Shell 直接读取仍在写入的日志（`docs/logging-design.zh-CN.md:208`），并按固定字节范围导出（`docs/logging-design.zh-CN.md:230`）。截止位置可能落在一次写入中间，产生半行 JSON。

### 建议

- 只截取到最后一个完整换行符。
- 将末尾残片标记为 `partial_trailing_record`。
- 不把残片当作完整事件解析，也不伪造成日志损坏。
- 在 manifest 中记录原始截止字节和实际导出字节。

## 已核对的当前实现与依赖

### memory:get 与 owner 通道

- `src/backend/memory-ipc.ts:63-69` 确认 `memory:get` 串行执行 profile、onboarding、cleanupPending、revision 和 fileProfile 五个子读取。
- `src/backend/remote-memory-channel.ts:28-41` 确认 owner 请求默认 30 秒超时；超时后删除 pending waiter。
- `src/backend/remote-memory-channel.ts:75-88` 确认迟到结果在 pending 已删除时被忽略。方案引入独立的 `readBatchId` 执行结算，而不是复用 caller waiter，符合当前缺口。
- `src/memory/contracts/host.ts:132-135` 确认业务命令通过 `parseHostMemoryCommand` 白名单解析，诊断元数据应与该业务输入保持分离。

### effects 与 dream 的因果关系

`src/memory/node/effects.ts:145-159` 确认 effects 在同一轮中按 runner 顺序等待。普通读取没有直接 `await dream`，因此不能仅凭 dream 持续重试就断定它阻塞 `memory:get`。方案要求以共同等待资源、owner 状态和进程证据定位因果，方向正确。

### DSH 接入

锁定依赖中的 `tools/execute` 是 around-dispatch waterfall，`tools/result` 是 emit 观察入口，与方案描述一致。Cordis exporter 直接接收原始 logger args，因此方案要求只提取白名单元数据、观察器非抛出是必要的。

### SonicBoom

核对了 [SonicBoom 公开 API](https://github.com/pinojs/sonic-boom)：`drop`、`error`、`write`、`close`、`retryEAGAIN`、flush 和部分写入语义与方案基本匹配。方案中两层缓冲统一计账、实际写入逐笔对账、旧目的端关闭确认后再轮转的要求应保留。

## 推荐实施顺序

1. 先补充诊断元数据的失败隔离语义和兼容性验收。
2. 将 L1 拆成只读诊断、记忆可用性修复和诊断加固三个独立批次。
3. 在导出与清理实现前补齐诊断盐轮换和活动 JSONL 残片规则。
4. 按方案现有故障矩阵验证业务结果不受诊断失败影响，再执行性能与双平台验收。

本报告不表示 dream 与 `memory:get` 卡住的因果关系已经证实，也不表示方案已经实现、性能已经达标或发布验收已经通过。

## 处理结果

2026-11-17 回填。以下为主 agent 对报告意见的处理状态，不代表原独立评审者已对修订版重新给出通过结论。

| 项目 | 状态 | 落实结果与位置 |
| --- | --- | --- |
| P2 诊断元数据校验失败影响业务 | 方案已修订，待实施验收 | 独立可选诊断 envelope，分别 safeParse；非法诊断只丢弃并计数，业务认证/协议/输入仍严格校验。纯日志字段不提升 MEMORY_HOST_PROTOCOL，不增加旧业务与旧数据兼容。[第4节](logging-design.zh-CN.md#4-事件契约和关联) |
| P2 L1 混合诊断和业务改造 | 方案已修订，待实施验收 | L1a 只读诊断、L1b 可用性修复、L1c 加固分别验收，保留三个顶层阶段。L1a 同批包含脱敏、限流、容量、导出边界、独立插件打包和基础性能对照。[第12节](logging-design.zh-CN.md#12-实施顺序) |
| P3 清空后保留诊断盐 | 方案已修订，待实施验收 | 换盐与 diagnosticRunId，失效旧缓存、绑定和别名；真实业务身份/名额保持原语义。未确认清理显示 cleanup_pending，已导出 ZIP 不改写，不承诺元数据匿名。[第11节](logging-design.zh-CN.md#11-内容保护和遗忘) |
| P3 活跃 JSONL 尾部半行 | 方案已修订，待实施验收 | 仅处理完整换行记录，manifest 区分原始截止、实际源范围、尾部残片及重编码输出字节。残片不误报损坏，补 UTF-8/崩溃尾部/继续追加验收。[第10节](logging-design.zh-CN.md#10-心跳与导出) |

中英文方案及验收矩阵已同步，[详细取舍](qa-logging-design-review-20261117.zh-CN.md#追加独立复审报告的审视与修订)保存在既有评审记录中。本次只更新文档，不将方案处理完成标成代码已修复。

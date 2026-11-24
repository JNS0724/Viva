# Agent 与记忆双运行时完全解耦方案

[English](memory-runtime-decoupling.md)

**状态 · 方案设计（待分阶段实施）。** 2026-11-24。基线：`main` 合入 PR #175（记忆旁路化及聊天历史解耦）与 `fix/memory-sidecar-lifecycle` 之后。

## 1. 目标与边界

完全解耦后，**Agent runtime 负责把当前任务做完，记忆系统负责把过去的信息整理成可查询的资料**。两者通过持久化会话事件与记忆 API 交互，各自管理进程、存储、模型客户端和重启生命周期。

| 交互 | 目标行为 |
|---|---|
| **Agent 提供记忆素材** | 可信原话、开放题回答和回合完成信息持久化后，记忆按自己的游标异步读取。会话 ID、轮次和来源 ID 用于核对与去重；记忆重启后从游标续读。 |
| **Agent 自动用记忆** | 规则与用户画像 0ms 本地可用；本轮按需检索在请求入口并行前置发起，组装请求时在极短预算内取结果并向调用方暴露明确 5 态结果（`hit` / `empty` / `skipped` / `timeout` / `unavailable`）。本轮已送出的上下文作为快照冻结保留，后续请求再读取更新后的记忆。 |
| **Agent 主动查或写** | 模型主动调用 `memory_recall` / `memory_read` / `memory_node_search` / `memory_remember`，或用户在界面编辑、停用、删除记忆时，操作在各自独立预算内等待结果；失败或离线时返回明确状态，Agent 据此继续或向用户确认。 |
| **记忆后台整理** | 日记、Dream 和索引由记忆插件内部的私有 `memory-worker` 调度，模型计算直接复用 DSH 的 `ctx.llm`（全系统唯一 LLM 网关）；通过单通道串行、429/5xx 退避与前台流式软让路控制共享配额争抢。 |

### 现状残留的三根耦合线（PR #175 之后）

PR #175 已经移除同步发送屏障、宿主级联擦除和原生会话重写，目前两个运行时之间仅剩三处直接耦合：

1. **自动检索仍卡在 `agent/pre-step` 的同步 `await` 中**，且把静态规则、用户画像和动态文件检索绑在同一次跨进程 RPC 里。
2. **`memory-worker` 被拎出归 Viva 主进程托管，形成双子进程中转与 `fromViva` / `standalone` 双路径分叉**，并导致 Note / Dream 出现 `memory-worker ↔ Viva backend ↔ DSH` 三进程折返。
3. **素材摄取仍依赖双通道竞跑**：DSH 插件扫会话推 `receiveSource`，Viva 后端另走异步 IPC 推 `sourceAlias` 与 `acceptQuestionAnswer`。

下文按四个可独立交付的阶段逐一拆解落地设计。

---

## 2. 阶段一：自动记忆注入重构（三层拆分 + 前置短竞速 + 5 态结果）

### 2.1 现状时间账与核心问题

- Agent 侧本地组装请求（`preStep` → `assemble` → `buildRequest`）通常仅需 **5~20ms**。
- 跨进程 IPC + SQLite FTS5 + Markdown 读盘核验通常需 **20~60ms**；若触发 ONNX 嵌入子进程（`memory-embedder-worker`），温启动约 **40~150ms**，冷启动可超 **200ms**。
- 如果在 `agent/pre-step` 才并行发起且 0ms 完全不等，首轮几乎永远赶不上，导致隐式约定（如“以后周报发给 B”）漏召回或被迫多走一轮工具调用。
- 同时，当前把 `MEMORY_RULES`、用户 `profile` 和动态命中片段全部拼在同一个 `systemPrompt.context('viva-memory')` 里：每次命中片段变化，规则与画像都会被重复写进会话历史，既浪费 token 又影响 Prompt Cache。

### 2.2 三层拆分

| 层级 | 内容 | 变更频率 | 供给方式 | 耗时 |
|---|---|---|---|---|
| **L1 · 静态规则** | `MEMORY_RULES`（记忆工具用法、非指令原则、超时/离线决策指引） | 固定 | 由 [adapter.ts](../plugins/memory/lib/adapter.ts) 注册为头部静态 `systemPrompt.section` | **0ms**（全会话命中 KV Cache） |
| **L2 · 用户画像快照** | 常驻用户画像摘要正文 + 今日日期 | 极低频（画像变更或跨天） | memory worker 在 `ready` 与画像变更时主动推送与底层字段解耦的纯文本快照 `{ epoch, revision, text }` 并由宿主缓存；DSH 热重启 `attach` 时由宿主直接重放最新快照，适配器本地拼入今日日期后渲染为独占的 `systemPrompt.context('viva-profile')`（`text` 为空或冷启动 worker 尚未就绪时仅带日期或暂空并放行） | **0ms**（worker 或 DSH 独立重启、检索超时均不丢画像，且后续切换画像数据源无需改 L2 协议） |
| **L3 · 本轮按需召回** | 针对本轮用户原话的 1~3 条 `daily/digest` 命中片段或状态提示 | 每轮 | 在最终投递构造点前置发起 + 组装前极短剩余预算竞速；在 `agent/pre-step` 通过 `decision.messages` 追加 `source: { kind: 'viva-memory' }` 的归属锚定消息（`<memory-recall turn="N" ref="<requestId\|messageId>">`），不走 `systemPrompt.context` | **可控上限（候选 120~150ms，以双指标实测定值）** |

### 2.3 前置发起、绑定核对与快慢分离

1. **Viva 桌面端前置发起、精确绑定与任务头透传**：预取起点设在 [acp-bridge.ts](../src/backend/acp-bridge.ts) 构造最终已校验请求的时刻——覆盖主对话 `prompt`、`agent:steer` 以及定时/后台任务的 `preparePrompt` / `steerTask`。刚生成 `requestId`、确定目标 `sessionId` 且已拿到经过宿主校验的干净查询文本时，立即异步向 memory worker 发起检索并记录 `(requestId, sessionId, deadlineAt, ownerEpoch, revision)`，**不等待 `sourceAlias`，与 ACP 传输、收件箱排队、`tools.resolve` 和 `systemPrompt.assemble` 并行重叠**。
   - **任务路径的 `requestId` 透传与原话保真**：任务会话不走主对话 `viva-routing` 的 `【请求 ID：】` 账本，改为在 `preparePrompt` / `steerTask` 使用独立于路由的轻量任务关联头（复用 `src/shared/request-routing/header.ts` 的零宽字符转义与 `spans` 计算，产出 `{ requestId, wireText, spans }`）。`acp-bridge.ts` 将干净原话 `text`、`wireText` 和 `wireSpans: spans` 传给 `recordSource`（记忆摄取按 `spans` 精确还原无头原文），同时按 `(requestId, sessionId)` 登记宿主预取；DSH `pre-step` 从消息解析 `requestId` 精确认领（绝不按文本内容匹配，旧 session 晚到结果直接丢弃）。
2. **Feed 续聊、无查询文本与凭据跳过边界（`skipped` 终态）**：Feed 续聊校验在通过时显式提取用户补充文本并通过 `sourceText` 下传（纯草稿时显式传空串 `''`，而非 `undefined`）。宿主预取与独立 DSH 回退共用同一准入判断：仅对去空白非空且未命中 `looksSecret(question)` 的有效用户原话（`sourceText !== undefined ? sourceText : text`）发起自动检索；对纯草稿、纯图片或含凭据输入，跳过检索并记录可认领的 `{ status: 'skipped' }` 终态（即使晚认领也保持静默、不调用检索器、不追加 L3，并在统计中与“完整搜索零命中”的 `empty` 严格区分）。
3. **认领优先级：先看有效已完成终态，再判截止时间（杜绝丢有效命中与二次等待）**：
   - **第一步（优先消费有效终态）**：若 `(requestId, sessionId)` 已有**在预算内完成且仍然有效**的终态（`hit` / `empty` / `skipped` / `unavailable`），**即使认领时已超过 `deadlineAt`，也 0ms 直接消费**，不额外等待、不重查；
   - **第二步（未完成时按 `deadlineAt` 判定）**：若查询尚未完成且未到 `deadlineAt`，最多等待至 `deadlineAt`（到期立刻 `abort` 后端检索并落 `timeout` 终态）；若认领时 `deadlineAt` 已过或宿主已记录 `{ status: 'timeout' }` 终态（保留直至认领或 TTL 如 60s 清理），**0ms 直接消费 `timeout`，绝不回退发起第二次检索**；
   - **第三步（仅真正无预取时回退）**：仅当已校验输入确实**未发起过预取**（如排队恢复后改绑 session、多来源重放或独立 DSH）时，回退到 [adapter.ts](../plugins/memory/lib/adapter.ts) 的短预算现场检索（沿用同一套 5 态协议）。
4. **未认领命中的变更失效校验（写入 + 认领双点核对，零额外 I/O）**：每次预取在发起与回包时均绑定其对应的 `{ ownerEpoch, revision }`。当宿主收到 `memory_owner_change`（文件编辑、停用、启用、删除、Dream 提交等）推进 `revision` 或收到 `unavailable` 时，不仅作废缓存中已有的陈旧 `hit`，**对当时仍在 `pending`、随后才回包的旧查询同样生效**：
   - **回包写入缓存时**与**`pre-step` 认领时**均核对 `result.ownerEpoch === currentEpoch && result.revision === currentRevision`；一旦不匹配即标为陈旧失效，绝不作为有效 `hit` 写入或采用；
   - 若在 `pre-step` 认领时已失效且原 `deadlineAt` 仍有余量，允许在剩余原预算内执行一次重查（重查回包与认领同样过上述双点核对）；若再次失效或已无余量，直接按 `timeout` 放行，确保已停用/删除的内容绝不首次进入模型请求，也不给前台追加额外等待。
5. **检索内部快慢分离**：在 [memory-file-retrieval.ts](../src/memory/core/memory-file-retrieval.ts) 中给自动检索的 ONNX 向量推理设定更紧的独立上限（如 `50~60ms`；冷启动未就绪时直接跳过向量并在后台预热），保证词法命中能在绝大多数请求中稳定赶上首轮。

### 2.4 自动检索结果协议（调用方与模型显式感知）

将自动检索返回值从 `string | null` 改为明确的结构化结果 `AutomaticRecallResult`：

```ts
export type AutomaticRecallResult =
  | { status: 'hit', text: string, partial: boolean, hits: Array<{ text: string, names: string[] }> }
  | { status: 'empty' }
  | { status: 'skipped' }
  | { status: 'timeout' }
  | { status: 'unavailable' }
```

- **零命中完整性规则**：仅当词法与向量（若启用）及文件核验均完整结束且 0 命中时才返回 `empty`；若词法 0 命中但因向量超时、嵌入降级或文件核验超时导致搜索不完整（底层 `partial: true`），**统一映射为 `timeout`**，确保调用方和模型能区分“完整搜索无结果”与“搜索未完成”；无合格查询文本（纯草稿/纯图片）或命中 `looksSecret(question)` 的输入记为 `skipped`，不计入搜索零命中或命中率分母。

| 状态 | 代码层 / 诊断处理 | 注入给模型的本轮消息（L3） | 预期模型行为 |
|---|---|---|---|
| `hit` | 记录命中数、耗时、`partial` 标记；消息实际提交进会话时上报一次 `memory_context` | 追加 `<memory-recall turn="N" ref="<id>">` 命中片段；若 `partial === true` 附一句「自动检索仅完成部分搜索」 | 直接使用；不确定时补调 `memory_recall` |
| `empty` | 记录完整搜索零命中与耗时 | **不追加任何消息**（零噪声） | 正常回答，不空查 |
| `skipped` | 记录未执行查询（纯草稿/纯图片/命中 `looksSecret`），与 `empty` 分开统计 | **不追加任何消息**（零噪声） | 正常回答 |
| `timeout` | 统计超时率、记录放行日志 | 追加 `<memory-recall turn="N" ref="<id>">`：「本轮自动记忆检索未完整完成或超时；若任务依赖历史约定，请调用 `memory_recall`。」 | 无关问题直接答；涉及收件人/习惯等**主动调 `memory_recall`**（走工具宽预算） |
| `unavailable` | 记录离线状态 | 追加 `<memory-recall turn="N" ref="<id>">`：「记忆服务当前不可用。」 | **不白调必败的 `memory_recall`**；缺关键信息直接问用户确认 |

### 2.5 上下文注入、跨轮策略与事件上报不变量

- **L3 与 L2 物理隔离**：L2 独占 `systemPrompt.context('viva-profile')`；L3 不进入 `systemPrompt.context`，而是通过 `agent/pre-step` 的 `decision.messages` 追加 `source: { kind: 'viva-memory' }` 消息，彻底避免 L3 变化触发 DSH `RuntimeContextProjection` 重复发送完整画像或追加清空提醒。
- **跨轮保留旧节点以保 KV Cache（方案 A）**：L3 消息带 `<memory-recall turn="N" ref="<requestId|messageId>">` 锚定并声明“仅作对应消息的自动检索参考，不代表后续轮次最新状态”。进入下一轮时**不改写也不删除上一轮的 `viva-memory` 节点**，完整保留跨轮 Prompt Cache 前缀；下一轮若为 `empty` 或 `skipped` 则不追加任何消息。
- **冻结边界始于“已采纳的快照”，同一步多条插话并行共用截止时间**：
  - 未被 `pre-step` 采纳的预取缓存服从 §2.3 第 4 项的变更失效规则；
  - 一旦本轮 Step 1 采纳 L3 快照，普通工具续步（`humanMessages(decision.messages).length === 0`）**严格冻结**，沿用 Step 1 的 L3，不重查、不删除；
  - 同轮用户插话（`agent:steer`，`humanMessages(decision.messages).length > 0`）：允许针对新插话走按需检索并追加新的 `viva-memory` 消息，不影响 L2 画像与前序步骤；
  - 若同一步从 inbox 一次认领多条插话（如 `[A, B]`），所有条目**并行**认领/检索并**共用同一个整步绝对截止时间**（不叠加预算），每条 L3 按对应 `requestId` / `messageId` 标明归属并按原顺序 `[A, B]` 确定性追加（即使 B 先返回也不乱序串证据）。
- **已注入事件（`memory_context`）延后至消息提交确认**：
  - 取消 worker 端 `fileContext()` 命中即发 `injected`，也不在 `agent/pre-step` 返回前提前上报（此时 DSH 尚未执行 `prepareRequest` 和二次取消检查）；
  - `agent/pre-step` 构造 L3 `UserMessage` 时仅按其唯一 `message.id` 暂存待确认命中；
  - 在 `session/event` 观察到该 `user/message`（`source.kind === 'viva-memory'`）**实际提交进会话**（严格位于 `prepareRequest` 与取消检查之后、紧接 `buildRequest`）时，按 `message.id` 认领并删除暂存项（精确一次去重）后上报 `memory_context`；`turn/end` 与 `session/disposed` 时清理未提交的残留项。注意：该回执表示“记忆已写入会话”，而首轮携带证据的比例仍以**实际发出的首个模型请求**为统计口径。

### 2.6 涉及模块与验收清单

- **涉及文件：** [memory-context.ts](../src/memory/core/memory-context.ts)、[memory-runtime.ts](../src/memory/core/memory-runtime.ts)、[memory-file-retrieval.ts](../src/memory/core/memory-file-retrieval.ts)、[acp-bridge.ts](../src/backend/acp-bridge.ts)、[compose.ts](../src/backend/compose.ts)、[feed-continuation.ts](../src/backend/feed-continuation.ts)、[adapter.ts](../plugins/memory/lib/adapter.ts)，以及 `main` 分支的 `src/memory/node/owner-worker.ts`、`src/backend/desktop-memory-owner.ts`、`src/memory/contracts/memory-daily-defaults.ts`。
- **必补单测与实测验收：**
  1. 真实 DSH 连跑首轮 `hit` → 工具续步 → 下一轮 `empty`：续步沿用命中，下一轮无重复画像、无清空提醒、无旧节点改写；
  2. 旧 session 预取结果晚于重绑到达时新 session 不消费；多来源重放可正确关联或回退；
  3. Feed 续聊与凭据跳过验收：① 同时覆盖纯草稿与“草稿 + 用户补充”，检查实际送入检索器的查询文本，纯草稿排队至宿主缓存条目实际被 TTL 清除后再认领，仍记为 `skipped`、检索调用为零、实际请求无 L3 提示，“草稿 + 补充”仅用补充部分检索；② 使用现有合成凭据样本分别验证宿主预取与独立 DSH 回退路径，断言命中 `looksSecret` 时两条路径均返回 `skipped`、不调用检索器、不追加 L3 且不计入 `empty` 零命中；
  4. 定时与后台任务验收（升级 `test/memory-handoff.test.ts` 原有仅查 `【记忆规则】` 的断言）：① 延迟 `sourceAlias`，预先写入一条**仅存在于记忆文件中的唯一文本**，在该定时任务的**首个模型请求、任何 `tool_result` 出现前**断言 L3 含该唯一文本；② 向同一 task session 连续投递两条**完全相同的文本**，验证分别以不同 `requestId` 认领各自预取、且总共只执行两次检索（无按文本误匹配、无额外回退），记忆摄取仍保留无头原文；③ 另覆普通工具续步冻结，以及同一步认领 A/B 两条插话反序返回时的归属、顺序与单次预算上限；
  5. 晚认领拆分为两例：① 预算内按时完成（如 40ms 命中）、超过截止时间（如 200ms）后认领 → 直接消费 `hit`；② 截止时间到期仍未完成 → 直接消费 `timeout`；两例均 0ms 不额外等待、不触发第二次检索；
  6. 预取命中后失效验收（覆盖正序与反序两例）：① 正序“预取命中 → 停用文件获确认（`R+1`）→ `pre-step` 认领”；② 反序“旧查询挂起（基于 `R`）→ 停用文件获确认（`R+1`）→ 放行旧回包 → `pre-step` 认领”；两例均断言首个模型请求不含已停用片段、界面无该条注入记录、对话在原预算内继续（一次重查若再次失效同样在原预算内放行）；
  7. 仅向量可命中的样本在向量超时时返回 `timeout`（而非 `empty`），模型收到未完成提示；
  8. L2 缓存与重连验收：① 仅重启 DSH（worker 不发新事件）首个请求仍带缓存 L2 画像；宿主冷启动且 worker 尚未 ready 时放行首轮；② 验证 `text: ''` 是带版本的有效更新：先推 `R` 非空正文，再推 `R+1` 空正文，随后让迟到的 `R` 快照或延迟 `attach` 响应抵达，断言宿主和适配器均保留 `R+1` 并在重连后继续重放空正文（仅在同一 `ownerEpoch` 内比较 `revision`，切 `ownerEpoch` 以当前连接为准；L2 正文与今日日期分开断言）；
  9. `pre-step` 成功返回后令 `prepareRequest` 失败或取消，界面零条 `memory_context` 记录；正常提交并连续执行工具仅上报一次；
  10. 性能双指标验收（分冷、热 worker，用同一批必命中样本对比调整前后，**以实际发出的首个模型请求为口径**）：① 首个模型请求因等待记忆增加的 P95 延迟；② 首个模型请求实际带上证据的比例；
  11. 验证命令：`npm run typecheck`、`npm test`、`npm run check:i18n` 及 `memory-plugin` / `memory-handoff` / `memory-document-runtime` 回归。

### 2.7 阶段一首轮审查处理记录

2026-11-24 对照 `origin/main@d4f9aa2`（含 #176）及 DSH `0.2.2-rc.2` 走查，首轮 6 项审查意见已合入 §2.2–§2.6：

| 优先级 | 审查项 | 处理方式 |
|---|---|---|
| P1 | **L3 的注入位置与跨轮策略** | L3 不走 `systemPrompt.context`，改为 `agent/pre-step` 通过 `decision.messages` 追加带 `<memory-recall turn="N" ref="<id>">` 标记的 `viva-memory` 消息；跨轮采用**方案 A**（不改写/删除旧节点以保留 Prompt Cache，下一轮 `empty`/`skipped` 不追加任何消息）。 |
| P1 | **预取与实际投递的绑定** | 预取起点下沉至 [acp-bridge.ts](../src/backend/acp-bridge.ts) 最终已校验请求构造点，按 `(requestId, sessionId)` 严格绑定核对；未通过校验的 Feed 草稿不触发预取；旧 session 晚到结果丢弃。 |
| P1 | **桌面端其他输入与冻结边界** | 定时/后台任务同样接入宿主已验证预取；改绑/重放/独立 DSH 等无预取输入统一回退 DSH 侧短预算现场检索；普通工具续步严格冻结；同轮 `agent:steer` 新人类插话允许针对新问题追加一次 L3。 |
| P2 | **零命中时的完整性** | 词法 0 命中且因向量/核验超时导致 `partial: true` 时，统一映射为 `timeout`（不再归为 `empty`）。 |
| P2 | **L2 在 adapter 重连时的交付** | 宿主缓存最新 `{ epoch, revision, text }` 并在 DSH `attach` 响应中直接重放；冷启动尚无快照时 L2 暂空、放行首轮。 |
| P2 | **已注入事件的触发时点** | 由消费端 [adapter.ts](../plugins/memory/lib/adapter.ts) 在确认 L3 提交时按消息 ID 去重上报一次 `memory_context`（具体时点见 §2.8）。 |

### 2.8 二轮复核处理记录

二轮复核指出的 4 项实施边界已合入 §2.2–§2.6：

| 优先级 | 复核项 | 处理方式 |
|---|---|---|
| P1 | **已注入回执早于请求提交** | `agent/pre-step` 仅按 `message.id` 暂存待确认命中；在 `session/event` 观察到对应 `viva-memory` `user/message` 实际提交（严格位于 `prepareRequest` 与取消检查之后）时认领删除并上报一次 `memory_context`；`turn/end` / `session/disposed` 清理未提交项。 |
| P1 | **校验通过的 Feed 续聊含派生正文** | Feed 校验显式提取用户补充文本通过 `sourceText` 下传（纯草稿显式传 `''`）。仅 `sourceText` 非空时发起预取；纯草稿跳过预取并记录 `{ status: 'skipped' }` 终态，防止 DSH 回退检索草稿正文。 |
| P2 | **同一步认领多条插话** | 同一步内多条 `humanMessages` `[A, B]` 并行认领/检索、共用同一整步绝对截止时间（不叠加预算），L3 标注 `ref="<requestId\|messageId>"` 并按原顺序确定性追加。 |
| P2 | **回退区分无预取与预取已超时** | 宿主保留可认领的终态记录（直至认领或 TTL 清理）并随投递传递原 `deadlineAt`；到期未完成的预取到达 `pre-step` 直接 0ms 消费 `timeout`，不触发第二次检索或等待（与按时完成终态的优先级见 §2.9）。 |

### 2.9 三轮再评审处理记录

三轮再评审指出的 3 项边界已合入 §2.3–§2.6：

| 优先级 | 再评审项 | 处理方式 |
|---|---|---|
| P1 | **已完成结果与截止时间的优先级** | 认领时先检查是否已有预算内完成且仍有效的终态（`hit` / `empty` / `skipped` / `unavailable`），有则 0ms 直接消费；仅截止前未完成的查询才转为 `timeout`。纯草稿/纯图片拆出 `skipped` 终态，晚认领保持静默并与完整搜索零命中分开统计。 |
| P1 | **待认领命中在记忆变更后的有效性** | 未认领预取 `hit` 记录 `{ ownerEpoch, revision }`，宿主收到 `memory_owner_change` 或 `unavailable` 时即刻作废陈旧未认领 `hit`；认领时若已失效，在剩余原预算内重查或直接 `timeout` 放行。跨步冻结仅从已采纳的快照开始。 |
| P2 | **定时任务可信查询与首轮断言** | 将 [acp-bridge.ts](../src/backend/acp-bridge.ts) 的任务入口 `preparePrompt` 纳入宿主已验证预取，摆脱对异步 `sourceAlias` 的依赖；升级 `test/memory-handoff.test.ts` 断言，延迟 `sourceAlias` 并断言定时任务首个模型请求（工具结果之前）L3 含仅存于记忆文件的唯一文本；首轮命中率按实际发出的首个模型请求统计。 |

### 2.10 四轮复核处理记录

四轮复核指出的 2 项边界与 1 处文案校对已合入正文：

| 优先级 | 复核项 | 处理方式 |
|---|---|---|
| P1 | **文件变更早于旧查询回包** | 在**回包写入缓存时**与 **`pre-step` 认领时**均核对预取绑定的 `{ ownerEpoch, revision }` 与宿主最新状态，防止 `pending` 中的旧查询晚回逃逸失效校验；一次重查同样执行双点核对，再次失效按原预算放行；§2.6 第 6 项补入反序验收用例。 |
| P2 | **任务投递携带认领标识与原文保真** | `preparePrompt` / `steerTask` 采用独立于 `viva-routing` 的轻量任务关联头（复用零宽字符转义与 `spans` 计算），通过 `wireSpans` 向 `recordSource` 保留无头原文，并按 `(requestId, sessionId)` 精确认领；§2.6 第 4 项补入同文本连续两次投递仅触发两次检索的用例。 |
| 文案 | **统一“5 态”表述** | 将 §1 表格、§2 标题、§2.3 与 §6 PR 1 摘要统一更新为“5 态”，与 §2.4 公开联合类型保持一致。 |

**复审结论。** 上述两项已有对应的协议和验收用例，阶段一可以进入实现。另有一项 P2 回归需要纳入 PR 1：基线的 `memory-runtime.ts` 会在自动检索前用 `looksSecret(question)` 跳过含凭据的非空输入。建议宿主预取和独立 DSH 回退共用此判断，映射为 `skipped`。以现有合成凭据样本验收，断言两条路径均不调用检索器、不追加 L3，也不计入完整搜索零命中。

### 2.11 配合自动画像切换的复核

阶段一可以进入实现。§2.3 和 §2.6 已覆盖宿主与独立 DSH 的凭据跳过。L2 改传纯文本后，建议在 PR 1 增加一项 P2 缓存验收：`text: ''` 是带版本的有效更新。先推送版本 R 的非空正文，再推送 R+1 的空正文，然后让旧快照或迟到的 attach 响应抵达。宿主和适配器均须保留 R+1，重连后继续重放空正文。切换 owner epoch 时以当前连接为准，仅在同一 epoch 内比较 revision。断言当前 L2 贡献，日期单独检查。

**本轮复核。** §2.6 第 8 项已覆盖空画像乱序到达及重连重放，阶段一可进入实现。还有一项 P2 应落在 §2.3 的排队测试里。让纯 Feed 草稿的 `skipped` 记录先达到 TTL，再认领同一投递。仅随消息保留原 `deadlineAt` 无法区分已跳过和已超时，草稿可能收到错误的超时提示。应让跳过标记随投递保留至消费，或在认领时能从可信元数据还原。验收时断言仍为 `skipped`、检索次数为零、模型请求无 L3 提示。

本次复核已将缓存淘汰后的认领场景补入 §2.6 第 3 项。阶段一可以进入实现。

---

## 3. 阶段二：关闭手工画像并一步切换到自动常驻画像

### 3.1 背景与策略

现有 L2 画像依赖用户在新手引导（`saveIntro`）或「关于你」页面手工填写 `role` / `projects` / `preferences` 三个文本框。对用户而言从零填表门槛高且很快过时，同时在产品与存储上割裂出「手工 `profile` 表」与「Dream 整理的 `digest` 文件」两套并行心智。

目前没有存量用户，阶段一和阶段二均以全新安装为验收起点，无需兼容旧数据库、旧 IPC 或旧版待重放操作。阶段一的 L2 快照 `{ epoch, revision, text }` 已独立于画像字段，阶段二可在一个 PR 内切换画像来源，同时移除手工画像的表、IPC 和界面。

### 3.2 一步切换范围

1. **记忆侧（替换 L2 数据源，L2 传输协议与 DSH 适配器零改动）**
   - **唯一全局常驻画像身份、来源隔离与 L3 排除**：常驻画像固定锁定为唯一身份 **`(USER_WORKSPACE, 'digest/personal/profile.md')`**，其中 `USER_WORKSPACE = memoryHash(JSON.stringify([{ kind: 'user' }, { kind: 'user' }, null]))`。严格控制 L2 预算上限（统一常量如 `MAX_PROFILE_L2_CHARS = 800`，按 `[...text].length` Unicode 码点计数），仅沉淀跨任务通用的角色背景、长期偏好与沟通/输出风格；具体项目细节与阶段性约定仍留给 L3 按需召回。
     - **独立轻量画像规划步、统一 `pendingBatch` 检查点与提交双重硬隔离**：
       - **常规 Dream `consolidate`（大小写不敏感只读画像目标、过滤后重算 `hasMore` 与超窗汇入）**：定义跨平台统一的保留路径判别函数 **`isReservedProfilePath(path) => path.toLowerCase() === 'digest/personal/profile.md'`**（规范写入路径固定为全小写 `'digest/personal/profile.md'`）。在系统提示中明确声明该保留路径不可 `CREATE` / `REFINE`，并按 `isReservedProfilePath` 从常规 `consolidate` 的 `existingDigests` 目录与 `node_search` 候选目标中排除；在计划校验阶段、**持久化 `pendingBatch` 之前**，剔除所有命中 `isReservedProfilePath(op.path)`（含 `digest/personal/Profile.md` 等任意大小写变体）的操作及同计划中依赖被剔除草案的后续操作，保留其余合法无关普通文件操作正常落盘，并在过滤完成后按剩余合法操作重算 **`effectiveHasMore = plan.hasMore && retainedOperations.length > 0`**（过滤后剩 0 条操作时沿用基线空计划语义将 `effectiveHasMore` 归 `false`，继续执行合格画像步并推进检查点；仍有合法普通操作且模型声明 `hasMore: true` 时保持 `true` 继续分批整理）。提交守卫同步按 `isReservedProfilePath` 兜底，拒绝常规 `consolidate`、任何非 `USER_WORKSPACE` 以及任何非规范大小写变体（如 `Profile.md`）写入，防止大小写不敏感卷上被普通摘要占坑。若单篇日记在常规 `consolidate` 触发 `context-window-exceeded`（且 `inputsCurrent()` 仍有效），仍照常记录 `oversizedAny = true` 与 `oversized` 诊断（保留 `size-limit` 结果），但**不提前 `notes.markProcessed` 返回**，而是按 `operations: []`、`checkpointRefs = fileRefs` 汇入后续独立画像步与统一检查点流程（若独立画像步自身也罕见单篇超窗，记录超窗诊断后推进检查点避免死循环）。其余整批日记输入与 `read` 工具保持不变——确保普通 `digest/*` 仍照常使用全部合格素材（包括画像删除前的旧素材）；
       - **独立画像规划步**：仅在处理 `USER_WORKSPACE` 批次、本次存在待推进检查点的 `checkpointRefs`（当 `effectiveHasMore === true` 导致 `checkpointPaths` 为空时等下一轮）、常驻画像未处于停用状态、且 `checkpointRefs` 内存在合格纯用户级规范来源（`scope.kind === 'user' && context.kind === 'user' && project === null`，排除 `context.kind === 'task'` 的任务来源与 `project !== null` 的独立 DSH 项目来源）时触发（否则 0 次模型调用并直接以 `noop` 结束画像步）。该步骤**不传入**可能混有旧内容的整篇日记 Markdown，**不传入** `existingDigests` 目录，且**不暴露 `node_search` / `read` 跨文档工具**；模型输入仅包含过滤后的合格 `canonicalSources`（存在 `profile_deleted_at` 时全部满足 `at > profile_deleted_at`，问答条目仅当问题正文及全部 `questionContext` 依赖同样满足 `at > profile_deleted_at` 时才透出 `question`，否则置 `question: null, questionUnavailable: true`）以及当前活跃的 `digest/personal/profile.md` 正文（若已存在），允许输出 0 条操作（显式 `noop`，“无需更新”）或 1 条针对规范小写路径 `'digest/personal/profile.md'` 的操作（`CREATE` / `REFINE`）。提交时由程序按选中 `sourceIds` 自动挂接对应 `dailyPaths` 溯源，提交守卫拒绝任何非 `USER_WORKSPACE` 或非规范大小写变体写入该保留路径；L2 推送器**只读取这一唯一身份**，确保全局最多一份置顶画像且不跨会话泄漏局部约定；
       - **统一 `pendingBatch`、DB 权威判别、`deferredCheckpoints` 非阻塞恢复与手动完成解耦**：常规 `consolidate` 产出的 `digestOps` 与独立画像步产出的 `0~1` 条 `profileOp` 在**两步均规划完成后**合并写入**同一份 `pendingBatch`**（若本批单篇常规 `consolidate` 触发了 `context-window-exceeded`，在 `PersistedBatch` 中同步持久化可选布尔字段 `oversized: true` 并在恢复时还原 `oversizedAny = true`），统一经 `commitBatchOperations` 提交。`job.payload` 同时维护“尚未全部提交的 `pendingBatch`”与“全部操作已有回执、仅待磁盘核验检查点的 `deferredCheckpoints`（条目含 `{ workspace, fileRef, operationIds, oversized? }`）”，通过统一 `saveJobState({ pendingBatch, deferredCheckpoints })` 读写，所有 `effects.queue`（含 `MANUAL_FOLLOWUP` 与 `schedule()`）均保留现有 `deferredCheckpoints`，互不覆盖。
         - **逐操作核验统一用 `observedRevision(workspace, path)` 区分缺失与改写（保留部分提交计划）**：在正常提交和重启恢复的 `verifyOp`（及 `mutate` 异常分类）中，当 `currentReady === false` 且非 `cancelled` / `wait` 时，先核对 SQLite 权威状态（`fileRefs` 在 `memory_daily_notes` / `memory_deleted_daily_notes` 是否仍为同一启用、未删除的 `(workspace, path, revision, file_revision)`、`op.sources` 是否仍满足 `opSourcesValid(op, true)`、`opReads` 与 `op.path` 的 DB 版本是否未变；若 `op.path` 为常驻画像且存在 `profile_deleted_at`，还须校验全部来源满足 `source.at > profile_deleted_at`），并从同一次 `loadFiles` 批次读取 **`observedRevision(workspace, path)`**（不再仅凭 `readObservation() === null` 判断）：
           - 对已有 DB 登记的源日记 / `opReads` / `REFINE` 目标：若 DB 权威状态均未变，且 `observed === undefined`（`EACCES` / 超时）或 `observed === null`（文件缺失如临时移走），**绝不调用 `clearPendingBatch()`**，保留未完成 `pendingBatch` 及全部原 `operationId` 与 `oversized` 标记并返回 `'retry'`（置 `scanRetry = true`），待文件移回后跳过已有回执的操作、仅按原 `operationId` 补提缺少回执的操作；
           - 若 `typeof observed === 'string' && observed !== expectedRevision`（物理字节可读、但内容哈希已与 DB 登记不同，即**原位改写**），或 `observed === expectedRevision` 但来源/读取策略已失效，或 DB 权威状态已变（删除/停用/新 revision/目标冲突/常驻画像操作触发 `profile_deleted_at` 水位失效），或 `CREATE` 目标在磁盘已意外出现非空物理哈希：均按**已确认失效**处理，立即清除 `pendingBatch` 并返回 `'stale'`（释放 `pendingBatch` 通道，不阻塞后续健康批次）。
         - **检查点落盘与 `deferredCheckpoints` 三类结清（同样以 `observedRevision` 判别）**：正常提交与重启恢复两条路径均**不得在检查点落盘前提前清除待办**；`checkpointFiles` 先异步完成 `loadFiles(..., partial = true)` 校验，再在写入 `notes.markProcessed` 与 `dream.lastProcessedAt` 的**同一个 SQLite 事务内**，结合 SQLite 权威登记状态与同批次 `observedRevision(workspace, path)` 分三类结清：
           - **DB 确认已结清或被取代**（经管理接口删除、停用 `enabled = 0`、已推进 `processed >= checkpoint`，或 DB 的 `(workspace, path, revision, file_revision)` 已变更）：视为已解决并移除该目标；
           - **DB 仍登记为同一启用、未删除、未推进版本，且 `observedRevision` 为 `null`（文件缺失）或 `undefined`（`EACCES` / 超时）**：判定为磁盘暂不可核验，绝不因 `fileCurrent === false` 清除，在同一 SQLite 事务内将目标连同原 `operationIds` 与 `oversized` 标记原子转入/保留在 `deferredCheckpoints` 并置 `deferredRetry = true`；
           - **DB 未变且 `observedRevision` 返回物理哈希字符串**：若 `observed === file.revision` 且来源与读取策略通过（`fileCurrent === true`），在同一事务内推进 `notes.markProcessed`（若 `oversized` 为真同步置 `oversizedAny = true`）并移除该目标；若 `observed !== file.revision`（原位改写）或来源/读取策略已实际失效（`fileCurrent === false`），移除旧目标交由后续正常处理。
         - **非阻塞推进、手动 Dream 完成解耦与带 `operationId` 只读轮询**：当 `pendingBatch` 的全部操作均已拿到回执（`commitOutcome === 'done'`）后，上述同一事务原子清除 `pendingBatch` 并将任何暂不可核验的目标移入 `deferredCheckpoints`（若 `checkpointPaths` 为空如 `hasMore === true`，则仅清除 `pendingBatch`；两步均为 0 条操作时直接推进检查点）。后续每轮 `runJob()` 先重试 `deferredCheckpoints`（仍不可核验的留队并置 `deferredRetry = true`，**不提前中止本轮**），扫描 `notes.changedFiles(from, today)` 时跳过仍在 `deferredCheckpoints` 中的 `(key, revision)`，让独立健康日记正常完成整理与检查点。将重试标记拆为 **`scanRetry`**（本轮扫描/规划/提交自身未完）与 **`deferredRetry`**（仅 `deferredCheckpoints` 待后台重试）：仅 `scanRetry === true` 时提前返回 `'retry'`；当 `scanRetry === false` 时，仅在 `!deferredRetry`、存在待结清的 `MANUAL_JOB` 或本轮确有 `processedAny || oversizedAny` 时，在收尾事务内更新 `dream.lastCheckedAt`、`dream.lastCheckResult` 并结清 `MANUAL_JOB`（写入带 `completedAt` 的可重放完成回执 `receiptKey(jobId)` 并清空 `MANUAL_JOB`；纯空跑的后台 `deferredCheckpoints` 重试不覆写历史 `lastCheckResult`；若触发 `MANUAL_FOLLOWUP` 续跑则保留现有载荷入队新一代且本代直接返回 `'done'`），随后若 `deferredRetry === false` 正常 `finishGeneration` + `schedule()` 返回 `'done'`，若 `deferredRetry === true` 则保留 `deferredCheckpoints` 与原回执并返回 `'retry'` 交由后台退避重试。同时更新只读查询 `status(operationId)`（经 `memory:dream-status` 透传）：带 `operationId` 查询时先经 `store.command(requestKey(operationId))` 解析其发起或加入的 `jobId`，若 `store.meta(receiptKey(jobId))` 已有完成回执则直接只读返回（含同一 `jobId` 与 `completedAt`，不触发新扫描，重启前后一致）；无 `operationId` 查询继续返回全局调度状态。渲染器 [memory-actions.ts](../src/renderer/memory-actions.ts) 将两个状态拆开维护：`pendingDreamRequest` 仅用于启动 RPC 失败的幂等重试（收到启动确认即清空，保证 `retry` 状态下再次点击仍可发起新请求唤醒调度器），`watchingDreamOperation` 在启动确认后保留用于只读 `dreamStatus(watchingDreamOperation)` 轮询，直至收到带 `completedAt` 的完成回执、发起新手动请求或状态变为 `disabled` 时清除。
     - **L3 自动召回排除常驻画像**：在 [memory-runtime.ts](../src/memory/core/memory-runtime.ts) 的 `automaticAllows`（自动召回选取 Top-3 前）直接排除 `(USER_WORKSPACE, 'digest/personal/profile.md')`，避免与已由 L2 注入的常驻画像重复并白白占用 3 个动态召回名额之一；主动工具（`memory_recall` / `memory_read` / `memory_node_search`）与「关于你」界面仍沿用 `fileAllowsOrigin`，可按需读取完整画像与溯源链接。
   - **自动生成 + 两区结构确定性保护（不建新表、不依赖 `traceLineHistory`）**：
     - 用户零填表直接对话，随 Daily Note 与 Dream 自动生成并更新该文件；用户在「关于你」可像普通记忆文件一样编辑、撤销、停用或删除；
     - **文档内两区结构与可执行守卫**：`digest/personal/profile.md` 内部采用极简的两段式 Markdown 结构——置顶的 **`## 用户确认`**（可选，仅用户编辑可改）与 **`## 自动整理`**（Dream 维护）。
       - 用户执行 `editFile` 时，相对 `before` 新增或修改的非空行自动归入/保留在 `## 用户确认` 区（用户在文末直接加偏好同样受保护，无需记语法；若用户删改 `## 用户确认` 内已有行则以新内容为准），**不受最近 20 条修订窗口限制**；
       - **Dream 写入守卫同时覆盖 `CREATE` 与 `REFINE`**：无论首次生成、删除后重建（`CREATE`）还是后续更新（`REFINE`），Dream **只允许提供自动整理区正文**，由程序侧统一组装最终文档并校验保留标题唯一——`CREATE` 时不带 `## 用户确认`，`REFINE` 时程序原样拼回既有 `## 用户确认`；提交守卫直接拒绝任何在模型输出中夹带 `## 用户确认` 或重复保留标题的提案，杜绝自动推断混入最高优先级区；
       - L1 规则与 L2 模板明确声明 **`## 用户确认` 优先级严格高于 `## 自动整理`**（即使 Dream 在 `## 自动整理` 别处写了相反偏好，模型以置顶的 `## 用户确认` 为准；同时独立画像规划步输入附带 `## 用户确认` 约束其不输出冲突偏好）；
       - 沿用现有 `undoFile` 栈顶撤销语义：手改后立即 `undoFile` 回退整篇文档、`## 用户确认` 回到旧状态，保护自然解除（不引入任意历史修订 cherry-pick 撤销）。
   - **删除后的重建与后续更新规则及按路径查询配套修改**：
     - 全新安装下将 `memory_documents` 的路径唯一约束改为部分唯一索引 `UNIQUE(workspace, path) WHERE forgotten = 0`（旧 `forgotten = 1` 记录保留原 `documentId`），并**配套更新所有按 `(workspace, path)` 查活文档的路径**（`rowByPath`、`CREATE` 冲突检查、文件日志校验、活文档列表/注册表枚举统一加 `AND forgotten = 0`；历史墓碑仍只按 `documentId` 查询且保持不可读）；
     - 删除常驻画像时在 `memory_meta` 记录 `profile_deleted_at` 水位。独立画像规划步的受限输入与提交守卫共用一条硬约束：只要存在 `profile_deleted_at`，**模型在画像规划阶段仅能看到 `at > profile_deleted_at` 的合格纯用户级来源与重建后的当前画像（零旧日记正文、零其他 digest、零跨文档工具），且此后每一次向 `digest/personal/profile.md` 执行 `CREATE` 及后续所有 `REFINE` 时，所依据的每一条直接来源及间接引用来源（`sourceIds`、问题上下文等）都必须满足 `source.at > profile_deleted_at`**。仅有删除前证据的旧偏好不会通过规划输入泄漏或后续 `REFINE` 复活，用户在删除后重新明确表达的偏好带有新的 `at > profile_deleted_at` 可正常写入；普通 `digest/*` 走常规 `consolidate`，不受该水位限制仍照常使用同批旧素材。
   - **L2 正文投影、确认区保存前校验与停用/删除推送语义（剥离来源链接、不改写已有会话历史）**：
     - 磁盘文件与「关于你」详情页照常保留完整的 frontmatter 与末尾 `## Sources` / `[[daily/...]]` 溯源链接；
     - 推送给 L2 的 `text` 由共享投影函数仅提取 `## 用户确认` 与 `## 自动整理` 两个画像区的偏好正文（剥离 `## Sources` 链接），按 `MAX_PROFILE_L2_CHARS`（Unicode 码点 `[...text].length`）投影：**优先完整保留 `## 用户确认`**，剩余额度（可为 0）再给 `## 自动整理`，避免来源链接累积挤占画像预算；
     - **确认区超限保存前拦截、桌面 worker RPC 全链路透传与失败重放**：仅针对 `(USER_WORKSPACE, 'digest/personal/profile.md')` 的 `editFile`，在写盘/写库前使用与 L2 投影完全一致的计数规则校验结果中的 `## 用户确认` 投影长度：
       - 若 `<= MAX_PROFILE_L2_CHARS`：正常落盘（磁盘保留完整文件与 `## Sources`），推送最新 L2（完整保留 `## 用户确认` 且总长 `<= MAX_PROFILE_L2_CHARS`）；
       - 若 `> MAX_PROFILE_L2_CHARS`：**直接拒绝保存**，不改动磁盘与已推送 L2。在 `domain-error.ts` 新增错误码 `'profile.confirmed_too_long'` 与共享校验 schema `memoryDomainErrorDetails = z.strictObject({ limit: z.number().int().positive(), actual: z.number().int().nonnegative() })`，并为 `MemoryDomainError` 与 `memoryHostFailure` 增加可选 `details`；`owner.ts` 将 `{ code, details }` 一并持久化进 `owner_operations` 的 `failed` 载荷并在同 `operationId` 重放时原样还原；端到端桌面 worker RPC 链路同步透传并校验 `details`——包括 `owner-rpc.ts`（`Failure` 错误帧与 `ownerRpcFrame` 校验）、`owner-rpc-peer.ts`（两端编码与异常还原）、`remote-memory-channel.ts`（`channelError` 还原）、`file-management.ts`（`memoryFileWriteResult`）与 `memory-ipc.ts`（`fileWrite()` 统一返回 `{ status: 'rejected', code, details? }`）；前端保留草稿可编辑并展示带当前字数与上限的可操作提示（提示精简确认区或将项目细节记入普通记忆）。普通记忆文件继续沿用 `MAX_MESSAGE_CHARS = 20_000` 不变。
     - memory worker 在 `ready` 以及该文件变更（Dream 提交、用户编辑、停用/启用、删除）时推送最新 `{ epoch, revision, text }`（停用或删除推送 `text: ''`）。新会话首请求完全无画像正文；已有会话下一次新轮次收到清空后的 L2 覆盖提示、后续步骤不再重复注入旧正文，不回溯改写已有会话历史中早先发出的消息。
2. **前端、IPC 与存储清理（同一 PR 一次性退场）**
   - **关闭新手手工填表引导**：移除首次启动的三栏填写表单（[memory-actions.ts](../src/renderer/memory-actions.ts) 的 `saveIntro` 与填表引导流），打开应用直接进入主对话。
   - **统一「关于你」页面**：移除 [profile-panel.ts](../src/renderer/view/profile-panel.ts) 的 3 个静态手工编辑框和独立的 `fileProfile` 拼装视图，统一展示受管记忆文件（置顶展示常驻画像文件，下方为其余 `digest` / `daily` 列表）。
   - **移除旧契约与旧表**：直接删除 `memory:set-profile`、`saveProfile`、`durableProfileWrite`、`memory.db` 中的 `profile` 表，以及不再使用的手工填表 `onboarding` 状态与对应 i18n 文案。
3. **测试与冒烟同步**
   - 将原依赖 `setProfile(...)` 构造 L2 夹具的单测和冒烟引导填表步骤，直接改为操作受管常驻画像文件（或跳过引导填表）。

### 3.3 验收要点

1. 新用户零填表直接开聊，完成对话并触发 Daily + Dream 后自动生成常驻画像，经阶段一 L2 通道 0ms 进入后续请求；
2. 停用或删除常驻画像后分开验收：① 新会话首个模型请求不含画像正文；② 已有会话的最新 L2 已清空，后续步骤不再再次注入旧正文（不改写历史旧消息）；
3. 作用域隔离验收：同时用个人偏好和仅对任务 A 生效的约定运行 Dream，断言全局只有一份置顶画像 `(USER_WORKSPACE, 'digest/personal/profile.md')`，会话 B 的 L2 仅含个人偏好；
4. 显式纠偏、保留标题守卫与撤销验收：① 用户在文末纯新增偏好 A 并经历多轮无关修订后，Dream 提案修改 A 被拦截，提案保留 A 但在别处新增相反偏好时核对 L2 以置顶 `## 用户确认` 中的 A 为准；② 含 `## 用户确认` 的 Dream `CREATE` 与含重复保留标题的 Dream `REFINE` 均被拒绝，模型输出不能变成用户确认项；③ 手改 A 后立即 `undoFile(A)`，验证保护解除、后续 Dream 可正常更新；④ 手改 A 后让 Dream 写入无关新事实 B，断言 `## 用户确认` 中的 A 原样保留、B 写入 `## 自动整理`；
5. 删除后重建、规划输入隔离、后续 `REFINE` 与重启验收：① 删除常驻画像、重启，在同一天混合“仅存于删除前旧证据的唯一标记 + 删除后新偏好”的批次下运行 Dream，检查独立画像规划步实际送入模型的输入不含该旧标记且不暴露可读其他文档的工具，断言重建画像仅含删除后有依据的偏好，同时同批普通 `digest` 仍能正常使用该旧素材；② 重建后再执行一轮 `REFINE`（含已保存旧偏好的普通 `digest` 与删除后重新表达的新偏好），断言仅有删除前证据的偏好仍被排除且不进入画像规划输入、删除后重新表达的偏好可正常写入；③ 完成删除、重建与再次重启后，核对新 `documentId` 可读、活文档列表仅一项、旧 `documentId` 仍不可读；
6. L2 投影预算、确认区超限全链路 RPC 透传与重放验收：① 构造短画像加多条 `## Sources` 溯源链接，检查实际下发的 L2 `text` 完整保留 `## 用户确认`、不含 `## Sources` 链接且符合 `MAX_PROFILE_L2_CHARS`，同时磁盘文件完整保留来源链接；② 对 `## 用户确认` 分别提交**刚好等于上限**和**超出 1 个字**的 `editFile`：等于上限时保存成功、磁盘保留完整正文与来源链接、L2 含完整确认区且长度 `<= MAX_PROFILE_L2_CHARS`；超出 1 个字时经完整桌面 worker RPC → `remote-memory-channel` → 编辑 IPC 通道用**同一 `operationId`** 连续提交两次相同超限草稿，断言渲染器两次均收到准确且相同的 `{ status: 'rejected', code: 'profile.confirmed_too_long', details: { limit, actual } }`，前端草稿仍可编辑，磁盘正文与已推送 L2 版本均未推进；
7. 双步恢复、部分提交保留与原位改写对照、原子检查点、暂不可核验非阻塞重试与只读手动回执、`size-limit` 跨重启、`noop` 推进及混合计划清洗验收：① 分别在“普通 `digest` 已落盘、画像尚未提交处”、“普通 `digest` 与画像均已有回执、检查点尚未落盘处”以及“同批两篇日记在两笔写入均获回执后、其中一篇检查点读超时一次处”中断/重启 worker（不追加新用户消息）：首例从 `pendingBatch` 恢复补齐画像且普通 `digest` 修订数不增加、随后推进检查点；后两例仅补完（剩余）检查点并结清待办，两篇日记检查点均推进，模型调用数和两份文件的修订数均不再增加；另增两组**部分提交后的磁盘异常对照**（均从普通 `digest` 已提交、画像尚无回执处中断）：（d1）临时移走源日记 → 重启重试一次 → 原样移回恢复，断言两个规划器均未重跑、普通 `digest` 修订数不变、画像按原 `operationId` 仅提交一次、最后推进日记检查点；（d2）原位改写源日记内容 → 重启重试并加入健康日记，断言旧画像操作未执行、旧 `pendingBatch` 退出、后续健康日记能正常整理；② 从普通 `digest` 与常驻画像均已取得回执处开始，补齐磁盘不可核验与手动完成验收：（a）暂时移走日记 Markdown 文件 → 运行一次检查点核验 → 移回同一文件再恢复，断言仅补该 revision 的检查点，模型调用数和两份文件的修订数均不增加；（b）让日记 A 连续读取失败（`EACCES`），期间加入健康日记 B 并**手动触发 Dream**（同时构造一个加入同一手动任务的第二个请求 ID）：断言 B 完成整理与检查点，通过桌面只读 `memory:dream-status` 接口分别用**发起 ID** 和**加入 ID** 查询，重启前后均返回同一 `jobId` 与非空 `completedAt`（查询本身不触发新扫描，且不阻塞后续新手动请求），重启并恢复 A 可读后 A 仍沿用原回执仅补检查点；另以经管理接口删除 A 作对照，确认此时旧目标可直接结清移除；③ 用不含长期偏好的批次运行 Dream，断言画像步以 `noop`（无需更新）结束且批次检查点正常推进；④ 构造常规 `consolidate` 计划过滤与续跑三组验收：（a）返回“修改 `digest/personal/profile.md` + 写无关普通文件”的混合计划，断言画像未被常规步骤修改、无关普通文件仅提交一次（无重试重复修订）、批次正常完成；（b）**大小写变体占坑防护**（在大小写不敏感卷上从空库起步）：让常规规划器同时提出 `digest/personal/Profile.md` 和无关普通摘要，再让独立画像步创建 `digest/personal/profile.md`，断言 `Profile.md` 被剔除未落盘、无关摘要与规范小写 `profile.md` 各提交一次、L2 收到常驻画像；（c）**过滤后重算 `hasMore`**：先让常规规划器仅返回一条保留画像操作且 `hasMore: true`，断言过滤变空后 `effectiveHasMore` 归 `false`、独立画像步正常执行并推进检查点而不循环重调常规规划器；另作对照返回“保留画像操作 + 合法普通操作”且 `hasMore: true`，断言合法普通操作提交一次并保持 `effectiveHasMore === true` 继续分批整理；⑤ 构造单篇日记使常规 `consolidate` 触发 `context-window-exceeded`、而过滤后的纯用户级来源仅剩一条短偏好，在画像写入成功且检查点落盘前重启：断言恢复后画像仍只写入一次（修订数不增加）、检查点推进，且常规整理的 `oversized` 诊断与 `dream.lastCheckResult === 'size-limit'` 跨重启保持；
8. L2 / L3 不重复占位验收：构造同时匹配常驻画像与多条普通 `daily` / `digest` 文件的问题，检查实际发出的模型请求：L2 保有常驻画像，L3 仅返回普通文件（完整保留 3 个动态召回名额、不重复包含 `digest/personal/profile.md`），且主动调用 `memory_read` / `memory_recall` 仍可按需读取完整画像文件；
9. 整个切换过程**无需修改阶段一已实现的 L1 / L2 / L3 协议与 DSH 适配器接口**，并通过 `npm run typecheck`、`npm test`、`npm run check:i18n` 与 `smoke:memory`。

### 3.4 自动常驻画像首轮审查处理记录

针对首轮提出的 3 项 P1 与 1 项 P2，已合入 §3.2–§3.3（纠偏保护与删除细节见 §3.5 深化）：

| 优先级 | 审查项 | 处理方式 |
|---|---|---|
| P1 | **停用或删除对已有会话的保证** | 明确不回溯改写历史消息（与 PR #175 与阶段一快照策略一致）：新会话首请求无画像正文；已有会话推送 `text: ''` 清空最新 L2，后续步骤不再再次注入旧正文。 |
| P1 | **全局画像的唯一身份与可用来源** | 固定锁定为 `(USER_WORKSPACE, 'digest/personal/profile.md')`，仅接受 `USER_WORKSPACE` 纯用户级规范来源；提交守卫拒绝非 `USER_WORKSPACE` 写入该保留路径；L2 只读此唯一文档。 |
| P1 | **显式纠偏的可执行写入规则** | 文档内采用 `## 用户确认` + `## 自动整理` 两区硬隔离（详见 §3.5）。 |
| P2 | **固定路径删除后的 Dream 行为** | 改用部分唯一索引 `UNIQUE(workspace, path) WHERE forgotten = 0` + 活路径查询限定 `forgotten = 0` + 全来源删除水位校验（详见 §3.5）。 |

### 3.5 二轮复核处理记录

二轮复核指出的 3 项 P1 与 1 项 P2 已全部合入 §3.2–§3.3：

| 优先级 | 复核项 | 处理方式 |
|---|---|---|
| P1 | **纯新增偏好行漏保护与别处新增冲突偏好** | 放弃 `traceLineHistory`，改用 `digest/personal/profile.md` 内固定的 `## 用户确认`（置顶、Dream 只读）+ `## 自动整理`（Dream 可写）两区结构；`editFile` 将新增/改写行归入 `## 用户确认`，不受 20 条修订上限影响；L1/L2 声明 `## 用户确认` 优先级高于 `## 自动整理`。 |
| P2 | **撤销验收与现有 `undoFile` 接口对齐** | 沿用现有 `undoFile` 栈顶撤销语义，不造按历史修订单独撤销；§3.3 第 4 项拆为“手改 A 后立即撤销解除保护”和“Dream 写 B 后 A 仍受保护”两例。 |
| P1 | **新旧素材混合批次复活已删除内容** | 规划与提交守卫共同要求 `digest/personal/profile.md` 重建所依据的**全部**直接与间接来源均满足 `source.at > profile_deleted_at`；普通 `digest` 不受此水位限制。 |
| P1 | **部分唯一索引配套按路径查询修改** | 所有按 `(workspace, path)` 查活文档的 SQL（`rowByPath`、`CREATE` 冲突检查、日志校验、活列表枚举）统一加 `AND forgotten = 0`，旧墓碑仅按 `documentId` 处理；§3.3 第 5 项补齐删除→重建→重启闭环验收。 |

### 3.6 三轮复核处理记录

三轮复核指出的 2 项 P1 与 1 项 P2 已全部合入 §3.2–§3.3：

| 优先级 | 复核项 | 处理方式 |
|---|---|---|
| P1 | **首次生成与重建时校验「用户确认」来源** | Dream 的两区守卫同时覆盖 `CREATE` 与 `REFINE`：Dream 仅提供自动整理区正文，由程序统一组装并校验保留标题唯一，拒绝含 `## 用户确认` 的 `CREATE` 与含重复保留标题的 `REFINE`。 |
| P1 | **删除水位覆盖重建后的后续 `REFINE`** | 只要存在 `profile_deleted_at`，此后每一次向 `digest/personal/profile.md` 执行 `CREATE` 或后续 `REFINE` 均校验全部直接与间接来源满足 `source.at > profile_deleted_at`；§3.3 第 5 项补入重建后 `REFINE` 验收。 |
| P2 | **区分文件溯源记录与实际下发的 L2 正文** | 磁盘文件保留完整的 frontmatter 与 `## Sources` 链接；L2 `text` 仅投影两个画像区正文并按字数上限优先完整保留 `## 用户确认`；§3.3 第 6 项补入投影验收。 |

### 3.7 四轮复核处理记录

四轮复核指出的 1 项 P1 与 2 项 P2 已全部合入 §3.2–§3.3：

| 优先级 | 复核项 | 处理方式 |
|---|---|---|
| P1 | **删除水位约束画像规划实际可见文本** | 常驻画像拆为独立轻量规划步（常规 `consolidate` 禁止写画像、普通 `digest` 照常使用旧素材）；画像步仅接收过滤后的纯用户级 `canonicalSources`（全部 `at > profile_deleted_at`，问答上下文同样受限）与当前活跃画像，不传混合日记正文或 `existingDigests`、不暴露 `node_search`/`read` 工具；§3.3 第 5 项补入旧标记模型输入与工具隔离验收。 |
| P2 | **确认区单独超过 L2 上限时的保存行为** | 定义统一预算常量（`MAX_PROFILE_L2_CHARS = 800`，按 Unicode 码点 `[...text].length`）与共享投影/计数函数；对画像文件的 `editFile` 在写盘前校验 `## 用户确认` 长度，超限时直接拒绝并返回带 `{ limit, actual }` 的可操作错误、保持磁盘与 L2 不变；§3.3 第 6 项补入 `== 上限` 与 `== 上限 + 1` 边界验收。 |
| P2 | **常驻画像在 L3 重复占用召回名额** | 在 [memory-runtime.ts](../src/memory/core/memory-runtime.ts) 的 `automaticAllows` 选片前排除 `(USER_WORKSPACE, 'digest/personal/profile.md')`（主动工具与「关于你」界面仍沿用 `fileAllowsOrigin`）；§3.3 第 7 项补入 L2/L3 不重复占位验收。 |

### 3.8 五轮复核处理记录

五轮复核指出的 1 项 P1 与 2 项 P2 已全部合入 §3.2–§3.3：

| 优先级 | 复核项 | 处理方式 |
|---|---|---|
| P1 | **双规划步的检查点推进与中断恢复约定** | 常规 `consolidate` 与独立画像步共用同一份 `pendingBatch` 与同一 `notes.markProcessed` 检查点：两步规划均完成后合并写入 `pendingBatch` 经 `commitBatchOperations` 提交，整批提交完成后才推进检查点（无长期偏好时画像步以显式 `noop` 结束）；中断重启直接恢复 `pendingBatch`，已落盘普通 `digest` 命中 `documents.receipt(workspace, op.operationId)` 零写入跳过且修订数不增加；§3.3 第 7 项补齐中断恢复与 `noop` 验收。 |
| P2 | **常规 `consolidate` 识别画像只读并处理混合计划** | 在常规 `consolidate` 提示中声明 `digest/personal/profile.md` 为只读保留路径、从其 `existingDigests` 目录与 `node_search` 候选目标中排除，并在持久化 `pendingBatch` 前剔除误选画像操作及依赖该草案的后续操作（提交守卫继续兜底）；§3.3 第 7 项补齐混合计划一次提交验收。 |
| P2 | **确认区超限字数贯通 IPC 与失败重放** | 在 `domain-error.ts` 新增 `'profile.confirmed_too_long'` 与可选 `details?: { limit, actual }`，`owner.ts` 在 `owner_operations` 的 `failed` 载荷持久化 `{ code, details }` 并在同 `operationId` 重放时原样还原，`file-management.ts` 与 `memory-ipc.ts` 拒绝分支统一透传 `{ status: 'rejected', code, details? }`；§3.3 第 6 项补齐真实编辑 IPC 同 ID 双次提交验收。 |

### 3.9 六轮复核处理记录

六轮复核指出的 1 项 P1 与 2 项 P2 已全部合入 §3.2–§3.3：

| 优先级 | 复核项 | 处理方式 |
|---|---|---|
| P1 | **恢复记录覆盖到检查点落盘** | 正常提交与恢复路径均不再在 `checkpointFiles` 之前调用 `clearPendingBatch()`：`checkpointFiles` 先异步完成 `loadFiles` 校验，再在写入 `notes.markProcessed` 与 `dream.lastProcessedAt` 的同一 SQLite 事务内原子执行 `clearPendingBatch()`（仅 `checkpointPaths` 为空时直接清除）；§3.3 第 7 项补齐双回执后、检查点前中断重启 0 模型调用与 0 修订增长验收。 |
| P2 | **单篇日记超窗不绕过画像步** | 常规 `consolidate` 单篇触发 `context-window-exceeded` 时保留 `oversizedAny = true` 与 `oversized` / `size-limit` 诊断，但不再提前 `notes.markProcessed` 返回，改为以 `operations: []`、`checkpointRefs = fileRefs` 汇入独立画像步与统一检查点流程；§3.3 第 7 项补齐单篇超窗仍写入短偏好验收。 |
| P2 | **桌面 worker RPC 全链路透传超限字数** | 在 `domain-error.ts` 定义共享 `memoryDomainErrorDetails` Zod schema，贯通 `owner.ts`（失败持久化与重放）→ `owner-rpc.ts`（`Failure` 帧与 `ownerRpcFrame` 校验）→ `owner-rpc-peer.ts`（编解码）→ `remote-memory-channel.ts`（`channelError`）→ `file-management.ts` / `memory-ipc.ts` 全链路；§3.3 第 6 项升级为走完整桌面 worker RPC 通道的同 ID 双次提交验收。 |

### 3.10 七轮复核处理记录

七轮复核指出的 1 项 P1 与 1 项 P2 已全部合入 §3.2–§3.3：

| 优先级 | 复核项 | 处理方式 |
|---|---|---|
| P1 | **检查点只完成一部分时保留尚未核验的日记** | `checkpointFiles` 在同一 SQLite 事务内仅当全部目标日记均已推进或确认被新版本取代/停用/删除（`unresolved.length === 0`）时才原子清除 `pendingBatch`；遇临时不可读的 `unresolved` 日记时保留 `pendingBatch`（含原 `operationId` 与 `oversized` 标记）并仅将 `checkpointPaths` 收窄为 `unresolved`，随即停批返回 `'retry'` 防止落入 `changedFiles` 重规划或被后续批次覆盖；§3.3 第 7 项补齐两篇日记单篇读超时后重启 0 模型调用与 0 修订增长验收。 |
| P2 | **单篇超窗结果跨重启保留** | 在 `PersistedBatch`（`pendingBatch` 载荷及 `pendingBatchOf` 校验）新增可选字段 `oversized?: boolean`，单篇常规 `consolidate` 超窗汇入画像步时随 `pendingBatch` 持久化并在重启恢复时还原 `oversizedAny = true`；§3.3 第 7 项串联“常规超窗 + 画像落盘 + 检查点前重启”验收，核对 `dream.lastCheckResult === 'size-limit'` 且画像只写入一次。 |

### 3.11 八轮复核处理记录

八轮复核指出的 1 项 P1 已合入 §3.2–§3.3：

| 优先级 | 复核项 | 处理方式 |
|---|---|---|
| P1 | **检查点清理区分 DB 登记状态与磁盘读取结果，且不阻塞独立批次** | 以 SQLite 权威状态（`memory_daily_notes` / `memory_deleted_daily_notes` 的身份、revision、启用与删除状态）确认目标是否已被取代或结清；DB 未变而磁盘返回 `null`（临时移走）或 `undefined`（`EACCES` / 超时）时绝不清除，在 `commitOutcome === 'done'` 后的同一 SQLite 事务内清除 `pendingBatch` 并将暂不可核验目标连同原 `operationIds` 与 `oversized` 标记原子转入 `job.payload.deferredCheckpoints`（与 `pendingBatch` 经统一 `saveJobState` 读写互不覆盖）；每轮先重试 `deferredCheckpoints` 且不提前中止，扫描 `changedFiles` 跳过其中的 `(key, revision)`，使独立健康日记正常推进；§3.3 第 7 项补齐移走再移回、`EACCES` 下健康日记 B 正常推进以及管理接口删除 A 对照三项验收。 |

### 3.12 九轮复核处理记录

九轮复核指出的 1 项 P1 与 1 项 P2 已全部合入 §3.2–§3.3：

| 优先级 | 复核项 | 处理方式 |
|---|---|---|
| P1 | **保留只提交了一部分的计划** | 将“DB 确认失效 vs. 磁盘暂不可核验”的判别统一应用到正常提交与重启恢复的逐操作核验（`verifyOp` 及 `mutate` 异常分类）：DB 权威状态未变而磁盘返回 `null`/`undefined` 时绝不清除 `pendingBatch`，保留全部原 `operationId` 与 `oversized` 标记并返回 `'retry'`，待文件移回后仅按原 `operationId` 补提缺少回执的操作；§3.3 第 7 项补齐普通摘要已提交、临时移走再移回的零重跑验收。 |
| P2 | **手动 Dream 完成回执与延迟检查点重试解耦** | 将重试标记拆为 `scanRetry`（本轮扫描/规划/提交未完）与 `deferredRetry`（仅 `deferredCheckpoints` 后台重试），所有 `effects.queue` 均保留 `deferredCheckpoints`；当 `scanRetry === false` 时正常落盘 `dream.lastCheckedAt`、`dream.lastCheckResult` 与带 `completedAt` 的可重放手动回执并清空 `MANUAL_JOB`，随后在 `deferredRetry === true` 时保留 `deferredCheckpoints` 返回 `'retry'`；§3.3 第 7 项补齐日记 A 不可读时手动触发整理 B 的完成回执与重启恢复验收。 |

### 3.13 十轮复核处理记录

十轮复核指出的 1 项 P1 与 1 项 P2 已全部合入 §3.2–§3.3：

| 优先级 | 复核项 | 处理方式 |
|---|---|---|
| P1 | **用 `observedRevision(workspace, path)` 区分文件缺失与原位改写** | 在逐操作核验（`verifyOp`）与检查点核验（`checkpointFiles`）中均改为读取同批次 `observedRevision(workspace, path)`：DB 登记未变且返回 `null`/`undefined` 时视为暂不可核验并保留计划/延迟检查点；返回与 DB 登记不同的物理哈希字符串（原位改写）时直接按已确认失效退出旧计划/结清目标，释放通道让健康日记继续推进；哈希相同时再核验来源与读取策略；§3.3 第 7 项补齐部分提交后的原位改写对照与移走再移回对照。 |
| P2 | **按 `operationId` 只读轮询返回手动 Dream 完成回执** | 更新 `status(operationId)`（`memory:dream-status`）：带 `operationId` 查询先经 `store.command(requestKey(operationId))` 解析发起或加入的 `jobId`，若 `store.meta(receiptKey(jobId))` 已有完成回执则直接只读返回（含同一 `jobId` 与 `completedAt`，不触发新扫描，重启前后一致），无 ID 查询继续返回全局调度状态；[memory-actions.ts](../src/renderer/memory-actions.ts) 保留待查询 `operationId` 直至收到 `completedAt`；§3.3 第 7 项补齐发起 ID 与加入 ID 在重启前后通过只读状态接口查询的验收。 |

### 3.14 十一轮复核处理记录

十一轮复核指出的 1 项 P1 与 1 项 P2 已全部合入 §3.2–§3.3：

| 优先级 | 复核项 | 处理方式 |
|---|---|---|
| P1 | **跨平台大小写不敏感匹配保留画像路径** | 定义统一判别函数 `isReservedProfilePath(path) => path.toLowerCase() === 'digest/personal/profile.md'`，在常规 `consolidate` 目标排除、持久化前计划过滤（连同依赖操作）及提交守卫中均按大小写不敏感拦截（禁止任何常规整理、非 `USER_WORKSPACE` 或非规范大小写变体落盘），独立画像步固定写入全小写规范路径 `'digest/personal/profile.md'`；§3.3 第 7 项补齐大小写不敏感卷空库起步的 `Profile.md` 占坑防护验收。 |
| P2 | **过滤后空计划重算 `hasMore` 避免跳过画像步** | 在剔除保留路径（含大小写变体）及其依赖后按剩余合法操作重算 `effectiveHasMore = plan.hasMore && retainedOperations.length > 0`：过滤变空时归 `false` 沿用空计划语义执行画像步并推进检查点，仍有合法普通操作且模型声明 `hasMore: true` 时保持 `true` 继续分批整理；§3.3 第 7 项补齐空计划与合法普通操作两组对照验收。 |

**阶段一、二设计评审结论：通过，可按 §6 的 PR 1、PR 2 顺序实施。** 按全新安装验收。上轮两项已在 §3.2 和 §3.3 第 7 项闭合：普通摘要在计划过滤和提交时均避开画像路径的大小写变体；剔除操作后按剩余合法操作重算续跑条件。后续在实现 PR 中按 §2.6 实测首请求的等待开销与证据命中率，按 §3.3 验证首次画像生成、部分提交恢复和检查点推进。

---

## 4. 阶段三（结论更新）：记忆回归 DSH 插件托管，取消独立 LLM 客户端

### 4.1 决策结论与理由

经架构复盘，确认以下两项产品前提均为「否」：
1. 在未配置模型、DSH 崩溃或切模型重启的 1~2 秒空窗期内，不要求「关于你」记忆管理页脱离 DSH 独立可用；
2. 近期没有接入 DSH 以外的 Agent Runtime，也没有关闭 DSH 单独在后台运行记忆整理的计划。

因此，**取消“在 `memory-worker` 内另建独立 LLM 客户端与密钥同步链路”的原阶段三方案**，改为收口整体进程架构，回归 **「Viva 依赖 DSH，记忆作为 DSH 插件（内部自带私有 `memory-worker` 子进程）」**：

- **守住单一 LLM 网关红线**：全系统仅由 DSH（`ctx.llm`）负责模型协议适配、DeepSeek 账号登录态（`llm-deepseek-account`）、代理、重试与凭据管理；避免在 `memory-worker` 内复制第二套传输栈（`@deepseek-ai/dsh-llm-*` 为传递依赖且 `dsh-llm-retry` 强绑定 Cordis 插件体系）和扩大明文 API Key 暴露面。
- **消除双路径维护税**：删除 Viva 侧的 `desktop-memory-owner.ts` 双向中转桥与 `standalone-owner.ts` 中的 `fromViva()` 分支，Viva 桌面端与独立 DSH 插件 100% 收敛为同一套 `standaloneOwner` 实现。
- **保留进程级故障与阻塞隔离**：`viva-memory` 插件内部仍监管独占 SQLite、Markdown 核验、FTS5 与 ONNX 嵌入的私有 `memory-worker` 子进程，防止同步数据库 I/O 与向量推理阻塞 DSH 主线程。
- **复用阶段一、二主体成果**：L1 静态规则、L2 本地画像缓存、L3 `decision.messages` 锚定与 5 态召回协议、向量快慢分离，以及阶段二全部自动常驻画像与 Dream 检查点恢复逻辑均完整保留；仅省去强绑定 Viva 主进程托管的跨进程预取桥接（`memory-prefetch.ts` / `claimPrefetch`），L3 短预算检索直接在 DSH 侧完成。

### 4.2 收口后的架构边界

1. **进程结构（单树状拓扑）**：`Viva 主进程 → DSH 进程 → viva-memory 插件 → 私有 memory-worker 子进程`。Viva 只监管 DSH 一个子进程；Note / Dream 调用 `ctx.llm` 发生在插件与私有 worker 两进程之间，不再经 Viva 主进程三跳中转。
2. **「关于你」管理面 IPC（与 `viva-mcp` / `viva-tasks` 同构）**：
   - Viva 主进程通过既有父子 IPC 通道向 `viva-memory` 插件转发受管文件查询、编辑、撤销、停用、删除及 Dream 触发请求，由插件代理给私有 `memory-worker`；
   - **权限隔离不变**：仅父进程 IPC 通道允许调用 `host` 管理接口，模型工具与第三方插件不可访问；Viva 主进程不直接打开 `memory.db`，维持单 owner 独占锁；
   - **可用性语义**：DSH 未启动、崩溃或热重启期间，记忆通道报告 `unavailable`（界面提示暂不可用/连接中），DSH 就绪后自动恢复；同步调整原 `#161` 中“DSH 离线时管理页仍可用”的对应测试预期。
3. **配额治理与防前台干扰（原地补齐，不迁 LLM）**：
   - **并发硬上限 = 1**：继续沿用 `effects` 单通道串行执行 Note 与 Dream；
   - **429 / 5xx 退避**：在 [model.ts](../plugins/memory/lib/model.ts) 补齐限流/过载错误分类与 `Retry-After` 透传，交由 `effects` 指数退避重试；
   - **前台流式软让路**：在 [adapter.ts](../plugins/memory/lib/adapter.ts) 本地感知前台对话流式状态，前台活跃时将**新发起**的后台 Note / Dream 顺延数秒（设最大推迟上限防饥饿；不中断已在途请求，手动触发 Dream 豁免）；
   - **后台轻模型扩展口**：`MemoryCompute` 协议本身按 `{ provider, model }` 参数化，后续可直接复用 DSH 已配置提供方中的轻量模型。

### 4.3 未来重新评估独立 LLM 通道的触发条件

`src/memory/core/` 的 `MemoryCompute` 抽象端口保持不变。仅当未来明确出现以下诉求之一时，再基于该端口引入独立推理客户端或共享 LLM 网关进程：
1. 需要关闭 DSH 单独运行后台记忆（例如非 DSH 外部数据源持续写入并触发整理）；
2. Viva 计划接入 DSH 以外的多个 Agent Runtime。

---

## 5. 阶段四：素材摄取单一事实源（消除双通道竞态）

### 5.1 现状根因

目前 Viva 桌面端的素材被拆成两条异步通道：DSH 插件扫会话推 `receiveSource`，Viva 后端另发 fire-and-forget 的 `sourceAlias` 与 `acceptQuestionAnswer`。因此仍残留两个边界竞态：
- `acceptQuestionAnswer` 若晚于快速结束的 `completeTurn` 到达，会被 `owner_turns` 拦截丢弃；
- `sourceAlias` 晚到时虽然不再永久写死 `ignored`，但仍需等 `turn/end` 重扫补录。

### 5.2 目标设计

- **Viva 桌面端以持久化回合记录为单一事实源**：Viva 的持久化库（`history.db` 或只追加的规范回合事件表）在落盘时天然带齐干净真人原话、开放题自定义回答、助手最终回复、`conversationId`、`sessionId`、`sourceId` 与轮次号。
- **记忆 worker 按游标异步只读追平**：memory worker 维护自己的游标消费持久化回合流，重启或离线任意时长后自动续读、按 `sourceId` 去重，**彻底消灭 `sourceAlias` 与 `acceptQuestionAnswer` 竞态**。
- **`memory_remember` 对齐**：用户在当轮结束前显式要求“记住”时，由于用户消息已先落盘到持久化存储，`memory_remember` 直接按 `sourceId` 核对已落盘的原话片段即可，不再依赖 `sourceAlias`。
- **DSH 插件进一步瘦身**：Viva 模式下不再需要在 DSH 内运行会话摄取扫描器，DSH 插件只保留工具注册与上下文注入；仅独立 DSH 模式保留 JSONL 游标扫描。

---

## 6. 推荐落地顺序与验收门槛

建议拆分为 **4 个独立小 PR** 渐进交付，每批均可独立验证与回滚：

1. **PR 1（阶段一）**：自动注入三层拆分 + 前置短竞速 + 5 态协议（用户体感最直接，改动面最小，且通过 `{ epoch, revision, text }` 为阶段二搭好与底层格式无关的 L2 通道）。
2. **PR 2（阶段二）**：关闭手工画像并一步切换到 Dream 自动维护的常驻画像（复用 PR 1 的 L2 通道，先闭环产品体验并卸掉旧 `profile` 表、IPC 与填表 UI 负担）。
3. **PR 3（阶段三 · 修订）**：将 `memory-worker` 托管权从 Viva 主进程收回 `viva-memory` DSH 插件（删除 `desktop-memory-owner.ts`、`fromViva()` 与主进程预取桥接，统一为单路径插件），并在插件内原地补齐 429/5xx 退避与前台流式软让路（也可前置为 PR 1 先完成架构减法，再合入阶段一、二主体）。
4. **PR 4（阶段四）**：Viva 素材摄取收口到持久化事件单一事实源（彻底清零双通道竞态并精简 DSH 插件）。

每个 PR 涉及主进程、DSH 插件、IPC 或存储时，合入前均需本地运行 `npm run typecheck`、`npm test`、`npm run check:i18n`，以及 `npm run build` 和 `npm run smoke`（重点覆盖 `smoke:memory`）。

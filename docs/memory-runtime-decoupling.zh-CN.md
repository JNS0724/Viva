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

## 4. 阶段三（收口版）：记忆回归 DSH 插件托管、统一单路径与配额治理

### 4.1 决策结论与架构收口

经架构复盘，确认以下两项产品前提均为「否」：
1. 在未配置模型、DSH 崩溃或切模型重启的 1~2 秒空窗期内，不要求「关于你」记忆管理页脱离 DSH 独立可用；
2. 近期没有接入 DSH 以外的 Agent Runtime，也没有关闭 DSH 单独在后台运行记忆整理的计划。

因此，**取消“在 `memory-worker` 内另建独立 LLM 客户端与密钥同步链路”的原阶段三方案**，将进程托管权收回 **`viva-memory` DSH 插件（内部监管私有 `memory-worker` 子进程）**：

- **单树状进程拓扑**：`Viva 主进程 → DSH 进程 → viva-memory 插件 → 私有 memory-worker 子进程`。Viva 只监管 DSH 一个子进程；Note / Dream 的 `ctx.llm` 计算回调直接发生在插件与私有 worker 两进程之间，不再经 Viva 主进程三跳中转。
- **守住单一 LLM 网关红线**：全系统仅由 DSH（`ctx.llm`）负责模型协议、DeepSeek 账号登录态（`llm-deepseek-account`）、代理、重试与凭据管理，不在 `memory-worker` 内复制第二套传输栈或扩大明文 API Key 暴露面。
- **消除双路径维护税（具体删除清单）**：
  - 删除 `src/backend/desktop-memory-owner.ts`（Viva 侧 supervisor 与双向中转桥）；
  - 删除 `src/backend/memory-prefetch.ts`（强绑定 Viva 主进程托管的跨进程预取协调器）；
  - 删除 `plugins/memory/lib/standalone-owner.ts` 中的 `fromViva()` 分支、`MemoryOwnerConnection` 的 `claimPrefetch` / `refreshPrefetch` / `claimPrefetchBatch` / `reconciled` 方法，使 Viva 桌面端与独立 DSH 插件 100% 收敛为同一套 `standaloneOwner`；
  - 清理 `src/memory/contracts/host.ts` 中的 `memoryOwnerPrefetchCancelled` 与仅用于主进程预取的 `prefetchRecall` 声明，并移除 `src/backend/acp-bridge.ts` 中对 `bindDsh` / `startPrefetch` / `cancelPrefetch` / `finishPrefetch` / `clearSessionPrefetches` 的调用。
- **保留进程级故障与阻塞隔离**：`viva-memory` 插件仍监管独占 SQLite、Markdown 核验、FTS5 与 ONNX 嵌入的私有 `memory-worker` 子进程，防止同步数据库 I/O 或向量推理阻塞 DSH 主线程。
- **复用阶段一、二主体成果**：L1 静态规则、L2 本地画像缓存、L3 `decision.messages` 锚定与 5 态召回协议、向量快慢分离，以及阶段二全部常驻画像与 Dream 检查点恢复逻辑全部保留。

### 4.2 父进程 IPC 管理通道、轻量过渡摄取代理与权限边界

1. **父进程专用管理通道（复用既有 `remote-memory-channel.ts` 精确协议）**：
   - Viva 主进程通过既有父子 IPC 通道发送 `memory_host_request` 帧（扩展 [remote-memory-channel.ts](../src/backend/remote-memory-channel.ts) 的 `send` 分支，使其在首跳同时携带 `protocol: MEMORY_HOST_PROTOCOL`、`requestId`、`epoch`、`method`、`input`，以及可选的 `read: { readBatchId, budgetMs }`、`deadlineAt` 与 `diagnostics`）；
   - **首跳显式取消传播**：当已派发请求的调用方 `AbortSignal` 在预算到期**之前**中止（如用户取消页面读）时，`remote-memory-channel.ts` 立即发送 `{ type: 'memory_host_cancel', protocol: MEMORY_HOST_PROTOCOL, requestId, epoch }`，同时**继续保留 `executions` 读槽位直至收到终态 `memory_host_result` 或子进程退出**；
   - `viva-memory` 插件仅在 `config.host === true` 且 `port.send` 存在时启用该通道：校验 `protocol === MEMORY_HOST_PROTOCOL`、`epoch === owner.epoch` 及 `HostMemoryMethod` 白名单后，为每条在途 `requestId` 绑定本地 `AbortController`（收到 `memory_host_cancel` 时中止该 `signal`），转发至私有 `memory-worker`，并以 **`memory_host_result`** 帧回传终态结果（成功 `{ type: 'memory_host_result', protocol, requestId, epoch, ok: true, result }`；失败 `{ type: 'memory_host_result', protocol, requestId, epoch, ok: false, error }`，使用既有 [domain-error.ts](../src/memory/contracts/domain-error.ts) 的 **`memoryHostFailure`** 保留 `code`、`reason`、`domainCode`、`domainDetails`）；
   - **跨两跳保留执行选项**：扩展 `MemoryOwnerConnection.callHost` 与 [standalone-owner.ts](../plugins/memory/lib/standalone-owner.ts) 透传 `OwnerCallOptions`（`signal`、`budgetMs`、`waitForCompletion`、`deadlineAt`）至 `supervisor.callHost`：
     - 携带 `read` 的页面读请求固定以 `{ signal, budgetMs: read.budgetMs, waitForCompletion: true }` 调用，确保调用方提前取消能中断 worker 计算，但插件仍等待真实终态完成后再回发 `memory_host_result` 释放槽位；
     - 携带 `deadlineAt` 的摄取/限时请求同步下传剩余 `budgetMs`、`deadlineAt` 与 `signal` 至 worker；
   - 插件同时将私有 `memory-worker` 发出的 `memory_owner_state`（含 `profileDeletionGen`）、`memory_owner_change`、`memory_owner_context_used` 事件经父进程 IPC 转发给 Viva 主进程，供 UI 刷新、诊断与 `question-desk` 快照 `questionProfileGen`；
   - **旧 DSH 连接围栏**：Viva 主进程为每个 DSH 子进程绑定单调连接世代（`DshLifetime`）；子进程退出或替换时立即调用 `channel.processExited()` 并丢弃来自旧 DSH 连接的任何迟到 IPC 帧。
2. **轻量过渡期摄取代理（仅衔接 PR 3 → PR 4A，不建一次性过渡表或临时帧）**：
   - 在阶段四移除 `sourceAlias` / `acceptQuestionAnswer` 之前，`hostNamespace: 'viva'` 继续通过父进程 IPC 透传完整 `HostMemoryMethod` 白名单（受管文件 CRUD、Dream、幂等 `getOperation` 以及 `sourceAlias` / `acceptQuestionAnswer`）；
   - [compose.ts](../src/backend/compose.ts) 将 `recovering` 窗口的静默丢弃（`if (memoryOffline()) return`）改为按稳定幂等 `operationId` 维护有界待确认队列（溢出时显式记录诊断），并在 `memory_owner_state` 跃迁为 `ready` 时幂等重放未确认项；`acceptQuestionAnswer` 在向 DSH 投递回答前等待有界确认；
   - [owner.ts](../src/memory/node/owner.ts) 沿用既有 `sourceAlias` 按 `(session, wire_hash)` 匹配逻辑，确保 `origin === 'derived'` 绝不升格为 `'original'`、已取消回合不生成日记；因阶段四紧接着就会彻底删除 `sourceAlias`，**不在阶段三新增一次性表（如 `owner_turn_receipts`）或一次性跨进程帧（如 `memory_query_handoff`）**。
3. **权限边界与显式信任模型**：
   - 仅父进程 IPC 通道允许访问 `callHost`；模型工具仅能调用 `sidecarRequest` 最小白名单（**`remember`、`recall`、`file_read`、`node_search`**，保留既有授权读能力，拒绝一切管理方法）；Viva 主进程不直接打开 `memory.db`，维持 `owner-lock.ts` 单 owner 独占锁；
   - **用户自装 DSH 插件的显式信任假设**：Viva 支持用户通过 [plugins-ipc.ts](../src/backend/plugins-ipc.ts) 安装并启用第三方 DSH 插件。由于 DSH 与全部插件运行在同一 Node.js 进程内，启用第三方插件即等同于授予其与 DSH 同等的进程内信任；`callHost` / `sidecarRequest` 的分界用于约束模型工具面与宿主协议，并非针对恶意同进程插件的操作系统沙箱隔离。
4. **可用性语义**：
   - DSH 未启动、崩溃或切模型热重启期间，Viva 主进程在子进程退出时触发 `channel.processExited()`，记忆通道报告 `unavailable`（UI 提示暂不可用/连接中），DSH 就绪并重新上报 `memory_owner_state (ready)` 后自动恢复；
   - 同步调整原 `#161` 中断言“DSH 离线时管理页仍独立可用”的单测与冒烟用例预期；同时保留“仅 `memory-worker` 崩溃时 DSH 不重启且原地拉起新 worker 并保持独占锁”的恢复保障。

### 4.3 DSH 内单跳 L3 检索与重启/崩溃 L2 缓存重建

1. **DSH 内单跳短预算 L3 检索与 worker 权威版本校验**：
   - 删除 Viva 主进程预取桥后，L3 自动召回统一由 `viva-memory` 插件在 `agent/pre-step` 中对已确定入步的 `decision.messages` 经统一人类消息提取器（阶段三沿用 `humanMessages`，阶段四升级为 `extractHumanMessages`）并发触发：
     - 每条消息共享本步绝对截止时间 `stepDeadlineAt = Date.now() + DAILY_MEMORY_DEFAULTS.automaticContextBudgetMs`（默认 `150ms`），通过插件到私有 `memory-worker` 的**单跳本地 IPC** 调用 `owner.call('automaticRecall', ...)`；
     - 在 `agent/pre-step` 直接发起天然避开了未入步取消/覆盖消息的孤儿预取与取消同步竞态；同时保留阶段一的 `looksSecret` / 空文本跳过、55ms 向量快慢分离与常驻画像槽位排重；
     - **worker 权威版本夹检与单层至多 1 次刷新**：将原待删 `prefetchRecall` 中的数据库版本夹检迁移至存活的 `owner-worker.ts` `automaticRecall` 接口——检索前后分别读取 `startRevision = store.revision()` 与 `endRevision = store.revision()`，返回 `{ epoch, revision: endRevision, stale: result.status === 'hit' && startRevision !== endRevision, result }`；`adapter.ts` 若观察到 `stale === true` 或 `(item.epoch !== owner.epoch || item.revision < (currentRevision ?? 0))`，在剩余 `stepDeadlineAt` 预算内执行**至多 1 次重查**，最终仅采纳 `!item.stale && item.epoch === owner.epoch && item.revision >= (currentRevision ?? 0) && !signal.aborted` 的命中并按原消息顺序注入 `<memory-recall>`；
     - **零幽灵回执边界**：仅在 `session/event: user/message (viva-memory)` 成功追加到会话后上报 `reportContextUsed`（`prepareCall` 失败或取消时绝不上报幽灵回执）。
   - **预算实测与校准**：更新 [benchmark-memory-latency.ts](../scripts/benchmark-memory-latency.ts) 脱离已删 `desktop-memory-owner` 与预取帧拦截，直接基于 `standaloneOwner` 与真实 bypass 基线运行，在阶段三 PR 中对照 `5e96068` 基线记录冷、热启动下首个实际模型请求的额外 P95 延迟与证据命中率。
2. **DSH 重启与仅 worker 崩溃后的 L2 缓存重建（世代安全的三段推送与晚订阅回放）**：
   - `owner-supervisor.ts` 须先收到 `memory_owner_state` 才会建立 `instance.epoch`，`adapter.ts` 也按当前 `owner.epoch` 过滤画像；因此 `owner-worker.ts` 在 `recover()` 完成后按严格三段顺序推送：
     1. 先发 **`memory_owner_state { state: 'recovering', epoch: newEpoch, ... }`**（建立新 `epoch` 并清空旧 `cachedProfile`）；
     2. 再发 **`memory_owner_profile { epoch: newEpoch, revision, text, profileDeletionGen }`**（被 supervisor 与 adapter 匹配接受并缓存）；
     3. 最后发 **`memory_owner_state { state: 'ready', epoch: newEpoch, ... }`**（`ready` 生效瞬间 L2 缓存已就绪，零空窗）；
   - **晚订阅者同序回放**：在 [standalone-owner.ts](../plugins/memory/lib/standalone-owner.ts) 与 [owner-supervisor.ts](../src/memory/node/owner-supervisor.ts) 的 `subscribe(listener)` 中，若订阅时 `snapshot.state === 'ready'` 且存在同 epoch 缓存画像，按相同三段顺序回放，确保晚挂载的 `adapter.ts` 在首个 `ready` 回调内即可同步读到完整 L2 画像；
   - **不可用即失效**：无论 DSH 重启还是仅 `memory-worker` 崩溃（supervisor 上报 `unavailable`），`adapter.ts` 在 `state === 'unavailable'`、`owner.epoch` 变更或 `!owner.ready()` 时立即清空旧 `cachedProfile`（`currentProfileText()` 仅在 `owner.ready() && cachedProfile?.epoch === owner.epoch` 时返回正文，否则返回 `''`）；
   - 插件按 `(epoch, revision)` 单调更新 `cachedProfile`（接受 `text: ''` 作为合法清空），向 `systemPrompt.context('viva-profile')` 提供 0ms 同步读取。

### 4.4 配额治理与调度契约（429/5xx `Retry-After` 与轻量前台软让路）

1. **并发硬上限 = 1**：继续沿用 `memory-worker` 内的单通道 `effects` 队列串行执行 Note 与 Dream。
2. **429 / 5xx 错误分类与 `Retry-After` 全链路透传（不建额外 SQLite 冷却表）**：
   - **边界 1 — 插件分类器（[model.ts](../plugins/memory/lib/model.ts)）**：扩展 `memoryProviderFailure(input)` 同时兼容 DSH 流式终态错误帧（从 **`assembler.finish.failure`** 读取 `LlmFailure`）与抛出异常（`LlmError.failure` 及顶层 `{ code, status, providerRetryAfterMs }`）：
     - `code === 'RATE_LIMIT'` 或 `status === 429` → `new MemoryComputeError('rate-limited', { retryAfterMs })`；
     - `code === 'SERVER'` / `TRANSPORT` / `STREAM_CLOSED` 或 `status >= 500 && status <= 599` → `new MemoryComputeError('provider-overloaded', { retryAfterMs })`；
     - `retryAfterMs` 校验为正整数毫秒并设安全上限（`MAX_RETRY_AFTER_MS = 3_600_000` ms，防异常响应头锁死队列）。
   - **边界 2 — 插件 `compute` 捕获路径（[adapter.ts](../plugins/memory/lib/adapter.ts)）**：将完整捕获异常（含 `LlmError.failure`）传入 `memoryProviderFailure(error)`。
   - **边界 3 — 跨进程契约与 worker 重建（[memory-contract.ts](../src/memory/contracts/memory-contract.ts)、[compute.ts](../src/memory/contracts/compute.ts)、[owner-rpc.ts](../src/memory/contracts/owner-rpc.ts)、[owner-rpc-peer.ts](../src/memory/node/owner-rpc-peer.ts)、[owner-worker.ts](../src/memory/node/owner-worker.ts)）**：
     - `memoryComputeFailure` 增补 `'rate-limited' | 'provider-overloaded' | 'deferred'`；
     - `MemoryComputeError` 新增可选只读字段 `readonly retryAfterMs?: number`；
     - RPC `Failure` 帧透传可选正整数 `retryAfterMs`，`owner-worker.ts` 还原 `new MemoryComputeError(reason, { retryAfterMs })`。
   - **边界 4 — Note 与 Dream 传播（[memory-note-jobs.ts](../src/memory/core/memory-note-jobs.ts) & [memory-dream-jobs.ts](../src/memory/core/memory-dream-jobs.ts)）**：
     - 捕获 `MemoryComputeError`：`reason === 'deferred'` → `{ kind: 'defer', delayMs: error.retryAfterMs ?? 3_000 }`；携带 `retryAfterMs` → `{ kind: 'retry', delayMs: error.retryAfterMs, cooldown: true }`；无 `retryAfterMs` → 普通 `'retry'`（走既有指数退避，首次 `1_000ms`）；
     - `memory-dream-jobs.ts`（覆盖主整理步与独立画像规划步）以结构化重试结果保留最大 `retryAfterMs` 或 `defer`。
   - **边界 5 — `effects` 调度（[ports/effects.ts](../src/memory/core/ports/effects.ts) & [node/effects.ts](../src/memory/node/effects.ts)）**：
     - 扩展 `Outcome` 为 `'done' | 'wait' | 'retry' | { kind: 'retry', delayMs: number, cooldown?: boolean } | { kind: 'defer', delayMs: number }`；
     - 在既有 `effects` 表新增单个整型列 `cooldown_until`（默认 `0`，**不新增独立表，不改 `effects` 查询为 `LEFT JOIN`**）：`{ kind: 'retry', delayMs, cooldown: true }` 在既有行上绑定一次 `:deadline = now() + delayMs`，按单条 SQL 原子更新 `cooldown_until = MAX(cooldown_until, :deadline)`、`due_at = MAX(due_at, cooldown_until, :deadline)` 并递增 `attempts`（显式把 `:deadline` 纳入 `due_at`，避免 SQLite 单条 `UPDATE` 中右侧读到旧 `cooldown_until`）；`effects.queue()` 在 `ON CONFLICT DO UPDATE` 时保留既有 `effects.cooldown_until` 并强制 `due_at = MAX(excluded.due_at, effects.cooldown_until)`，使 429 冷却期间（**含重启后立即触发**）的手动 Dream 或文件编辑绝不擦除未到期的服务商冷却截止时间，而 3s 前台软让路不写 `cooldown_until` 可被手动 Dream 立即覆盖；
     - `{ kind: 'defer', delayMs }` 仅将 `due_at = now() + delayMs` 写入 `effects` 行（不修改 `cooldown_until` 且**不递增 `attempts`**），立即释放当前轮次让无冲突任务继续执行。
3. **轻量前台流式输出软让路（Soft Foreground Yielding）**：
   - **活跃感知（[adapter.ts](../plugins/memory/lib/adapter.ts)）**：通过 `ctx.on('llm/stream', ...)` 拦截前台流式调用（使用 `isAgentLoopRequest(options)` 排除 `memorySource` 自身发起的请求），在流生命周期内维护 `activeForegroundStreams` 计数（`finally` 归还）；
   - **简单内存防饥饿状态机**：`MemoryCompute` 增加可选字段 `manual?: boolean`（`memory-dream-jobs.ts` 仅在存在 `MANUAL_JOB` 时设为 `true`）。当 `activeForegroundStreams > 0 && job.manual !== true` 时：
     - 在插件内存维护简单的让路窗口时间戳 `firstDeferredAt`：未满 `MAX_SOFT_YIELD_MS = 30_000`（30s）时立即抛出 `new MemoryComputeError('deferred', { retryAfterMs: 3_000 })`；
     - 达到 30s 上限后置“当前连续后台批次豁免”标志，确保紧接的主整理步与独立画像规划步完整跑完并推进检查点，待前台空闲或 `owner.epoch` 切换后复位；
   - **不中断已在途请求**：已在执行中的后台计算不因新前台流开始而被中止；
   - **手动 Dream 豁免**：`job.manual === true` 时豁免前台软让路（仍尊重活跃服务商冷却下限）。
4. **后台轻模型扩展口**：`MemoryCompute` 协议继续按 `{ provider, model }` 参数化，后续可直接复用 DSH 已配置提供方中的轻量模型。

### 4.5 未来重新评估独立 LLM 通道的触发条件

`src/memory/core/` 的 `MemoryCompute` 抽象端口保持不变。仅当未来明确出现以下诉求之一时，再基于该端口引入独立推理客户端或共享 LLM 网关进程：
1. 需要关闭 DSH 单独运行后台记忆（例如非 DSH 外部数据源持续写入并触发整理）；
2. Viva 计划接入 DSH 以外的多个 Agent Runtime。

### 4.6 阶段三验收标准

1. **托管收口、首跳取消/期限传播、旧连接围栏与冒烟对齐**：
   - `desktop-memory-owner.ts`、`memory-prefetch.ts` 与 `fromViva()` 已删除；Viva 桌面端与独立 DSH 共享同一 `standaloneOwner`；
   - 经真实父进程 IPC 通道验证 `memory_host_request` / `memory_host_cancel` → `memory_host_result`：① 预算到期前提前中止 `readBatch` 会发出 `memory_host_cancel` 传播到 worker，且读槽位保持至终态 `memory_host_result` 返回后才释放；② `deadlineAt` 经首跳直达 worker；③ `memoryHostFailure` 结构化领域错误（`domainCode` / `domainDetails`）完整回传；④ 已提交未回包的写入按原 `operationId` 重试只生效一次；
   - 验证模型工具路径（`sidecarRequest` 仅开放 `remember` / `recall` / `file_read` / `node_search`）无法调用任何 `callHost` 管理方法；
   - 更新原 `#161` 与 [lifecycle.spec.ts](../test/smoke/lifecycle.spec.ts) 用例：保留“仅 `memory-worker` 崩溃时 DSH 不重启并原地替换 worker + 保持 root 锁”用例；将“切模型/清 Key 主动重启 DSH”用例更新为校验新 worker PID 与记忆恢复就绪；同时验证旧 DSH 连接迟到帧被围栏丢弃。
2. **过渡期摄取代理验收**：
   - 验证冷启动 `recovering → ready` 窗口内发出的 `sourceAlias` 经有界队列在 `ready` 后幂等重放不静默丢弃；`origin: 'derived'` 不升格为人类来源，已取消回合不生成日记；`acceptQuestionAnswer` 等待有界确认；保留既有 `memory-handoff.test.ts` 核心断言。
3. **DSH 内单跳检索、版本夹检与三段/晚订阅 L2 重建**：
   - 验证 `agent/pre-step` 并发短预算检索与 worker 权威 `(startRevision, endRevision)` 校验：在搜索中途发生文件删除/变更时标 `stale` 并触发至多 1 次重查，绝不注入已失效版本；验证 `prepareCall` 失败/取消零幽灵回执；
   - 验证首次启动、先启动 supervisor 再晚挂载 adapter（首个 `ready` 回调内读到非空画像）、DSH 重启与仅 worker 崩溃四种场景下：`unavailable` 立即清空过期 L2，新 worker 按 `recovering(newEpoch) → memory_owner_profile → ready(newEpoch)` 三段顺序无拒绝重建，支持 `text: ''` 清空；
   - 使用更新后的 [benchmark-memory-latency.ts](../scripts/benchmark-memory-latency.ts) 对比 `5e96068` 基线与真实 bypass 基线，记录冷、热启动下首个实际模型请求的额外 P95 延迟与证据命中率。
4. **429 `Retry-After` 真实 worker RPC 与前台软让路验收**：
   - 通过真实插件→worker RPC 全链路分别验证 **Note** 与 **Dream（主整理步 + 画像规划步）**，覆盖 DSH `{ type: 'finish', reason: { kind: 'error', failure } }` 终态帧与抛出 `LlmError` 两种形态：注入 `RATE_LIMIT`（`providerRetryAfterMs: 45_000`）后核对 SQLite `effects.cooldown_until >= failAt + 45_000`、`effects.due_at >= cooldown_until`、`attempts === 1`，重启 worker 后在 `due_at` 之前不提前重发，且**验证 `429 → 重启 worker → 推进时钟前立即触发手动 Dream` 仍保留原冷却截止时间绝不提前触发**，到期后正常重发；无 `Retry-After` 的 503 走既有指数退避（首次 `1_000ms`）；
   - 前台流式输出活跃时，自动 Note / Dream 在调用 LLM 前返回 `defer`（顺延约 3s、`attempts === 0`）；持续前台活跃满 30s 后放行整批后台整理（含两步 Dream 完成 checkpoint 落盘）；手动 Dream（`manual: true`）在 3s 软让路期间立即执行，而在 45s 服务商冷却期间（含重启后）不提前缩短冷却；已在途后台计算不被打断。

---

## 5. 阶段四（收口版）：以 DSH 持久化会话日志为单一事实源并打通后台会话记忆

### 5.1 现状根因与边界原则

在“记忆回归 DSH 插件”的架构下，不应让记忆插件耦合 Viva 私有表结构（`history.db`），也不应反向把无关插件（`history`、`tasks`、`fork`、`routing`、`compaction`）或 `acp-bridge.ts` 回合状态机绑死在记忆子系统上。现状摄取层真正需要解决的三个根因是：

1. **双通道异步竞跑**：DSH 插件扫会话推 `receiveSource`，Viva 后端另发 fire-and-forget 的 `sourceAlias` 与 `acceptQuestionAnswer`，导致晚到的 `acceptQuestionAnswer` 被已结清的 `owner_turns` 丢弃，晚到的 `sourceAlias` 需等 `turn/end` 重扫补录。
2. **重复维护对话历史文件**：`memory-note-store.ts` 在 `session/dialog/<hash>.jsonl` 中另抄写了一份对话历史，与 DSH 原生的 `<dshHome>/sessions` 持久化日志重复。
3. **后台任务会话信息遗漏**：[acp-bridge.ts](../src/backend/acp-bridge.ts) 的 `preparePrompt` / `steer` 调用 `recordSource` 时未传 `sourceId`，[compose.ts](../src/backend/compose.ts) 将其标为 `origin: 'derived'` 被 `owner.ts` 丢弃并跳过该轮助手回复；发回主对话的 `viva-report` 也被跳过；后台开放题回答锁死在 `{ kind: 'task', id: session }` 孤岛，导致后台任务的指令、插话与结论无法被主对话召回。

为控制 PR 粒度与回归风险，阶段四按两个独立可验收 PR 交付：**PR 4A（单一日志事实源 + 后台任务归属与 `humanSpans`）** 与 **PR 4B（开放题 `ask_user_question` 原生消费）**。

### 5.2 单一持久化日志事实源、CAS 游标、只读冷补扫与全新 Schema 契约（PR 4A）

1. **以 `flush() + open('read')` 持久化切片读取为统一落盘边界**：
   - 在已锁定 DSH 的 JSONL 后端中，无持久化写句柄的会话调用 `ctx.sessions.flush(session)` 也会返回 `true`（随后 `open(id, 'read')` 抛 `SessionPersistenceNotFoundError`）；
   - 因此在 [ingestion.ts](../plugins/memory/lib/ingestion.ts) 提供统一读取函数 **`readVerifiedDurableSlice(ctx, session, fromSeq, endSeq)`**：先执行 `await ctx.sessions.flush(session) === true`，再通过短生命周期只读句柄 `ctx.sessionPersistence.open(session.id, 'read')`（`finally` 中 `close()`）**直接从磁盘读出 `[fromSeq, endSeq)` 实际持久化事件切片**（`flush` 返回 `false`/抛错、`open('read')` 抛 `SessionPersistenceNotFoundError` 或实际数量不足 `endSeq - fromSeq` 一律 fail-closed）；
   - 常规回合摄取与回合中 `memory_remember` 暂存均只消费 `readVerifiedDurableSlice` 返回的持久化事件（绝不消费未核验的 `session.snapshotEvents()`），兼容 DSH `repair.ts` 恢复出的合成 `turn/end`。
2. **单 SQLite 事务内防跳洞 CAS 游标与幂等区间落盘（冷扫描保持只读、不抢写锁）**：
   - 彻底移除 `memory-note-store.ts` 中对新回合写入 `session/dialog/<hash>.jsonl` 的维护逻辑；
   - `memory-worker` 在 SQLite 中新增两张轻量摄取表：
     - `owner_intake_cursors (session PRIMARY KEY, next_seq, inherited_seq, session_kind, conversation, created_at, updated_at)`；
     - `memory_note_ranges (range_id PRIMARY KEY, note_key, session, workspace, day, from_seq, to_seq, turn, sources_json, assistant_digest, assistant_valid, status)`，其中 `range_id = sha256(session, from_seq, to_seq)` 在 `(session, from_seq, to_seq)` 上唯一（允许同日多批回合依次追加更新同一 `note_key`）；
   - **严格防跳洞 CAS 游标守卫与终态分流（仅 `completed` 回合入规范来源、日记与结论）**：扫描器从实际观察到的 `expectedNextSeq` 连续读取已闭合回合（`turn/start ... turn/end`）或已核验非回合前缀，在单 SQLite 事务中严格要求 `cursor.next_seq === expectedNextSeq`（重复 `(session, from_seq, to_seq)` 幂等返回；不匹配则拒绝并从最新 `next_seq` 重扫）；对任意终态 `turn/end` 均在同一事务内原子清理 `owner_open_turn_sources` 并推进 `owner_intake_cursors.next_seq = endSeq`，但**仅当 `turn/end` 的 `reason.kind === 'completed'` 时才在同一事务内幂等写入/复用本回合全部过滤后的规范 `memory_sources`（含未调用 `memory_remember` 的普通提示原话与 `task-assistant` 结论）并插入 `memory_note_ranges`**——普通用户取消（DSH 持久化为 `reason.kind === 'aborted'`，其中 `reason.reason.kind === 'user'`）及 DSH 物理修复闭合（`reason.kind === 'interrupted'`）仅推进游标与清理暂存，绝不生成日记区间或把半截助手输出发布为全局可召回任务结论；
   - **冷扫描严格只读（绝不抢占 `open(id, 'write')` 写租约）**：冷补扫仅消费已闭合的回合（`turn/start ... turn/end`）；若写者曾在半截回合崩溃导致尾部尚无 `turn/end`，冷扫描保持游标停在该未闭合回合之前，待会话下次被 DSH 打开、由 `repair.ts` 补齐 `reason.kind === 'interrupted'` 的 `turn/end` 后，按上述终态分流安全推进游标并清理暂存（不生成残缺日记）——彻底避免冷扫描持写锁等待跨进程 SQLite 提交而导致用户重开会话触发 `SessionAlreadyOwnedError`；
   - **崩溃恢复保证**：`flush` 前崩溃时 `next_seq` 未推进，重启后重放持久化前缀；区间登记后崩溃时 `memory_note_ranges` 仍排队，`WRITE_NOTE` 沿用 `journal.commit` 的 `(note_key, generation)` 幂等回执并在同一应用事务中标 `range_id` 已消费。
3. **Fork 零侵入继承前缀与可重试冷会话补扫**：
   - **保持 [plugins/fork/index.ts](../plugins/fork/index.ts) 零改动**：沿用现有 [ingestion.ts](../plugins/memory/lib/ingestion.ts) 以 DSH 持久化在子会话上的 `session.inheritedEventCount` 作为游标起点（`Math.max(inherited, nextSeq)`），天然只消费 fork 之后的新事件、不重复记账；切目录后子会话自动绑定新目录的 `project` 作用域，天然保持项目隔离（不新增本地 `<childId>.json` 队列或 `owner_fork_lineage` 表）；
   - **可重试的启动枚举与冷热交接**：`memory-worker` 达到 `ready` 后，将 `ctx.sessionPersistence.list()` 纳入生命周期绑定的指数退避重试循环；对未在 `ctx.sessions` 打开的冷会话以只读句柄分片读取（`finally` 中 `close()`），经 `ingestion.ts` 按 `sessionId` 串行队列协调冷扫与活会话打开，单会话读错按 `sessionId` 退避重试直至成功、变为活跃或确认 `SessionPersistenceNotFoundError`。
4. **按需读取区间与源会话缺失语义**：
   - 攒够 `noteInterval`（或跨天 / 后台任务结束 flush）触发 `WRITE_NOTE` 时，`memory-worker` 经插件 `readSessionRange({ sessionId, fromSeq, toSeq })` 只读打开 `ctx.sessionPersistence.open(SessionId(sessionId), 'read')`（`finally` 中 `close()`）读出事件切片并经 `looksSecret` 过滤后生成 Daily Note；
   - 捕获 `open()` 与 `read()` 两处的 `SessionPersistenceNotFoundError`：仅确认源会话已删除时返回 `{ status: 'deleted' }` 结清区间；其他临时 I/O 报错或短读经新只读句柄复查未删后返回 `{ status: 'unavailable' }`，保留待写区间交由 `effects` 重试。
5. **全新 Schema 契约升级（遵循 §3.1 无存量用户前提）**：
   - 遵循 §3.1 既定前提（当前无存量用户，PR 3 与 PR 4 连续在同一发布窗口内完成），递增 [memory-store.ts](../src/memory/node/memory-store.ts) 的 **`MEMORY_CONTRACT`** 常量，按全新 Phase 4 schema 初始化建库（总计仅新增 4 张轻量表：`owner_intake_cursors`、`memory_note_ranges`、`owner_open_turn_sources`、`owner_question_answers`，并在 `memory_sources` 上扩展 `source_kind`、`profile_eligible` 及回答的直接问题元数据列 `question_valid`、`question_sources_json`、`question_at`、`question_profile_gen`）；
   - 历史已生成的 Daily Note Markdown 文件若残留 `source_conversation: [[session/dialog/...]]` frontmatter 解析器兼容忽略，新生成的 Daily Note 不再写入该字段；**不引入历史旧库锁内迁移脚本、`memory_legacy_deferred_turns`、双轨 `legacyTaskProfileRefs` 或特例读豁免**。

### 5.3 日志清理后的独立运行与直接依赖契约（PR 4A）

明确区分未消费区间、规范证据与解耦边界：
1. **未消费区间元数据（`memory_note_ranges`）**：仅用于延迟生成 Daily Note 的按需拉取；源会话提前删除时按 §5.2 第 4 条安全跳过并结清。
2. **已接纳的规范证据来源（`memory_sources`）**：在回合扫描或 `memory_remember` 接纳有效素材时，仅将经 `looksSecret` 过滤且实际参与记忆的精简证据片段（用户原话、人类开放题自定义回答、任务目标/结论摘要）以稳定 UUID `id`、`version`、`token`、`text` 与结构化属性（`author`、`source_kind`、`profile_eligible`）存入 SQLite，**并在回答行上直接持久化其直接问题上下文元数据（`question_valid`、`question_sources_json`、`question_at`、`question_profile_gen`）**——使 [memory-note-store.ts](../src/memory/node/memory-note-store.ts) 的 `sourceQuestionContext()` 与 Dream 画像步在 `memory_note_ranges` 结清及源 DSH 日志删除后，依然能准确识别有效问题并拦截被撤销的问题来源，**不再抄写整段含工具日志/推理流/上下文注入的完整对话**。
3. **直接依赖即时生效与“回答 vs. 问题正文”独立校验（明确不做跨模块递归污点追踪）**：
   - 既有 [memory-runtime.ts](../src/memory/core/memory-runtime.ts) 与 [memory-document-read-policy.ts](../src/memory/core/memory-document-read-policy.ts) 的直接来源校验完整保留：编辑、停用或遗忘某条规范来源后，该来源本身及直接引用它的 Daily Note、Digest、常驻画像在全服务路径立即失效；
   - **独立校验人类回答与可撤销问题正文**：修复 [memory-note-jobs.ts](../src/memory/core/memory-note-jobs.ts) 中 `questionAllowed === false` 时连带丢弃整条回答的旧行为，改为与 Dream 一致——将 `answer.text` 与 `question` 拆离校验，撤销问题前置依赖时仅扣留 `question`（置 `question: null`）而保留独立合法的人类自定义回答；
   - **明确的架构解耦边界**：路由生成的 `task-brief`（`author: 'agent'`）与后台任务结论（`author: 'assistant'`）严禁进入 L2 常驻画像（`profileEligible: false`），并可在记忆管理中直接编辑、停用或遗忘；**刻意不为二次转述建立跨会话/跨工具/跨压缩的递归污点图**——不新增 `owner_message_evidence`、`owner_tool_evidence_staging`、`memory_source_dependencies`，对 `history-channel`、`tasks-channel`、`plugins/tasks`、`plugins/fork`、`plugins/routing`（含 `fast-lane`）、`request-runtime` 与 DSH `compaction` 保持**零侵入**。
4. **解耦保证**：源会话日志从 `<dshHome>/sessions` 删除后，已生成的 Daily Note、Digest 与常驻画像仍依据 `memory_sources` 完整通过 `refsCurrent`、`materialAllowed`、共享读策略、Dream 核验与受管文件读写，独立运作。

### 5.4 来源归属、无损可逆 `humanSpans`、可见域与画像资格分离（PR 4A）

不再用单一 `context` 字段同时承担“检索可见域”和“画像准入”，也不靠投递函数名推断作者，而是在**发起动作处**确定来源并在持久化日志中无歧义落盘：

1. **发起动作归属、会话类型与 Viva `conversationId` / `sourceId` 全三路持久化**：
   - 在发起动作处显式标注 `origin: 'human' | 'router' | 'unattended'`（开放题回答同步标注 `answerOrigin: 'human' | 'agent'`）：
     - 用户在主对话输入、主对话运行中插话、任务卡片直接发送/追问，或用户在 UI 开放题卡片提交回答 → `origin: 'human'` / `answerOrigin: 'human'`；
     - 路由模型在 [request-runtime.ts](../src/backend/request-runtime.ts) 触发 `start` / `message` → `origin: 'router'`；主模型调用 `answer_background_task`（[compose.ts](../src/backend/compose.ts) `recordMemory: false`）代答后台问题 → **`answerOrigin: 'agent'`**；
     - 定时/自动无人值守任务（`startUnattendedTask`）→ `origin: 'unattended'`；
   - **类型化 `UserMessage.source` 扩展、`agent/pre-step` 入口拆包（零元数据进模型上下文与持久化正文）与统一人类消息提取器**：
     - [plugins/steer/index.ts](../plugins/steer/index.ts) 投递的插话使用类型化 `UserMessage.source`：主对话人类插话为 **`viva-main-human-steer`**（携带 `sourceId`、`conversationId` 与精确 payload 相对 `humanSpans`）、后台任务人类卡片插话为 **`viva-task-human-steer`**（携带 `sourceId`、`conversationId` 与**在生产端将 `withTaskRequestSource` 返回的 wire 偏移减去顶层头长度转换得到的 payload 相对 `humanSpans`**）、后台任务路由插话为 **`viva-task-router-message`**、忙时后台任务回报为 **`viva-report`**；
     - 经标准 ACP `session/prompt` 投递的消息在顶层写入确定性结构化来源头（`【Viva 元数据：...】`，扩展 [header.ts](../src/shared/request-routing/header.ts) / [task-header.ts](../src/shared/request-routing/task-header.ts)），**仅作为 Viva → DSH 这一跳的传输包装**，携带 `origin`、`sourceKind`、`sessionKind`（`'main' | 'task' | 'unattended'`）、可信 Viva 会话段 ID **`conversationId`**、普通提示/人工追问的原始 Viva **`sourceId`**（删除 `sourceAlias` 后，普通提示、主对话插话、任务插话三条路径均通过 `memory_sources.id === history.source_id` 完整保留 [history-db.ts](../src/backend/history-db.ts) `historyDb.sourceLink()` 跳转）与 `humanSpans`（会话归属持久化于 `owner_intake_cursors (session_kind, conversation)`）：
       - 空闲时由 [task-reports.ts](../src/backend/task-reports.ts) → [compose.ts](../src/backend/compose.ts) 经 ACP `agent.prompt(note, [], { request: false })` 投递的批量报告顶层携带 `sourceKind: 'viva-report-batch'` 与 **`humanSpans: []`**，绝不进入人类 `memory_sources`、Daily Note 或 L2；
       - **DSH 入口拆包搬进 `source`（`agent/pre-step` + `liftProvenance`）**：因 `dsh-agent-loop` 持久化到 `user/message` 并送往模型的正是 `agent/pre-step` 返回的 `decision.messages`（而 `dsh-acp` 已在入队领取阶段按 `message.id` 关联了 turn），且 DSH V4 持久化格式原样保留 `user/message.source` 中的不透明扩展字段、`dsh-llm` 序列化模型请求时绝不发送 `source`，由 Viva 宿主适配插件 [plugins/steer/index.ts](../plugins/steer/index.ts)（在 Viva profile 中必选加载）注册 `agent/pre-step` 监听器，将首段 `【Viva 元数据：...】\n` 传输包装从 `content` 剥离并抬升至 `source`（保留原 `message.id`、纯图片场景剥空首个文本块时移除空块，返回 `freezeMessage(...)`）：
         - **人类 ACP 提示（`origin === 'human'`）必须保留 `source.kind = 'user'`**，将结构化来源挂在扩展字段上（`source: { kind: 'user', vivaProvenance: { origin, sourceKind, sessionKind, conversationId?, sourceId?, humanSpans? } }`，通过模块声明扩展 `MessageSourceMap['user']`）。保持 `kind: 'user'` 可完整兼容 `dsh-base` 中所有按 `source.kind === 'user'` 过滤已提交 `user/message` 的内置插件（`dsh-web-deepseek-api` 联网搜索问题提取、`dsh-session-title`、`dsh-tool-goal`、`dsh-session-reference`、`dsh-session-turn-outline`、`dsh-session-log-export`）；
         - **非人类 ACP 提示（`origin !== 'human'`）**抬升为独立的非 `'user'` `source.kind`——**`viva-report-batch`**、**`viva-unattended`** 与 **`viva-task-brief`**（携带解析后的来源字段），使系统/路由/无人值守提示不会误触发仅面向真人消息的 DSH 内置插件；
         - **Cordis `waterfall` 洋葱顺序、严格幂等与独立插件隔离**：因 Cordis `waterfall` 为洋葱模型（先注册在外层、后注册在内层，`await next()` 后的转换按由内向外执行），拆包监听器**不得使用 `{ prepend: true }`**。`liftProvenance` 以 `'vivaProvenance' in message.source`（及非 `'user'` 守卫）保证严格幂等，避免重复调用误剥用户在首行键入的仿冒 `【Viva 元数据：...】`。仅在 `config.host === true` 分支（独立 DSH `host: false` 绝不触发，保持 `viva-memory` 插件通用性），[adapter.ts](../plugins/memory/lib/adapter.ts) 的 `agent/pre-step` 也做一次幂等 `liftProvenance` 兜底，不依赖插件注册顺序；
         - **冷扫描读取边界**：冷补扫只读已提交的 `user/message` 事件（正文干净且 `source` 带结构化归属），绝不从仍含未拆包原文的 `agent/inbox/spliced` 读取。
     - **统一人类消息提取器 `extractHumanMessages(messages)`**：替换 [ingestion.ts](../plugins/memory/lib/ingestion.ts) 中仅认 `source.kind === 'user'` 的 `humanMessages()`，由 [adapter.ts](../plugins/memory/lib/adapter.ts) 的 `agent/pre-step` 自动 L3 召回与会话摄取共用——直接从 `message.source` 读取结构化归属，统一识别 `'user'`（宿主 `host: true` 下读 `vivaProvenance` 并按 `humanSpans` 切片，独立 DSH `host: false` 下原样取正文且绝不解析 Viva 头）、`viva-main-human-steer` 与 `viva-task-human-steer`（ACP 提示与 IPC 插话统一按 payload 相对 `humanSpans` 切片，绝不把外层路由/插话头送进 L3 或入库），显式排除 `viva-task-router-message`、`viva-task-brief`、`viva-report`、`viva-report-batch`、`viva-memory` 与 `viva-unattended`（纯 Feed `humanSpans: []` 输出空；`extractRecallQueries` 额外允许对 `viva-task-brief` 执行只读 L3 查询）。
2. **携带上下文与 Feed 续写的无损可逆 `humanSpans`（统一 payload 相对 UTF-16 坐标并保留用户字面零宽字符）**：
   - 全路径统一约定 **`humanSpans: Array<{ start, end }>` 为剥离顶层结构头之后的转义正文（`payload`）上的 UTF-16 相对偏移**（经 `agent/pre-step` 的 `liftProvenance` 拆包后，该坐标直接对应已提交 `user/message` 的正文；[task-header.ts](../src/shared/request-routing/task-header.ts) `withTaskRequestSource` 若内部产出含头部的 wire 偏移，必须在生产端序列化头或构造 `viva-task-human-steer` 前减去头部长度转为 payload 相对偏移）；[compose.ts](../src/backend/compose.ts) 拼装携带上下文（`carried + "\n\n" + question`）或 Feed 续写（生成正文 + 可选 `supplement`）时，继续保留纵深防御的同类头转义（含 `PROVENANCE_QUOTED`，`QUOTE = '\u200B'`，防任意未封包入口被仿冒），并写入仅跳过 Viva 自插 `QUOTE` 的不相交 payload 相对区间列表（纯 Feed 无补充时为 `humanSpans: []`）；
   - 消费端（实时 L3 召回与冷回放摄取共用同一坐标）直接从 `message.source`（`vivaProvenance` / 类型化插话来源；若遇未拆包旧事件可兼容兜底解析）读取 payload 相对 `humanSpans`，校验有序且合法后直接按 `humanSpans.map(s => payload.slice(s.start, s.end)).join('')` 拼出原始用户正文，**绝不对抽取出的 span 再做通用 `unquote()`**，保证原始引用头文本与用户字面 `\u200B` 100% 逐字无损往返；`carried` 与 Feed 生成正文绝不进入 `memory_sources`、`memory_remember`、Daily Note 或 L2；独立 DSH（`hostNamespace === undefined`、`host: false`）仍整段接纳非敏感用户输入。
3. **完整来源分类矩阵（保持 `author` 向后兼容与项目域隔离）**：
   - 持久化 `memory_sources.author` 增量扩展为 **`'user' | 'manual' | 'answer' | 'agent' | 'assistant'`**（兼容 [records.ts](../src/memory/contracts/records.ts) 与 `explicitFileSource`）：

   | 发起动作 / 投递入口 | 持久化 `author` | `sourceKind` | Daily Note | 检索可见域 | `memory_remember` | L2 常驻画像 (`profileEligible`) |
   |---|---|---|---|---|---|---|
   | Viva 主对话用户输入 / 主对话人工 `steer`（`viva-main-human-steer` / `humanSpans` 切片） | `user` | `main-human` | ✅ 是 | 全局 `user` | ✅ 是 | ✅ **是** |
   | 独立 DSH **非项目域**用户输入（`project == null`） | `user` | `main-human` | ✅ 是 | 全局 `user` | ✅ 是 | ✅ **是** |
   | 独立 DSH **项目域**用户输入（`project != null`） | `user` | `project-user` | ✅ 是 | 当前 `project` 域 | ✅ 是（项目域） | ❌ **否**（保持项目隔离） |
   | 人类提交的主对话开放题自定义回答（经受信任交互 UI 写入 `owner_question_answers` `'human'` 记录，未证明程序化回答 fail-closed） | `answer` | `question-answer` | ✅ 是 | 全局 `user` | ✅ 是 | ✅ **是**（叠加删除水位校验） |
   | Viva 后台任务**用户卡片插话/追问**（`origin: 'human'`） | `user` | `task-human-steer` | ✅ 是 | 全局 `user`（主对话可召回） | ✅ 是 | ✅ **是** |
   | Viva 后台任务**用户卡片开放题自定义回答**（`answerOrigin: 'human'`） | `answer` | `task-question-answer` | ✅ 是 | 全局 `user`（主对话可召回） | ✅ 是 | ✅ **是**（叠加删除水位校验） |
   | 主模型 `answer_background_task` 代答后台开放题（`answerOrigin: 'agent'`） | —（不作为人类原话入库） | `task-agent-answer` | ❌ **否** | — | ❌ **否** | ❌ **否**（严禁进画像） |
   | 后台任务**路由模型 `brief` / 路由 `message`**（`origin: 'router'`） | `agent` | `task-brief` | ✅ 是（任务目标背景） | 全局 `user`（主对话可召回） | ❌ **否** | ❌ **否**（模型转述，严禁进画像） |
   | 后台任务**助手最终结论**（`assistant/message`） | `assistant` | `task-assistant` | ✅ 是 | 全局 `user`（主对话可召回） | ❌ **否** | ❌ **否**（模型输出，严禁进画像） |
   | 投递回主对话的后台任务报告（`viva-report` / `viva-report-batch`） | —（不入库） | `viva-report` / `viva-report-batch` | ❌ **否**（防双份重复） | — | ❌ 否 | ❌ **否** |
   | 无人值守定时 / Feed 自动任务（`origin: 'unattended'`） | —（默认不入库） | `unattended` | 默认 ❌ 否（保留工作日志开关） | 仅工作日志（若开启） | ❌ 否 | ❌ **绝不** |
   | 自动召回注入消息（`viva-memory`） | —（不入库） | `viva-memory` | ❌ 否 | — | ❌ 否 | ❌ 否 |

4. **统一全局 `userWorkspace` 归属与 `isPureUserSource` 画像守卫**：
   - 阶段四新摄取的 Viva 后台任务四类可见来源（`task-human-steer`、`task-question-answer`、`task-brief`、`task-assistant`）均落在全局 `userWorkspace`（`scope: { kind: 'user' }, context: { kind: 'user' }, project: null`），以 `source_kind` 与 `profile_eligible` 区分任务归属与画像准入，天然进入主对话全局召回与 Dream；
   - `isPureUserSource(item)` 要求 `item.profileEligible === true && item.scope.kind === 'user' && (item.project ?? null) === null && (item.author === 'user' || item.author === 'answer')`，确保只有合法的全局真人原话与经认证真人开放题回答能进入常驻画像。

### 5.5 `ask_user_question` 开放题原生消费（单张轻量表 + 公开 DSH API，不劫持 `acp-bridge`）（PR 4B）

彻底移除 `acceptQuestionAnswer` 异步旁路，完全基于已锁定 `@deepseek-ai/dsh-*` 的公开受支持 API 实现阻塞、限时续答与 PTC 消费，并用 **1 张轻量表**同时解决人/机归属区分与 `dsh-spill` 截断问题：

1. **单张轻量表 `owner_question_answers`（带 TTL 清理与落库前隐私过滤）**：
   - 在 SQLite 新增唯一一张开放题辅助表 **`owner_question_answers (session, occurrence_key, call_seq, call_id_hash, delivery_kind, message_id, cards_json, answers_json, answer_origin, conversation_id, question_at, question_profile_gen, created_at, PRIMARY KEY (session, occurrence_key))`**（消费后立即删除，未消费的孤立/过期行由定期 TTL 任务如 7 天清理，不再引入 `owner_pending_questions`、`owner_session_incarnations`、`owner_terminal_question_messages` 三张重表或 `inbox.ts` 内部折叠清理）；
   - 卡片投影为严格白名单 `{ id, question, header, multiSelect, options: [{ label, description? }] }`；SQLite `memory.db` 中仅存 `call_id_hash = sha256(callId)`（不存原始提供方 `callId`），写入前对 `cards_json` 与 `answers_json` 中的**全部持久化字符串字段（包括提供方传入的 `card.id`、`question`、`header`、每个选项的 `label` / `description` 与回答文本）**执行 `looksSecret` 过滤（任一命中即拒绝落库）。
2. **基于公开 DSH API 的实时等待、超时续答与 PTC 流程（不劫持主循环与 `acp-bridge`，且记忆拒收/离线不阻塞有效作答）**：
   - **执行作用域 `callSeq` 与落盘核验**：在 [plugins/questions/index.ts](../plugins/questions/index.ts) 中通过 `@deepseek-ai/dsh-tools` 公开的 `ctx.on('tools/execute', ...)` 解析本次 `ask_user_question`（含 PTC `tool/ptc-dispatch-start`）的持久化 `callSeq` 与**原始调用事件时间戳 `event.time`**，并在发布给前端前经 `flush() + open(id, 'read')` 确认该调用事件已真落盘（防无写句柄 `flush() === true` 陷阱），以 `AsyncLocalStorage` 传递 `(callSeq, callId, eventTime)` 随提问请求发往前端；
   - **实时等待路径（`legacy` `ask()`、未超时 `askTimed()`、PTC 立即返回）明确区分三类结果**：受信任交互前端收到提交后、在 resolve `channel.ask()` 之前，按以下分支处理（**绝不因记忆拒收、worker 离线或回执超时阻塞或失败正常的用户作答**）：
     - ① **合格非敏感回答（正常确认）**：发起有界超时（如 `500ms`）的 `owner_question_answers` 持久化写入（`delivery_kind = 'tool-result'`，`occurrence_key = \`call:${callSeq}:${callIdHash}\``），**严格保留真实发起归属 `answer_origin: 'human' | 'agent'`**（UI 卡片提交写 `'human'`，主模型 `answer_background_task` 代答写 `'agent'`），并同步记录原始调用事件时间 `question_at` 与提问时刻 `question_profile_gen`，收到确认后正常 resolve `channel.ask()`；
     - ② **命中 `looksSecret` 隐私拦截，或派发前已确认 `memory-worker` 离线**：不派发也不写入 SQLite（保证零敏感落库与零来源入库），**立即正常 resolve `channel.ask()` 完成经校验的 DSH 作答**；
     - ③ **已派发的合格写入在有界时限内 ACK 超时**：超时视为**未知写入结果**——到时立即正常 resolve `channel.ask()` 不阻塞用户回合，最终是否入库以 SQLite 中实际是否已持久提交该 `owner_question_answers` 行为准（若已提交但仅 ACK 延迟，折叠时仍正常按已提交回执接纳；若未提交则自然 fail-closed）；
   - **超时转续答路径（`state === 'continued'`）**：
     - [plugins/questions/lib/channel.ts](../plugins/questions/lib/channel.ts) 观察后续已提交的 `session/event` / `userQuestions` 投影跃迁——转为 `continued` 时保持 UI 卡片打开，仅真正取消/报错时发 `question_closed`；
     - 无论活跃 agent 还是重启后空闲会话，统一通过公开 API **`ctx.sessionProjections.snapshot(session, ['userQuestions'])`** 枚举 `continued` 提问（不调用私有 `ctx.userQuestions.continued(agent)`），[acp-bridge.ts](../src/backend/acp-bridge.ts) 与 `question-channel.ts` 为 `continued: true` 卡片提供独立于活跃 ACP 回合的准入路径；**重开卡片绝不使用当前时间 `Date.now()` 或当前最新 `profileDeletionGen` 覆盖提问元数据**——`question_at` 始终取自该 `callSeq` 持久化调用起始事件的 `event.time`，`question_profile_gen` 仅在同生命周期内存中保留有原采样值时沿用，**跨重启丢失时一律置 `null`**（从而触发下方真值表第 2 行 fail-closed，绝不把删画像前的旧问题误标为删后合格）；
     - **简单稳健的复用 `callId` 防护**：当同一会话出现复用相同 `callId` 的新调用 B（`callSeqB > callSeqA`）时，立即发 `question_closed` 退场旧卡片 A；在调用 `ctx.userQuestions.answer(agent, callId, answer)` 之前先核对当前活跃 `callId` 的 `callSeq === expectedCallSeq`（过期点击直接拒绝）；**绝不调用 `agent.cancel({ kind: 'hook' })` 中止主循环、不手工重排 `next-step` 队列，也不改造 `acp-bridge.ts` 跨两回合接管逻辑 `prompt()` Promise**（极端竞态下记忆折叠端找不到有效匹配即 fail-closed 丢弃该条记忆）；
     - **真正空闲态 `message.id` 捕获**：因 `ctx.userQuestions.answer()` 返回前会同步入队并在空闲态立即被 `preStep()` 认领，在调用 `ctx.userQuestions.answer(...)` **之前**注册作用域限定的 `agent/inbox/inserted` 监听器同步捕获精确 `message.id`（`finally` 中卸载）；仅当 `answer() === true` 且捕获到 `message.id` 后，将回答写入 `owner_question_answers`（`delivery_kind = 'user-message'`，`occurrence_key = \`msg:${messageId}\``，保留真实 `answer_origin: 'human' | 'agent'`）。
3. **确定性事件折叠、防 `dsh-spill` 截断与统一 fail-closed 归属边界**：
   - 在会话日志折叠 `tool/result`、`tool/ptc-dispatch`（`name === 'ask_user_question'`）与 `user/message`（`source.kind === 'user-question-reply'`，消息 ID 在顶层 **`event.data.id`**）时：
     - 忽略 `isPendingResult`、`TOOL_OUTCOME_UNKNOWN` 及报错结果（避免将未结算或失败调用写入记忆）；
     - 凭 `(session, call_seq, call_id_hash)`（工具结果）或 `(session, event.data.id)`（续答 `user/message`）查询 `owner_question_answers`；
     - **防 `dsh-spill-policy` 截断与统一 fail-closed**：因已锁定 `SpillStore` 仅提供只写 `saveText`，折叠器直接读取 `owner_question_answers` 中经隐私过滤的结构化 `answers_json`（不从截断预览猜测原文，也不调用不存在的 `SpillStore` 读接口）；若查无匹配行或 `answer_origin !== 'human'`（包括 Viva `answer_background_task` 的 `'agent'` 代答与独立 DSH 下未接入受信任交互回执的 SDK JSON-RPC 程序化回答），一律 **fail-closed 跳过入库**（绝不升格为 `author: 'answer'` 或进入 L2）；成功结算后在同一事务内删除已消费的 `owner_question_answers` 行；
     - 共享纯函数 **`questionAnswerSourceId(sessionId, callSeq, callId, questionId)`**（`src/shared/`）将 `callSeq` 纳入确定性 UUID，既避免同会话复用 `callId`/`questionId` 碰撞，又完整保留 [memory-ipc.ts](../src/backend/memory-ipc.ts) UI 时间线链接与 `memory-handoff.test.ts` 跨库连接。
4. **两层独立决策与统一删除水位真值表**：
   - **自定义回答接纳**：要求 `owner_question_answers` 匹配且 `answer_origin === 'human'` + `!looksSecret(customText)`；
   - **向 L2 画像暴露问题正文的统一真值表**（对齐 [memory-dream-jobs.ts](../src/memory/core/memory-dream-jobs.ts)）：

   | 条件 | 是否允许向 L2 画像暴露 `question` 正文 | 说明 |
   |---|---|---|
   | 尚未发生过画像删除（`profile_deleted_at === null && profile_deletion_generation === 0`） | ✅ **允许** | 首次删画像前正常允许 |
   | 已发生过画像删除（`profile_deletion_generation > 0`），且 `questionProfileGen` 缺失/`null` | ❌ **拒绝**（`questionUnavailable: true`） | 缺失提问时刻代数时 fail-closed |
   | 已发生过画像删除，且 `questionProfileGen !== profile_deletion_generation`（无论 `<` 还是 `>`） | ❌ **拒绝**（`questionUnavailable: true`） | 双向失配均 fail-closed |
   | 已发生过画像删除，`questionProfileGen === profile_deletion_generation`，且 `profile_deleted_at === null \|\| questionAt > profile_deleted_at` | ✅ **允许** | 证明提问发生在最近一次删除之后 |
   | 其余情况（如 `questionAt <= profile_deleted_at`） | ❌ **拒绝**（`questionUnavailable: true`） | 晚到 `custom` 回答本身可按删除后时间戳接纳，删除前的问题正文扣留不暴露给 L2 |

### 5.6 回合中 `memory_remember` 暂存对齐与异步旁路清理（PR 4A / PR 4B）

- **移除清单**：
  - PR 4A 删除 [compose.ts](../src/backend/compose.ts) 与 [acp-bridge.ts](../src/backend/acp-bridge.ts) 中的 `recordSource`、`sourceAlias`，删除 [host.ts](../src/memory/contracts/host.ts) 与 [owner.ts](../src/memory/node/owner.ts) 中的 `sourceAlias` 与 `owner_aliases`，删除 `memory-note-store.ts` 的 `session/dialog/*.jsonl` 新写入维护；
  - PR 4B 删除 `onQuestionAnswer -> acceptQuestionAnswer` 异步调用与 `host.ts` / `owner.ts` 中的 `acceptQuestionAnswer`（仅保留 `onQuestionAnswer` 本地纯计算 `questionAnswerSourceId(sessionId, callSeq, callId, questionId)` 供 `history.db` UI 时间线链接使用，零记忆 RPC）。
- **回合中 `memory_remember` 开放回合暂存（PR 4A）**：
  - 引入 **`owner_open_turn_sources (session, turn, source_id)`**：
    1. 模型调用 `memory_remember` 时，`adapter.ts` 先调用 `intake.synchronize(agent.session)`（内部走 `readVerifiedDurableSlice` 确认已落盘；若无写句柄 `flush() === true` 抛 `SessionPersistenceNotFoundError` 或读核验失败，`memory_remember` 立即以 `{"status":"unavailable"}` 中止且不写入规范来源或回执）；
    2. 核验通过后，仅将已落盘且经 `humanSpans` / 人类 `ask_user_question` 校验、`author IN ('user', 'answer')` 的本回合事件幂等写入 `memory_sources` 并登记 `owner_open_turn_sources (session, turn, source_id)`（保持 `owner_intake_cursors.next_seq` 停在上一已完成回合不动）；
    3. `memory-worker` 凭 `owner_open_turn_sources` 校验当轮归属与精确原文 span（自动拒绝 `task-brief`、模型代答 `task-agent-answer`、Feed 生成正文与助手输出），在 `owner_operations` 中以确定性回执完成受管文档写入；
    4. 待 `turn/end` 到达时，原子事务清理 `owner_open_turn_sources` 并按 CAS 推进 `next_seq`；仅当 `reason.kind === 'completed'` 时在同一事务内幂等写入/复用本回合全部过滤后的规范 `memory_sources`（包括未暂存的普通提示与已暂存的 `source_id`）并登记 `memory_note_ranges`。

### 5.7 阶段四验收标准

1. **PR 4A — 单一日志事实源、防跳洞 CAS、终态分流、只读冷补扫与删除独立性**：
   - `flush` 返回 `false` 以及**无持久化写句柄会话上 `flush() === true`（`open('read')` 抛 `SessionPersistenceNotFoundError`）**：`next_seq` 不前进、零规范 `memory_sources` 入库，`memory_remember` 返回 `unavailable`；重启后已持久化前缀零丢失重放；
   - CAS 防跳洞与普通回合原子回滚：向 `next_seq = 100` 提交 `from_seq = 150` 的乱序回合被拒绝不推进游标，补齐中间回合后顺序入库；同日同一 `note_key` 连续两批回合写入均正常合并；**对从未调用 `memory_remember` 的普通完成回合注入结算事务异常/回滚，断言规范 `memory_sources`、`memory_note_ranges` 与 `owner_intake_cursors.next_seq` 整体回滚且无孤立区间或跳过的游标**；
   - 只读冷补扫、终态分流与崩溃恢复：注入 `sessionPersistence.list()` 首次调用失败能自动退避重试追平冷会话；**分别验证真实用户取消（断言 DSH 持久化的 `turn/end` `reason.kind === 'aborted'` 且 `reason.reason.kind === 'user'`）与崩溃后重开经 DSH `repair.ts` 补发物理修复闭合（`reason.kind === 'interrupted'`）**：冷扫期间未闭合回合保持只读不抢写锁，收到 `aborted` 或 `interrupted` `turn/end` 后均推进游标并清理 `owner_open_turn_sources`，但**绝不创建 `memory_note_ranges` 或发布中间助手输出为 `task-assistant`**；Markdown 发布后、区间结算前注入崩溃重启幂等无重复；
   - Fork 子会话（`plugins/fork` 零改动）：仅消费 `inheritedEventCount` 之后的新事件，不重复记账；切目录后按新项目域隔离；
   - 源会话删除与读错区分：`open()` / `read()` 抛 `SessionPersistenceNotFoundError` 结清跳过不阻塞其他会话；临时 I/O 报错或短读保留待写区间并重试；物理删除已整理源会话的 `<dshHome>/sessions` 文件后，已生成的 Daily Note、Digest 与常驻画像仍正常通过 `refsCurrent`、共享读策略、Dream 核验、读写、启停与删除。
2. **PR 4A — 来源归属、`pre-step` 入口拆包、无损 `humanSpans`、统一 L3 提取、三路时间线链接、直接问题元数据留存与 `memory_remember`**：
   - 覆盖：① 主对话带 `carried` 上下文的人类提问、② 纯 Feed 续写（`humanSpans: []`）与 Feed + 人工补充、③ 含原始头文本及用户字面 `\u200B` 的已转义头文本（实时 + 冷回放均逐字无损）、④ 重启后普通 ACP 提示、`viva-main-human-steer`、`viva-task-human-steer`（含 payload 相对 `humanSpans` 偏移转换）三路 `historyDb.sourceLink()` 冷解析与统一 `extractHumanMessages` 精确 L3 查询正文（零包装头）和冷回放入库文本、⑤ 相同文本的路由 `message` vs. 用户任务卡片插话（`task-human-steer`）、⑥ 路由 `task-brief` + 助手结论 `task-assistant`（主对话可召回且不进 L2）、⑦ 主对话 `viva-report` 与空闲批量 `viva-report-batch`（零重复入库）、⑧ 无人值守 `unattended` 隔离、⑨ 独立 DSH 非项目域（`profileEligible: true`）与项目域（`profileEligible: false`）；
   - **入口拆包与零模型暴露**：断言持久化后的 `user/message.content` 以及实际发往模型的请求（`llm/stream`）中均**不含 `【Viva 元数据：`** 前缀；人类 ACP 提示落盘保持 `source.kind === 'user'` 且 `source.vivaProvenance` 经 `flush` 与冷只读 `open('read')` 完整往返（保持 `dsh-web-deepseek-api` / `dsh-session-title` 兼容）；非人类 ACP 提示（`viva-report-batch`、`viva-unattended`、`viva-task-brief`）以非 `'user'` 的 `source.kind` 落盘；重复调用幂等 `liftProvenance` 不会误剥用户在首行键入的仿冒 `【Viva 元数据：...】`；独立 DSH 模式（`host: false`）绝不解析或剥离 `【Viva 元数据：...】`；
   - 无 `sourceAlias` 下，当轮内 `memory_remember` 写入成功并立即可召回；尝试用 `memory_remember` 保存 `task-brief` 或 Feed 生成正文被拒绝（`no-explicit-user-source`）；
   - **区间结清与日志删除后的有效/撤销问题双验**：在 `memory_note_ranges` 被 `WRITE_NOTE` 结清且源 DSH 会话日志物理删除之后，分别验证：① 有效问题仍经 `memory_sources` 直接元数据进入 Dream 画像输入；② 撤销仅被问题正文引用的前置来源时，独立合法的人类自定义回答正文仍保留可用，仅问题正文被扣留。
3. **PR 4B — 开放题真实 DSH 折叠（阻塞/续答/PTC）、非阻塞拒收/离线、防 `dsh-spill` 截断、防冒充与重开删除水位**：
   - 在真实 DSH 栈下验证阻塞模式（`tools/execute` 先 `flush + open('read')` 再发布 `callSeq`）、超时→回合结束→重启空闲态经公开 `sessionProjections.snapshot` 重开卡片→`agent/inbox/inserted` + `ctx.userQuestions.answer()` 经真实 `user/message`（`event.data.id`）折叠入库，以及 PTC（立即返回 `answers[]`、`pending` 与报错清理）；
   - **阻塞作答遇隐私拒收、worker 离线与提交后 ACK 延迟超时均不阻塞**：在阻塞 `ask_user_question` 工具上分别验证：① 命中 `looksSecret` 的卡片/回答（含敏感 `card.id`）与派发前 `memory-worker` 已离线：DSH 正常收到经校验的用户回答且回合完成，`memory.db` 保留零来源与零敏感字段；② **已提交 SQLite 但刻意延迟 ACK 超过有界时限（`500ms`）**：`channel.ask()` 到时正常完成不阻塞，随后折叠按已落库回执正常接纳该合法回答；
   - 用相同自定义回答文本对照用户 UI 卡片提交（`answer_origin: 'human'`）vs. 主模型 `answer_background_task` 代答（`answer_origin: 'agent'`）vs. 独立 DSH 未提供受信任回执的 SDK JSON-RPC 回答：仅经认证的人类 UI 回答入库并进 L2，代答与未证明程序化回答一律 fail-closed 拒绝且绝不进 L2 或 `memory_remember`；
   - 复用 `callId` 过期点击防护：新调用 B 进入 `continued` 时旧卡片 A 收到 `question_closed`，过期点击在 `answer()` 前被 `callSeq` 复核拒绝；
   - `dsh-spill-policy` 溢出截断冷回放（512-token 上限下大段自定义回答）凭 `owner_question_answers` 完整无损入库，且 **SQLite `memory.db` 中零敏感文本（含 `card.id`）与零原始 `callId`**；
   - **更新 [memory-handoff.test.ts](../test/memory-handoff.test.ts)**（移除 4B 废弃的 `acceptQuestionAnswer` RPC 拦截与旧任务域隔离断言，改为走原生回答结算并断言全局 `user` 可召回），完整保留 `(conversation_id, source_id)` 跨库连接与真实新任务（Viva 段 ID ≠ DSH `sessionId`）时间线跳转断言；验证 `profile_deleted_at` / `profile_deletion_generation` 统一真值表全部 5 行边界，**并专项验证 `提问超时 → 删除常驻画像 → 重启 Viva → 重开卡片提交有效自定义回答` 序列中，真实 Dream 画像步输入包含该合法自定义回答且扣留删除前的旧问题正文**。

---

## 6. 交付顺序与验收门槛

拆分为独立渐进 PR，每批均可独立验证与回滚：

1. **PR #178（阶段一 + 阶段二 · 已合入 `5e96068`）**：自动注入三层拆分（L1/L2/L3）+ 5 态协议 + 向量快慢分离 + 关闭手工画像一步切换为 Dream 自动常驻画像及完整检查点恢复。
2. **PR 3（阶段三 · 收口版）**：将 `memory-worker` 托管权从 Viva 主进程收回 `viva-memory` DSH 插件（删除 `desktop-memory-owner.ts`、`memory-prefetch.ts`、`fromViva()`，收敛为单路径 `standaloneOwner`），补全父进程 IPC 协议（`memory_host_result`、`memory_host_cancel`、`memoryHostFailure`、跨两跳执行选项与旧连接围栏）、轻量 `ready` 过渡重放、worker 权威版本夹检、`recovering → profile → ready` 三段推送与晚订阅回放，以及全链路 429/5xx `Retry-After`（在既有 `effects` 行新增单列 `cooldown_until`，跨重启防覆盖且不新增表/JOIN）与轻量前台软让路。
3. **PR 4A（阶段四上 · 单一日志事实源与后台任务归属）**：以 DSH `session-persistence` 持久化会话日志为单一事实源（`flush + open('read')`、防跳洞 CAS 游标、只读冷补扫、递增 `MEMORY_CONTRACT` 干净建库），移除 `session/dialog/*.jsonl` 与 `sourceAlias`，实现发起动作显式归属、无损 `humanSpans`、统一人类消息 L3 提取器、三路时间线链接、后台任务记忆打通全局召回与回合中 `memory_remember` 暂存（对 `fork`、`history`、`tasks`、`routing`、`compaction` 保持零侵入）。
4. **PR 4B（阶段四下 · `ask_user_question` 原生消费）**：移除 `acceptQuestionAnswer` 异步旁路，基于 DSH 公开 API（`tools/execute`、`sessionProjections.snapshot`、`userQuestions.answer`）与单张轻量表 `owner_question_answers`（带 TTL 与隐私过滤）实现阻塞/续答/PTC 原生消费、人/机归属 fail-closed 隔离、防 `dsh-spill` 截断恢复与 `profile_deleted_at` 水位校验（不劫持 `acp-bridge` 回合生命周期）。

依据 [AGENTS.md](../AGENTS.md) 冒烟门槛，PR 3、PR 4A 与 PR 4B 均涉及主进程、DSH 生命周期、IPC 或存储架构变更，合入前均须本地运行 `npm run typecheck`、`npm test`、`npm run check:i18n`、`npm run build`、`npm run test:memory-plugin`、`npm run smoke:memory` 与完整 **`npm run smoke`**，并通过 GitHub macOS + Windows 双平台 CI。

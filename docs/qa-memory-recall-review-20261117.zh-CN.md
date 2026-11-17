# 记忆自动召回与性能问题 Review

> 记录日期：2026-11-17  
> 基于提交：`c3224d7`（`feat: 将记忆系统改为独立文件核心与 DSH 插件 (#144)`）  
> 状态：待处理；本文只记录 review 结论，未修改实现。

## 背景

使用中感觉每次都会召回记忆，并可能因此导致模型过度思考、响应变慢。代码检查确认：普通用户的每条新消息都会自动检索记忆，而不是只在涉及历史、偏好或个人信息时才检索；工具循环中没有新用户输入的 step 不会重复检索。

目前可以确认三类问题：无关记忆也会被注入、前台请求可能等待向量索引补齐、自动注入与模型主动召回叠加。尚未通过真实会话 trace 量化各项因素在实际延迟中的占比。

## 1. 高：没有相关性截断，无关记忆也会作为证据注入

### 代码路径

- `plugins/memory/lib/adapter.ts:299-307`：从本轮用户输入生成 `question`，等待 `context` 检索并追加到模型消息。
- `src/memory/core/memory-runtime.ts:992-999`：自动上下文固定搜索 Top 3，没有设置相关性条件。
- `src/memory/contracts/memory-daily-defaults.ts:12`：默认 `searchMinScore` 为 `0`。
- `src/memory/node/memory-file-index.ts:174-181`：向量检索只排序取 Top N，不过滤低相似度或零相似度结果。
- `src/memory/core/memory-file-ranking.ts:20-24`：候选转换为 RRF 排名分后都会得到正分。
- `src/memory/core/memory-runtime.ts:424-433`：检索结果作为 `File memory evidence` 追加到上下文。

### 实际复现

使用真实的文件检索实现和受控向量进行隔离复现：

```text
问题：今天天气怎么样
唯一记忆：周报每周五下班前交给张三。
测试向量：查询与记忆正交，余弦相似度为 0

实际结果：
status = "ok"
仍然命中周报，score = 0.011475409836065573
```

### 影响

无关资料进入模型上下文后，模型需要额外判断资料是否相关、是否需要继续读取或澄清，增加无效推理，也可能让回答错误地受到旧记忆影响。

## 2. 高：自动检索会在首条模型请求前等待向量索引补齐

### 代码路径

- `plugins/memory/lib/adapter.ts:302`：首条模型请求前等待整个 `context` 调用完成。
- `src/memory/core/memory-file-retrieval.ts:160-211`：`prepareVectors()` 遍历并编码缺失的记忆片段。
- `src/memory/core/memory-file-retrieval.ts:303-317`：向量索引未激活或存在缺失向量时，前台检索等待准备完成，再编码查询。
- `src/memory/contracts/memory-daily-defaults.ts:18`：单次检索超时预算为 10 秒。

### 影响

新增记忆、索引重建或首次启动后，请求路径可能变成：

```text
用户发送
→ 等待本地向量准备和查询编码
→ 才发出第一条模型请求
```

这是独立于模型思考时间的首 token 延迟。

## 3. 中：自动注入和模型主动召回叠加，增加上下文与推理轮次

### 代码路径

- `src/backend/app-plugins.ts:24-27`：缺少稳定背景时，提示词要求“必须先用 `memory_recall` 检索”。
- `src/memory/core/memory-context.ts:16`：记忆规则建议再用 `memory_read` 核对完整原文及 `applicability`。
- `src/memory/core/memory-runtime.ts:405-433`：自动注入包含检索状态、分数、适用性、关联节点等完整 JSON，而不只是简短记忆正文。
- `src/memory/core/memory-context.ts:9`、`src/memory/core/memory-runtime.ts:53`：固定上下文与召回结果预算分别为 3,200 和 6,000 码元；自动检索为召回预留 128 码元。

### 影响

同一轮可能出现：

```text
自动 context 检索
→ 模型阅读检索 JSON
→ 再调用 memory_recall
→ 再调用 memory_read
→ 多一次或多次模型请求
```

固定画像与自动召回合计上限约为 9,072 个 UTF-16 码元，另加证据标题等包装文字，会明显增加每轮输入负担。

## 建议的修正方向

1. **自动注入只保留高置信结果**：保留固定画像及精确或高置信词法命中；语义召回增加经过“无答案查询”评估的相关性门槛。不要简单调整 RRF 分数，因为它只是排名分，不是相似度或置信度。
2. **没有命中时不附加证据区块**：空结果、降级原因和检索元数据不必交给模型。
3. **禁止前台补建向量索引**：索引未就绪时立即使用词法结果降级，向量补齐放到后台；自动路径只使用已经准备好的向量。
4. **消除双重召回**：已经自动检索过的同一问题，提示模型不要无目的地重复 `memory_recall`；关联节点和完整证据 JSON 留给显式深查。
5. **补充负例与性能回归**：覆盖“语义无关时自动上下文不注入”和“缺失向量不阻塞前台请求”，并记录检索耗时、注入字符数、记忆工具调用次数和首 token 延迟。

## 本次验证

运行了以下相关测试：

```bash
ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --test \
  test/memory-file-retrieval.test.ts \
  test/memory-document-runtime.test.ts \
  test/memory-plugin-ingestion.test.ts \
  test/memory-plugin.test.ts
```

结果：59 项通过，0 项失败。

现有测试覆盖了正常召回、证据读取、索引降级和插件注入，但没有覆盖“自动上下文遇到无语义相关记忆时不应注入”这一负例。上述无关命中通过单独的真实检索调用复现，不是由现有测试失败推导得出。

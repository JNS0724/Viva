# 架构：在 dsh 插件体系上解耦

[English](architecture.md) | 简体中文

本文说明 Viva 如何借助 DeepSeek Harness（dsh）的插件体系分层：哪些能力放进 dsh 插件，哪些留在 ACP 协议层，哪些留在 app；插件和 app 之间靠什么约定协作；以及几个经过验证但没有采用的方案。记忆插件的细节见 [memory.md](memory.zh-CN.md)。

## 1. 分层原则

| 层 | 管什么 | 例子 |
|---|---|---|
| **dsh 插件**（app 自己的 profile 里） | 模型看到什么、能做什么：上下文、工具、执行前的策略、后台的模型调用 | 记忆、过程记录、工具策略、人设 |
| **ACP**（与具体 agent 无关） | 会话怎么跑：生命周期、流式输出、授权请求、MCP 服务器声明 | 用户的 MCP 服务器、确认卡片 |
| **app**（Electron） | 人怎么看、怎么改：界面、本机数据管理、系统集成 | 「关于你」、历史对话、key（系统钥匙串） |

**判断标准：只有必须介入 agent 内部才能做好的能力，才写成 dsh 插件**，比如每一步之前的注入、和会话绑定的状态、不弹授权的原生工具、复用 agent 的模型、工具执行前的拦截。其余能力留在 ACP 或 app。原因有两个：

- dsh 还是 0.2.0-rc，插件用到的都是它自己的接口；
- 每多一个插件，app 就离「换成别的 ACP agent 也能用」更远一步。

插件和 app 通过版本化的数据约定协作：持久数据使用 SQLite；问题、配置和实时输出等瞬时事件使用独立 IPC 通道。

## 2. 组成

```
app（Electron 主进程）                                   dsh 进程：--profile viva
┌─────────────────────────────────────┐                ┌───────────────────────────────────────────┐
│ app-plugins.js  人设 + 插件清单       │                │ system-prompt  ← 人设（profile patch）      │
│                 兼容性检查            │── 写 profile ─▶│ viva-memory      上下文 / 记忆工具 / 后台   │
│ dsh-profile.js  写 dsh/profiles/     │                │ viva-trace       每轮步骤 → trace.db        │
│ acp-bridge.js   ACP 会话、MCP 声明    │── ACP stdio ──▶│ viva-policy      工具执行前拦截             │
│ question-channel.js 问题与回答        │◀── IPC ───────▶│ viva-questions   ask_user_question 的回答者 │
│ config-channel.js  对话里的配置       │◀── IPC ───────▶│ viva-config      MCP / skill 配置工具       │
│ 「关于你」「过程」「设置」             │                └──────────────┬────────────────────────────┘
└──────────────┬──────────────────────┘                               │
               └────── memory.db（约定 memory@1）、trace.db（约定 trace@1）
```

| 插件 | 约定 | 插件写 | app 读 / 写 |
|---|---|---|---|
| `viva-memory`（`plugins/memory`） | `memory@1`：`memory.db` | 记忆、会话状态、注入记录、画像整理 | 「关于你」读写画像和记忆，写使用习惯；读注入记录用于「过程」 |
| `viva-trace`（`plugins/trace`） | `trace@1`：`trace.db` | 每轮的思考和工具调用 | 重新打开对话时读，用于「过程」 |
| `viva-policy`（`plugins/policy`） | `policy@1`：无数据，只有行为 | — | — |
| `viva-questions`（`plugins/questions`） | `questions@1`：IPC 消息（见 `plugins/questions/lib/channel.js`） | 模型的问题 | 显示提问卡片，回传回答；同时在 profile 里打开 dsh 的 `tool-ask-user` |
| `viva-followups`（`plugins/followups`） | `followups@1`：IPC 消息（见 `plugins/followups/lib/channel.ts`） | 模型提出的跟进建议；后台准备的不带工具的模型调用的结果 | 建议显示成卡片，用户点了才建跟进（`followups.db`）；按时段请它准备，只拿回草稿 |
| `viva-messages`（`plugins/messages`） | `messages@1`：IPC 消息（见 `plugins/messages/lib/channel.ts`） | 模型要查看的消息（哪个消息源、关键词、多少小时、几条） | 校验后（`src/main/messages-channel.ts`）先把一分钟内没拉过的消息源拉一次（最多等 20 秒），再查 `sources.db`，按条列出、标明「只是数据」（`src/main/message-reader.ts`）；密钥和数据库都不交给 dsh |
| `viva-config`（`plugins/config`） | `config@1`：IPC 消息（见 `plugins/config/lib/channel.js`） | 模型要接入或移除的 MCP 服务器、要新建或安装的 skill（审批卡片通过之后） | 校验后执行（`src/main/config-channel.js`），需要密钥时由窗口请用户填写，加密保存，不回传给 dsh |
| `viva-stream`（`plugins/stream`） | `stream@1`：IPC 消息 | 真实文本/思考增量，以及最终提交的可见内容 | 每次调用先选择输出来源；按尝试替换、撤回和最终校准，ACP 继续承载工具、用量和授权 |

人设不是插件，而是 profile patch 里 `system-prompt` 的 `personaPrefix` 和 `personaSuffix`，定义在 `src/main/app-plugins.js` 的 `PERSONA`。

## 3. 插件清单与约定版本

- **清单**：`src/main/app-plugins.js` 的 `APP_PLUGINS` 列出每个插件的名字、目录、要提供的约定，以及配置（例如数据文件放在 userData 的哪个位置）。
- **声明**：插件在自己的 `package.json` 里写明提供的约定，例如 `"viva": { "contract": { "memory": 1 } }`。
- **启动前检查**（`resolvePlugins`），任何一项不通过，这个插件就**不写进 profile**，原因显示在设置页：
  - 插件存在，`package.json` 可读，名字和清单一致；
  - 提供的约定版本等于 app 需要的版本（`CONTRACTS`）；
  - 用精确版本声明的 dsh 依赖，必须等于当前安装的 dsh 版本，否则 dsh 自己也会拒绝加载。
- **数据文件也记录版本**：`memory.db` 和 `trace.db` 的 `meta.contract_version` 记录写入时的约定版本。遇到更新版本写入的文件会直接报错，而不是误读。
- **替换插件**：写一个提供同名约定、同一版本的插件，在清单里替换掉原来的即可，app 的其余部分不用改。

## 4. profile 的写法

`src/main/dsh-profile.js` 在每次启动 dsh 前写好 `<应用数据目录>/dsh/profiles/viva`（dsh 内嵌在应用里，home 是应用自己的，见 README「内嵌的 dsh」），只写有变化的文件：

- 组合包和 dsh 自带的 `acp` 模板相同；
- `cordis.patch.yml` 写入 `system-prompt`（人设前后缀，按 id 打补丁会整体替换配置，所以两部分都要写）和每个插件的插入项与配置；
- 同一个文件里还写模型（`src/main/model-providers.js`）：用户添加的提供方作为 dsh 自带 `llm-pi-ai` 插件的 `providers`；没有 DeepSeek key 时关掉 `llm-deepseek` 和 `llm-deepseek-account`；新会话的默认模型覆盖 `acp` 一项的 `provider` / `model`。key 不进 profile，只以环境变量交给 dsh 进程；
- 每个插件以 `link:` 依赖挂入，`node_modules/viva-*` 是一个转发包（`export * from '<插件入口的文件 URL>'`）：插件留在应用里（安装后在 app.asar 内），它的 import 在应用的包里解析，不需要符号链接或 junction；
- 清单里已经没有的 `viva-*` 插件，链接和依赖都会被移除，dsh 就不再加载它。

用户自己的 `~/.dsh` 不会被读写。profile 写不了时，退回 dsh 自带的 `acp` profile，助手照常可用，只是没有 app 的插件和人设。

## 5. 各插件的 dsh 接口

| 插件 | 用到的 dsh 接口 |
|---|---|
| memory | `agent/pre-step`（注入）、`sessionProjections`（统计压缩次数）、`tools.register`（原生工具）、`agent/turn-stopping` + `llm.stream`（后台提取、画像整理） |
| trace | `agent/turn-stopping`，并读取 `session.eventAt` 拿到本轮事件 |
| policy | `tools/pre-execute`（先于授权执行，返回 `deny` 时附带给模型看的原因） |
| followups | `tools.register`（`viva_followup_propose`，只把建议交给应用）、`llm.stream`（后台准备：不传 `tools`，模型只能写） |
| messages | `tools.register`（`viva_messages_read`，只读，向应用要结果） |
| stream | `agent/assistant-stream`（实时流帧）、`session/event`（最终内容）、`agent/disposed`（清理绑定） |

`viva-stream` 依赖 dsh 内部事件结构，并非通用 ACP 扩展。当前固定为 dsh `0.2.0-rc.2`：该版本的 ACP 适配器只转发已提交的完整块，所以需要独立插件接收真实增量。升级 dsh 时须重跑 `test/stream-runtime.test.js`（实际 dsh + 延迟 SSE），确认首段早于响应结束、取消保留已提交前缀，并检查事件与内容块结构。插件不可用时使用 ACP；已选流式的调用若通道失效，先撤回该调用的临时内容，再恢复完整 ACP 输出，避免丢字或重复追加。

新话题先展示空白输入区，后台准备期间可输入、不可发送；失败保留草稿并原地重试。旧会话立即从前台事件路由移除，继续完成关闭和持久化。已预热会话可直接接管；冷创建带 MCP 的会话必须等旧资源释放，同一会话恢复也必须等关闭完成。最多允许一个旧前台会话并行收尾，避免连续切换积累资源。

可以提前准备最多一个独立空会话，额外持有一份该会话的 MCP 连接/进程，准备好后 120 秒未消费即回收。单实例服务器可能拒绝第二份连接：这类预热失败直接丢弃预热会话，不更新正式会话的 MCP 状态或 30 秒失败暂避记录；同一失败指纹停止反复预热，配置改变、显式重载或重启后可以重试。真正创建会话时重新尝试；不同会话不共用 MCP 客户端。失效备用会话清理后才启动替代连接，清理失败允许下一次重试，dispose 后迟到的创建结果不得重新发布。

阶段计时可用主进程环境变量 `VIVA_SESSION_TIMING=1` 和渲染器 `localStorage.setItem('viva:session-timing', '1')` 分别开启；只记录阶段、耗时、命中来源和结果，不记录提示词或 MCP 配置。ACP `session/new` 将创建和 MCP 初始化合在一个请求中，计时不能将两者伪装成独立测量。

每个插件出错都只记日志：注入失败就不带记忆，记录失败就没有「过程」，不会影响对话本身。插件加载失败时，dsh 会输出一条带插件名的警告，照常启动。

## 6. 逐项结论

| 项 | 结论 |
|---|---|
| **人设** | 已改为个人工作助手。之前沿用 `acp` 模板，模型被告知自己是「coding agent」。测试会检查发给模型的请求里有新人设、没有「coding agent」 |
| **插件清单与约定版本** | 已完成，见第 3 节 |
| **用 dsh 自带的 `dsh-time-context` 代替自己注入的日期** | **不采用。** 它在拿不到浏览器时区时，会告诉模型「时区不可用，遇到没标时区的日期要请用户澄清」。ACP 客户端没有浏览器时区，启用后模型会反复追问日期。继续由记忆插件注入【今天】 |
| **「过程」改为插件导出** | 已完成。新会话由 trace 插件写入 `trace.db`，app 优先读它；插件出现之前的老会话才去解析 dsh 的私有日志。两条路径共用 `plugins/trace/lib/steps.js` |
| **工具策略下沉** | 已完成一条规则：MCP 工具名里含有 send、reply、forward、post、publish、deliver、broadcast 等词的（下划线和驼峰写法都识别），一律在执行前拒绝，并告诉模型「只起草，由用户自己发送」。**实测发现 dsh 对 MCP 工具完全不弹授权**，所以这个插件是「不代为发送」唯一的硬保障 |
| **用 ACP 扩展通知代替轮询** | **当前做不到。** dsh 0.2.0-rc.2 的 ACP 实现只会向客户端发 `session/update` 和授权请求，没有给插件开放发送自定义通知的接口。app 继续在每轮结束后的 30 秒内每 2 秒查一次 `memory.db` |
| **其他模型和协议** | 已完成，复用 dsh 自带的 `llm-pi-ai`（OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 三种协议），不写新插件。实测：配置的路由出现在 ACP 的模型选项里、按提供方分组，选中后请求发到它的 baseURL 并带上 key，记忆插件照常注入；默认模型由 `acp` 一项的配置决定，`agent-default-model` 对 ACP 会话不起作用 |
| **消息源** | **不做成 dsh 插件**：dsh 插件要写死精确的 dsh 版本，dsh 一升级第三方插件就失效；插件能给模型加工具、改上下文；装插件、改配置都要重启 dsh。消息源只往外拉消息、不需要介入 agent，按第 1 节的标准属于 app：app 按次启动一个短命进程（`src/main/source-run.ts`），消息校验后存进 `sources.db`。消息源程序碰不到模型；模型要看消息时，经 `viva-messages` 插件向 app 要，由 app 查库后只读地交回。给开发者的 kit 在 `packages/viva-source-kit`，其中的检查工具由 app 的源码编译（`scripts/build-source-kit.mjs`）。见 [sources.md](sources.zh-CN.md) |
| **顺带修复** | 记忆插件取助手回答的路径写错了（`assistant/message` 的正文在 `data.message` 下面），后台提取之前一直看不到助手的回答，已修复并加了测试；画像类记忆失效时立即重新整理画像，不再等 24 小时 |

## 7. 测试

- **真实 dsh + 本地假模型**（`test/fixtures/dsh-harness.js`）：用 app 真实的插件清单和人设写 profile，模型请求发给 `test/fixtures/fake-llm.js`。
  - `test/memory-plugin.test.js`：记忆和人设；
  - `test/trace-plugin.test.js`：「过程」记录，以及 app 不依赖 dsh 日志也能读回来；
  - `test/policy-plugin.test.js`：用假邮件 MCP 服务器（`test/fixtures/mail-mcp.js`）证明发送被拦下、没有发出去，起草照常；
  - `test/model-routes.test.js`：用户添加的提供方。没有 DeepSeek key 时只提供它、新会话从它开始；OpenAI 兼容提供方（`test/fixtures/fake-openai.js`）和 DeepSeek 并存，选中后由它回答、带上 key。
- **插件清单**（`test/app-plugins.test.js`）：约定版本不对、dsh 版本不对、找不到插件时，都会被排除并给出原因；数据文件拒绝更新版本写入的内容。
- **profile 写入**（`test/dsh-profile.test.js`）：人设、多个插件和配置、移除已下线插件、不覆盖无法读取的文件。

## 8. 还没做的

- **把记忆规则放进系统提示词**：现在【记忆规则】随固定层作为 user 消息发送。dsh 的 `system-prompt` 支持插件注册自己的提示词段，放进去可以利用前缀缓存、减少重复。需要先确认注册接口。
- **更多工具策略**：例如工作区外写文件（dsh 的沙箱已经限制）、敏感目录读取。等有了明确需求再加。
- **邮件和 IM 分拣**：沿用同一套做法，在插件里实现，「只起草」已经由策略插件保证。定时分拣可以评估 dsh 的 `schedule` / `jobs` 插件。
- **事件推送**：等 dsh 的 ACP 实现开放扩展通知后，用推送代替轮询。

## 9. 国际化

`src/shared/i18n/` 由主进程和渲染器共用。主进程保存语言偏好，通过受校验 IPC 向两个窗口广播解析后的语言。翻译键和插值参数有类型检查，切换刷新语言相关缓存，不重启会话。协议 id、用户内容、历史消息和第三方输出保留原样。构建包含共享资源；source-kit 生成匹配的 main/shared 路径。实现与验收边界见[国际化](internationalization.zh-CN.md)。

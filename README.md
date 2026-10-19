# Viva · 个人桌面助手

Electron 外壳 + [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`），界面是设计稿里选定的 **A 方案 · 工业饱和 Bento**（深海蓝配色：蓝调深底 + 亮蓝 `#5AA9FF`，点阵数字，编号标签）。

## 运行

需要 Node.js（dsh 依赖它；macOS、Windows 都一样）。

```bash
npm install
npm start
```

首次启动没有 key 时，首页会显示「连接 DeepSeek」卡片，输入框暂时禁用。点卡片上的按钮或标题栏的齿轮，在设置面板里填入 DeepSeek API key 并保存，就会自动连接。

- key 用系统钥匙串加密（Electron `safeStorage`：macOS 用钥匙串，Windows 用 DPAPI），保存在应用数据目录的 `settings.json` 里（权限 600）；钥匙串不可用时拒绝保存，不会退回明文。
- key 只留在主进程，界面只显示末 4 位；保存或清除后会重启 dsh 连接，并开始一段新对话。
- 设置面板里保存的 key 优先于环境变量。
- 找不到 dsh（安装不完整）时，首页会提示重新运行 `npm install`。

| 环境变量 | 作用 | 默认 |
|---|---|---|
| `DEEPSEEK_API_KEY` | 模型凭据（也可以在设置面板里填） | — |
| `AGENT_CWD` | 助手的工作区（dsh 会话的 cwd） | `./workspace` |
| `DSH_BIN` | 指定 dsh：`.js` 入口用 Node 运行，其他按可执行文件运行 | `node_modules/@deepseek-ai/dsh/lib/bin.js` |
| `DSH_NODE` | 运行 dsh 的 Node | `node` |
| `DSH_HOME` | dsh 的数据目录（读取旧对话的「过程」用） | `~/.dsh` |

## macOS 与 Windows

两端用同一套界面，只有标题栏两侧给系统窗口按钮的留白不同：

- **macOS**：红绿灯在左上，标题栏左侧留出位置。
- **Windows / Linux**：由系统在右上画「最小化 / 最大化 / 关闭」（`titleBarOverlay`），页面按 `env(titlebar-area-width)` 把我们的按钮让到它们左边；Windows 上不显示菜单栏。
- **状态胶囊**：始终按整个窗口居中，窗口变窄时先收缩，不会压到两侧按钮。
- **标题栏高度**：两端都是 48px。
- **窗口大小**：按屏幕可用区域计算，开了 125% 到 150% 显示缩放的笔记本也放得下；最小 880×600。
- **窄窗口**：宽度不到 1100px 时，展开的抽屉浮在对话上面，不再挤压对话。
- **快捷键**：历史面板在 macOS 上是 ⌘K，在 Windows 上是 Ctrl+K，提示文字跟着平台变。
- **启动 dsh**：直接用 Node 运行 dsh 的入口文件，不经过 `.bin/dsh(.cmd)` 包装脚本（Windows 不允许不经 shell 启动 `.cmd`）。不用 Electron 自带的 Node，因为 dsh 只认它列出的几个 Electron 版本。
- **npm 脚本**：用 `cross-env`，在 cmd、PowerShell 里也能跑。

## 架构

```
渲染进程（界面）                主进程                        node dsh/lib/bin.js --profile viva
app.js ── state.js(reducer)     main.js ── acp-bridge.js ──stdio──▶ DeepSeek Harness
   │        selectors.js           │        history-db.js            （ACP v1 JSON-RPC）
   └─ view/*  ◀── preload.cjs ──IPC┘        dsh-profile.js                 └─ plugins/memory（记忆插件）
                                            memory.db ◀──────── 同一个文件 ────────┘
```

- **插件化分层**：模型看到什么、能做什么（记忆、过程记录、工具策略、人设）放在应用自己 profile 里的 dsh 插件中；会话怎么跑留在 ACP；界面和本机数据留在应用。插件和应用只通过带版本号的数据约定协作。详见 [docs/architecture.md](docs/architecture.md)。
- **主进程** 启动 `dsh --profile viva`（应用自己的 profile，见下文「记忆」），用官方 `@agentclientprotocol/sdk` 的 `ClientSideConnection` 说 ACP：`initialize → session/new → session/prompt`，`session/cancel` 停止，`session/close` 开新对话。
- **事件分流**（对应设计稿的「对话不含思考和工具调用」）：
  - `agent_message_chunk` → 对话区
  - `agent_thought_chunk`、`tool_call`、`tool_call_update` → 抽屉「过程」、顶部状态胶囊；读写过的文件进「文件」，抓取的网页进「网页」
  - `session/request_permission` → 对话里的亮蓝确认卡片；你的选择经 `permission-broker` 回给 dsh
- **模型切换**：输入框左下角的选择器，列出 dsh 返回的模型和推理强度（Off / Low / High / Max），通过 ACP 的 `session/set_config_option` 切换，从下一轮生效；回复进行中禁用。
- **流式输出**：回复按打字机节奏逐字显示（基础约 90 字/秒，积压多时自动加速，最多落后约 1.2 秒）。注意：dsh 的 ACP 接口只推送「已完成的整段消息」，不推送模型的逐字增量，所以首字要等整段生成完才出现。dsh 将来若推送增量片段，无需改代码即可逐字显示。
- **滚动**：对话区新内容到来时跟随到底部，但长回复只滚到「最新提问贴近顶部」就停，回答从提问下方往下长，底部出现「↓ 新内容」；你一往上翻就停止自动跟随，滚回底部再恢复。抽屉重绘时保留滚动位置，停在底部时像日志一样跟随最新一步，打开「过程」直接定位到最新。
- **改名（原 my-agent）**：应用原名 my-agent，Electron 按应用名存放数据。改名后首次启动时，会把旧目录里的历史对话、记忆和过程记录**复制**过来，旧目录原样保留作为备份。加密保存的 API key 无法迁移（系统钥匙串的条目按应用名区分），需要在设置里重新填一次，或者用 `DEEPSEEK_API_KEY` 环境变量。
- **历史对话（永久保存）**：全部存在 `~/Library/Application Support/Viva/history.db`，用 Electron 自带的 `node:sqlite`，不依赖原生模块。
  - **存什么**：只存对话区看得到的内容，也就是提问、回复和回执，外加每条消息来自哪个 dsh 会话。思考和工具调用不存。
  - **怎么存**：每轮开始、结束和出错时增量写入，只追加新消息、更新最后一条，不整份重写。
  - **启动时**：自动打开最近一段对话，并用 ACP 的 `session/resume` 接回原来的 dsh 会话。接不回时开新会话，分隔线会写明「助手已不记得这些内容」。
  - **历史面板**：点标题栏的时钟按钮或按 ⌘K，左侧会滑出面板，按「置顶 / 今天 / 昨天 / 7 天内 / 更早」分组。
  - **搜索**：搜索框能搜全部对话的正文和标题，命中处高亮。3 个字以上走 FTS5 trigram 全文索引，更短的退回模糊匹配。
  - **单段操作**：每段对话的 ⋯ 菜单里有重命名、置顶、导出 Markdown、删除。
  - **删除**：删除后底部出现「撤销」，8 秒后彻底清除。数据库开了 `secure_delete`，删掉的文字不会残留在文件里。dsh 自己在 `~/.dsh/sessions` 的日志不会被删。
  - **旧对话的「过程」**：打开旧对话时，从 dsh 自己的日志（`~/.dsh/sessions/…/session.v4.jsonl.zstd`）读回思考和工具调用，读到后回执重新出现「VIEW TRACE」。读不到时，抽屉里会说明原因。
  - **任务进行中**：不能切换到别的对话；切换过程中（新对话、打开旧对话）发送按钮暂时禁用，避免消息落进正在被替换的对话。
  - **旧版迁移**：旧版的 `history/*.json` 会在首次启动时自动导入，旧目录改名为 `history-imported` 留作备份。
- **记忆（dsh 插件）**：记忆整体是 `plugins/memory` 这个 dsh 插件，应用只负责界面。换一种记忆方案，就是换掉这个插件。完整设计见 [docs/memory.md](docs/memory.md)。
  - **profile**：每次启动 dsh 前，`dsh-profile.js` 写好 `~/.dsh/profiles/viva`：dsh 自带的 ACP 组合，加上这个插件（`link:` 依赖、`node_modules` 链接，Windows 上用 junction），并把 `memory.db` 的路径写进插件配置。你自己的 `acp` 等 profile 不会被改动。写不了时退回 `acp` profile，助手照常可用，只是没有记忆。
  - **约定**：插件和应用共用 `memory.db`（`plugins/memory/lib/store.js`）。应用在「关于你」里读写画像和记忆，把使用习惯写进去；插件写入它记下的内容、每个会话的检索状态，以及每轮带上了什么。
  - **三层检索**：① 记忆规则、画像、偏好、使用习惯，在会话第一轮、内容变化后、以及 dsh 压缩对话之后各带一次，不检索；② 你自己的话里提到画像或记忆里的人名、项目名、系统名时，带上相关的记忆，最多 3 条，同一会话不重复；粘贴的长文本只看首尾你自己写的那几行，「那第二个呢」这类追问会结合上一个问题；③ 其余由模型自己用 `memory_recall` 带关键词查，查不到就返回空。
  - **工具**：`memory_remember`（带关键词）、`memory_recall`、`memory_update_profile`、`memory_forget` 是 dsh 原生工具，不弹确认卡片。密码、密钥、验证码、证件号会被拒绝保存。
  - **怎么更新**：你明确说「记住…」「以后…」时，模型当场调用工具保存。每轮结束后，插件还会在后台再调一次模型，补记漏掉的信息，或把被新信息推翻的旧记忆标为失效。后台的结果由代码把关：只能新增，或让它看过的记忆失效；你自己写的记忆它不能动；任何一处不合格，整批都不写入。闲聊会被简单规则过滤掉，不触发这次调用。
  - **画像**：画像字段只由你填写，模型不能改；模型学到的身份、人、项目、偏好都记成记忆。插件每轮结束后检查一次：画像类记忆有变化，并且距上次整理超过 24 小时或已经积累了 5 处改动时，就用模型把有效记忆重新整理成「助手整理的画像」。整理只看当前有效的记忆，所以失效的旧事实会从画像里消失。两次整理之间新增的记忆，会作为「最近了解到的」直接附在画像后面。整理结果格式不对或含敏感信息时不保存，继续使用上一版。旧版本里模型写进画像字段的内容，首次启动时会迁移成记忆。
  - **失效而不删除**：被取代或被要求忘掉的记忆只是标为失效，不再参与检索，「关于你」里的「已失效」可以看到原因并恢复。只有你在页面上点删除，才会真正删掉。
  - **日期**：每次带上下文都附上今天的日期，同一会话跨天会再发一次，模型据此把「下周一」写成具体日期。
  - **看得见**：每轮带上了哪些记忆、为什么，显示在「过程」里；助手记下的内容会弹出「已记住」。插件加载失败时 dsh 照常工作，设置页会显示「记忆插件没有加载」。
- **状态** 全部在 `state.js` 的纯 reducer 里不可变更新；视图只读 `selectors.js`，所有文本都走 `textContent`。
- **安全**：`contextIsolation` + `sandbox`，preload 只暴露 20 个方法和平台名，主进程校验 IPC 入参（包括渲染进程提交的历史消息），页面有 CSP。

## 测试

```bash
npm test            # 185 个单元 / 集成测试，用 Electron 自带的 Node 运行，和应用的运行时一致
npm run coverage    # 覆盖率
npm run smoke       # 真的启动 Electron，分四次：
                    #   setup：没有 key，检查引导卡片、输入框禁用、按钮能打开设置；
                    #   walkthrough：模型菜单、流式输出、标题栏布局（macOS 和模拟的 Windows，各在正常宽度和最窄 880px 下检查
                    #     胶囊居中、不和按钮重叠，窄窗口抽屉浮层）、确认卡片、长任务滚动、设置面板；
                    #   relaunch：同一份数据再启动，检查上次的对话完整回来、助手接回会话，再走一遍历史面板
                    #     （⌘K、第二段对话、搜索高亮、打开旧对话、重命名、删除和撤销）；
                    #   memory：真实的 dsh 加记忆插件，配假模型：引导、「记住」、关于你页面里的关键词、
                    #     提到名称时带上记忆、「过程」里的「带上记忆」、设置页的插件状态
```

- **数据隔离**：smoke 用 `smoke/userData` 作为独立的数据目录，不会碰你自己的历史记录和 key。
- **假模型**：记忆相关的测试和 smoke 用真实的 dsh，把 `DEEPSEEK_BASE_URL` 指向 `test/fixtures/fake-llm.js`。它记录 dsh 发给模型的每个请求，并按固定规则回复（「记住：…」会调用 `memory_remember`），不需要 key。
- **假 dsh**：其余 smoke 和集成测试里的 dsh 换成 `test/fixtures/fake-dsh.js`。它讲真实的 ACP 协议，按固定剧本回复：提问里带「长任务」会连续调用 16 次工具，再输出长回复。这样走的是和真实使用完全相同的代码路径，只是不调用模型。应用里没有演示模式。

## 已知限制

- `@deepseek-ai/dsh` 还是 0.2.0-rc，官方说明会有不兼容改动；ACP profile 是「自动化」定位，不提供 plan、todo 等 DSH 专有界面数据。
- 「邮件」页是占位：需要通过 MCP 服务器接入（`session/new` 的 `mcpServers`）。
- 「网页」页目前只列出抓取过的地址，还没有嵌入实时网页画面和「我来接管」。
- 聊天内容以明文保存在本机（key 是加密的）。
- 旧对话的「过程」依赖 dsh 私有的 v4 日志格式，dsh 升级后可能读不出来；读不出时只是不显示过程，对话本身不受影响。
- 测试必须用 Electron 自带的 Node：系统 Node 24.14 的 zstd 只能解开多帧文件的第一帧，而 dsh 的日志正是多帧的。
- 记忆插件依赖 dsh 的插件接口，插件声明的 dsh 版本是精确的 `0.2.0-rc.2`，升级 dsh 时要同步更新 `plugins/memory/package.json`，否则 dsh 会拒绝加载插件（对话不受影响，只是没有记忆）。
- 记忆插件还没在 Windows 上验证（junction 链接、路径写入 YAML）。对话压缩后重新带上画像的逻辑有单元测试，但还没在真实 dsh 里触发过压缩来验证。
- Windows 已在真实的 Windows 11（x64，4K 屏）上跑通全部单元测试和三个阶段的 smoke（记忆插件改造之前）；系统窗口按钮本身由系统绘制，页面截图拍不到，需要人工看一眼。真实 dsh 和模型在 Windows 上的对话还没验证（需要 key）。
- 字体从 Google Fonts 加载，离线时回退到系统字体。

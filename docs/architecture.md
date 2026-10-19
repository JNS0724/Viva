# 架构：在 dsh 插件体系上解耦

本文说明 my-agent 如何借助 DeepSeek Harness（dsh）的插件体系分层：哪些能力放进 dsh 插件，哪些留在 ACP 协议层，哪些留在 app；插件和 app 之间靠什么约定协作；以及几个经过验证但没有采用的方案。记忆插件的细节见 [memory.md](memory.md)。

## 1. 分层原则

| 层 | 管什么 | 例子 |
|---|---|---|
| **dsh 插件**（app 自己的 profile 里） | 模型看到什么、能做什么：上下文、工具、执行前的策略、后台的模型调用 | 记忆、过程记录、工具策略、人设 |
| **ACP**（与具体 agent 无关） | 会话怎么跑：生命周期、流式输出、授权请求、MCP 服务器声明 | 用户的 MCP 服务器、确认卡片 |
| **app**（Electron） | 人怎么看、怎么改：界面、本机数据管理、系统集成 | 「关于你」、历史对话、key（系统钥匙串） |

**判断标准：只有必须介入 agent 内部才能做好的能力，才写成 dsh 插件**，比如每一步之前的注入、和会话绑定的状态、不弹授权的原生工具、复用 agent 的模型、工具执行前的拦截。其余能力留在 ACP 或 app。原因有两个：

- dsh 还是 0.2.0-rc，插件用到的都是它自己的接口；
- 每多一个插件，app 就离「换成别的 ACP agent 也能用」更远一步。

插件和 app **不互相调用**，只通过各自的数据约定（SQLite 文件）协作。

## 2. 组成

```
app（Electron 主进程）                                   dsh 进程：--profile my-agent
┌─────────────────────────────────────┐                ┌───────────────────────────────────────────┐
│ app-plugins.js  人设 + 插件清单       │                │ system-prompt  ← 人设（profile patch）      │
│                 兼容性检查            │── 写 profile ─▶│ my-agent-memory  上下文 / 记忆工具 / 后台   │
│ dsh-profile.js  写 ~/.dsh/profiles/  │                │ my-agent-trace   每轮步骤 → trace.db        │
│ acp-bridge.js   ACP 会话、MCP 声明    │── ACP stdio ──▶│ my-agent-policy  工具执行前拦截             │
│ 「关于你」「过程」「设置」             │                └──────────────┬────────────────────────────┘
└──────────────┬──────────────────────┘                               │
               └────── memory.db（约定 memory@1）、trace.db（约定 trace@1）
```

| 插件 | 约定 | 插件写 | app 读 / 写 |
|---|---|---|---|
| `my-agent-memory`（`plugins/memory`） | `memory@1`：`memory.db` | 记忆、会话状态、注入记录、画像整理 | 「关于你」读写画像和记忆，写使用习惯；读注入记录用于「过程」 |
| `my-agent-trace`（`plugins/trace`） | `trace@1`：`trace.db` | 每轮的思考和工具调用 | 重新打开对话时读，用于「过程」 |
| `my-agent-policy`（`plugins/policy`） | `policy@1`：无数据，只有行为 | — | — |

人设不是插件，而是 profile patch 里 `system-prompt` 的 `personaPrefix` 和 `personaSuffix`，定义在 `src/main/app-plugins.js` 的 `PERSONA`。

## 3. 插件清单与约定版本

- **清单**：`src/main/app-plugins.js` 的 `APP_PLUGINS` 列出每个插件的名字、目录、要提供的约定，以及配置（例如数据文件放在 userData 的哪个位置）。
- **声明**：插件在自己的 `package.json` 里写明提供的约定，例如 `"myAgent": { "contract": { "memory": 1 } }`。
- **启动前检查**（`resolvePlugins`），任何一项不通过，这个插件就**不写进 profile**，原因显示在设置页：
  - 插件存在，`package.json` 可读，名字和清单一致；
  - 提供的约定版本等于 app 需要的版本（`CONTRACTS`）；
  - 用精确版本声明的 dsh 依赖，必须等于当前安装的 dsh 版本，否则 dsh 自己也会拒绝加载。
- **数据文件也记录版本**：`memory.db` 和 `trace.db` 的 `meta.contract_version` 记录写入时的约定版本。遇到更新版本写入的文件会直接报错，而不是误读。
- **替换插件**：写一个提供同名约定、同一版本的插件，在清单里替换掉原来的即可，app 的其余部分不用改。

## 4. profile 的写法

`src/main/dsh-profile.js` 在每次启动 dsh 前写好 `<DSH_HOME>/profiles/my-agent`，只写有变化的文件：

- 组合包和 dsh 自带的 `acp` 模板相同；
- `cordis.patch.yml` 写入 `system-prompt`（人设前后缀，按 id 打补丁会整体替换配置，所以两部分都要写）和每个插件的插入项与配置；
- 每个插件以 `link:` 依赖加 `node_modules` 链接挂入（Windows 用 junction）；
- 清单里已经没有的 `my-agent-*` 插件，链接和依赖都会被移除，dsh 就不再加载它。

用户自己的 profile 不会被读写。profile 写不了时，退回 dsh 自带的 `acp` profile，助手照常可用，只是没有 app 的插件和人设。

## 5. 各插件的 dsh 接口

| 插件 | 用到的 dsh 接口 |
|---|---|
| memory | `agent/pre-step`（注入）、`sessionProjections`（统计压缩次数）、`tools.register`（原生工具）、`agent/turn-stopping` + `llm.stream`（后台提取、画像整理） |
| trace | `agent/turn-stopping`，并读取 `session.eventAt` 拿到本轮事件 |
| policy | `tools/pre-execute`（先于授权执行，返回 `deny` 时附带给模型看的原因） |

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
| **顺带修复** | 记忆插件取助手回答的路径写错了（`assistant/message` 的正文在 `data.message` 下面），后台提取之前一直看不到助手的回答，已修复并加了测试；画像类记忆失效时立即重新整理画像，不再等 24 小时 |

## 7. 测试

- **真实 dsh + 本地假模型**（`test/fixtures/dsh-harness.js`）：用 app 真实的插件清单和人设写 profile，模型请求发给 `test/fixtures/fake-llm.js`。
  - `test/memory-plugin.test.js`：记忆和人设；
  - `test/trace-plugin.test.js`：「过程」记录，以及 app 不依赖 dsh 日志也能读回来；
  - `test/policy-plugin.test.js`：用假邮件 MCP 服务器（`test/fixtures/mail-mcp.js`）证明发送被拦下、没有发出去，起草照常。
- **插件清单**（`test/app-plugins.test.js`）：约定版本不对、dsh 版本不对、找不到插件时，都会被排除并给出原因；数据文件拒绝更新版本写入的内容。
- **profile 写入**（`test/dsh-profile.test.js`）：人设、多个插件和配置、移除已下线插件、不覆盖无法读取的文件。

## 8. 还没做的

- **把记忆规则放进系统提示词**：现在【记忆规则】随固定层作为 user 消息发送。dsh 的 `system-prompt` 支持插件注册自己的提示词段，放进去可以利用前缀缓存、减少重复。需要先确认注册接口。
- **更多工具策略**：例如工作区外写文件（dsh 的沙箱已经限制）、敏感目录读取。等有了明确需求再加。
- **邮件和 IM 分拣**：沿用同一套做法，在插件里实现，「只起草」已经由策略插件保证。定时分拣可以评估 dsh 的 `schedule` / `jobs` 插件。
- **事件推送**：等 dsh 的 ACP 实现开放扩展通知后，用推送代替轮询。

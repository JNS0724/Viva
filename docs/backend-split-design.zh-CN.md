# 设计：前后端拆分、事件内核与插件开放（P0）

[English](backend-split-design.md) | 简体中文

> 状态：**设计稿，待评审。** 本文是目标架构和分阶段计划，不描述现状；现状见 [架构](architecture.zh-CN.md)。各阶段落地时，同步改写架构文档里对应的部分。日期：2026-11-04。

## 1. 目标与范围

| 做 | 不做（另行立项） |
|---|---|
| 把 Electron 主进程拆成「桌面外壳」和「后端」，先在同一进程内划清边界，再拆成两个进程 | 后端在应用退出后继续运行（开机自启、外壳不在时的通知、崩溃恢复） |
| 后端内部改为事件驱动：一切输入成为信号，状态变化经单一写入口落成带序号的事件 | 后端上云、远端 workspace（见 [远期调研](remote-workspace-research-20261104.zh-CN.md)） |
| 开放 dsh 插件加载，让用户复用 dsh 的插件生态 | 在 Viva 里运行 dsh 的 Web 客户端，或支持插件的 Web 界面部分 |
| 删除消息源能力 | 连接器（消息源的通用化方案已放弃） |

参考：前后端的进程边界和接口风格参考 dsh-personal-agent 的核心架构（§6 进程边界与接口风格）；事件驱动参考其信号、路由与 `apply` 的语义，但不照搬它的确认关卡和信件。

## 2. 目标架构

```
渲染进程（窗口、桌面岛）
   │  preload 暴露的 API 不变；zod 契约（ipc-contract.ts）照旧校验
   ▼
桌面外壳（Electron 主进程）
   │  窗口、托盘、菜单、桌面岛、系统通知、对话框、shell、开机启动、电源事件
   │  P3 起：只转发后端通道，自己只处理外壳通道
   ▼  P3 前：函数调用；P5 起：本机回环 HTTP + SSE，启动时生成令牌
后端（不依赖 Electron）
   │  会话与 dsh 生命周期、历史、任务、记忆、跟进、后台准备、模型、扩展、插件管理
   │  事件内核：信号 → 路由 → apply → 事件表（带序号）→ 推给外壳
   ▼  ACP over stdio + 插件 IPC 通道（不变）
dsh（profile viva：dsh-base + acp-app + 用户插件 + Viva 插件）
```

## 3. 决定

| # | 决定 | 理由 |
|---|---|---|
| D1 | 后端是一个不导入 `electron` 的模块树，入口 `src/backend/compose.ts`；外壳入口 `src/shell/main.ts` | 现在 94 个主进程文件里只有 8 个直接导入 electron，业务模块已经通过依赖注入拿到 Electron 能力，边界基本现成 |
| D2 | 外壳与后端之间只通过 `HostCapabilities`（§5）和后端通道交互 | Electron 能力集中在一个接口里，后端可单独测试，也是以后拆进程、拆机器的接缝 |
| D3 | 后端通道沿用「请求—应答」：`IpcRegistry.handle(channel, fn)` 的形状不变，换的是传输 | 117 个通道已经有 zod 契约和 `registerXxxIpc(ipcMain, deps)` 注册方式；改成 dsh-personal-agent 那种「命令只回受理、结果走事件」会改动每个调用方，收益不足以抵消 |
| D4 | 后端推给外壳的一切走一条事件流，每条带单调递增的序号；断线按序号补推。流式输出的片段只推送、不入事件表 | 现在推送已经集中在 `agent:event` 一个通道（约 30 种 `type`），加上序号就能直接映射到 SSE |
| D5 | 传输：P5 用本机回环 HTTP（`POST /rpc/:channel`）+ SSE（`/events?since=seq`），启动时生成令牌；二进制先上传成 blob 再传 id | 与 dsh-personal-agent §6 一致，以后上云只换成 HTTPS + 账号令牌；不选 `utilityProcess` + MessagePort，因为它只能在本机 |
| D6 | 前后端之间不传本地路径，传内容或 blob id。例外只有「本机能力组」（§4 第 3 类），它们在接口上单独成组 | 远期调研的约束；本机阶段不影响功能，以后接远端 workspace 不用再拆 |
| D7 | 后端内部事件驱动（§6）：信号是闭合的联合类型，路由先用代码，状态变化统一经 `apply` | 现在的触发靠 main.ts 用回调逐个通知模块；统一成信号后可穷举、可记录、可重放 |
| D8 | 开放 dsh 插件（§7）：Viva 的配置移到 home 级 patch，Viva 插件改用 file URL 加载，打开 HMR，自带 pnpm 11 | 三次验证的结论；用户可复用宿主侧插件（搜索、上下文压缩等） |
| D9 | 删除消息源（§8） | 插件生态里已有更完整的同类能力（如 IM 接入）；消息源的契约、kit 和判断链路维护成本高 |

## 4. 通道清单

117 个调用通道按去向分四类。外壳推给渲染进程的另有 5 个通道：`agent:event`、`language:changed`、`composer:focus`、`island:view`、`island:action`。

| 类 | 去向 | 通道 |
|---|---|---|
| 1 后端 | 后端，直接转发 | `language:get/set`；`agent:*`（9）；`models:*`（3）；`history:*` 除 `export`（21）；`timeline:*`（4）；`task:*`（12）；`memory:*` 除 `add-docs`（10）；`followups:*` 除 `suggestion`（9）；`ext:get/remove-mcp/update-mcp/remove-skill`；`settings:get/save-key/clear-key/set-permission`；`images:usage/clear` |
| 2 外壳 | 外壳自己处理 | `shell:open-link`；`settings:set-desk-island/set-open-at-login/reset-desk-place`；`island:view/act`；`files:reveal/apps/open`；`workdir:reveal`；`images:open-folder` |
| 3 本机能力组 | 后端的单独一组（D6 的例外） | `workdir:get/switch/forget`；`files:list/preview/image/watch`；`island:files`；`ext:import-dsh`；`images:keep`、`island:keep-image`（二进制，P5 改为 blob 上传） |
| 4 混合 | 外壳先弹对话框，再调后端 | `workdir:choose`、`memory:add-docs`、`history:export`、`images:move` |
| — | 随消息源删除 | `sources:*`（9）、`followups:suggestion` |

`island:ask` 归第 1 类（经后端发起对话）。`settings:save-key` 需要加密，后端通过 `HostCapabilities.secrets` 完成。

## 5. 宿主能力接口

从 `main.ts` 现有的注入点归纳，后端只能通过它使用 Electron：

```ts
interface HostCapabilities {
  paths: { userData: string, documents: string, appData: string }
  secrets: { available(): boolean, encrypt(text: string): Uint8Array, decrypt(data: Uint8Array): string }  // safeStorage
  dialogs: {
    chooseFolder(options: FolderOptions): Promise<string | null>
    chooseFiles(options: FileOptions): Promise<string[]>
    saveFile(options: SaveOptions): Promise<string | null>
  }
  shell: { openExternal(url: string): Promise<void>, openPath(path: string): Promise<string>, trash(path: string): Promise<void> }
  notify(notice: { title: string, body: string, action?: string }): void
  power: { idleSeconds(): number, onWake(listener: () => void): () => void }   // resume、unlock-screen
  window: { inFront(): boolean, focusComposer(): void, showTasks(): void }
}
```

- 对话框返回本地路径，只在第 3、4 类里使用。
- P5 拆成两个进程后，这些调用变成后端发给外壳的反向请求；两个进程同生同死，所以外壳总在。
- 后端在外壳不在时如何运行，属于「后端独立运行」，不在本次范围。

## 6. 事件内核

### 6.1 信号

一切输入都成为不可变的信号。信号种类是闭合的联合类型，路由映射缺一项即类型检查失败。第一版的信号种类从现有触发点整理而来：

| 种类 | 现在由谁触发 | 路由去向 |
|---|---|---|
| `chat.said`（用户消息、引用、图片） | `agent:prompt` | 直接进 dsh 会话，不经模型分类 |
| `user.*`（跟进的接受、拒绝、忽略、继续、立即准备、叫醒、设时段、暂停；任务、记忆、设置操作） | 各 `*-ipc.ts` | `command`：代码处理 |
| `agent.followup_proposed` | `viva-followups` 插件经 IPC | 生成建议卡片，等用户决定 |
| `agent.turn_ended`、`agent.started` | ACP 会话、任务注册表 | 空档判断；后台准备让路 |
| `clock.reminder_due` | `followup-notifier` 的定时器 | 通知计划（`notice-plan`） |
| `clock.prepare_window` | `prepare-scheduler` | 后台准备 |
| `system.woke` | `powerMonitor` resume、unlock-screen | 补发错过的提醒（只补发，不补做） |
| `system.user_returned` | 离开 15 分钟后回来（`createGapWatch`） | 空档 |
| `window.foreground` | 窗口回到前台 | 空档 |

- 路由第一版全部是代码：命令 → 规则 → 节律（空档、每日打扰上限）。模型分类这一步保留位置，但消息源删除后暂时没有需要它的信号。
- 以后给插件开一个「向 Viva 发信号」的接口时，插件就作为一种输入源接入，不改路由结构。

### 6.2 `apply` 与事件表

- `apply(event)` 是后端状态的唯一写入口：同一事务里追加事件、更新业务表。事件序号即 D4 的推送序号。
- 范围只包括后端自己的状态。`memory.db`、`trace.db` 由 dsh 进程里的插件写入，以观察到的信号进入（如 `memory.changed`），不经 `apply`。
- 后端自己的数据现在分散在 `followups.db`、历史库、任务存储和几个 JSON 设置文件里，跨库写入无法做到原子。**已定：合并成一个 app 数据库。** P4 先建这个库和事件表，各业务表随迁移批次并入。

## 7. 插件开放

### 7.1 profile 分层

| 层（后者优先） | 归谁 | 内容 |
|---|---|---|
| 组合包 | dsh 与用户安装的插件 | dsh-base、acp-app、第三方组合包 |
| profile `cordis.patch.yml` | 插件管理器与用户 | 启停开关；Viva 不再写这个文件 |
| home 级 `$DSH_HOME/cordis.patch.yml` | Viva，每次启动重写 | 人设、模型、viva-* 插件行、`hmr` 打开，以及 Viva 依赖的 dsh 自带安全相关行（`approval`、`permission`、`sandbox-policy` 等）的完整重述 |

验证过的要点：

- **用户开关保留**：Viva 重启不会冲掉用户的开关；用户层改不掉 `viva-policy` 和人设。
- **插件用 file URL 加载**：Viva 插件行的 `name` 写成入口文件的 file URL，profile 的 `package.json` 里不再声明 Viva 插件。否则 pnpm 每次安装都会把 `viva-*` 转发包换成符号链接，在打包后的 `app.asar` 里失效。
- **HMR**：`dsh-acp-app` 把 `hmr` 关掉了，Viva 在 home 级 patch 里要写 `disabled: false`。按 id 打补丁只替换 `config`，会保留下层的 `disabled`。打开后运行中启停插件即时生效，ACP 不受影响。
- **自带 pnpm 11**：插件管理器靠 pnpm 安装；用户电脑上通常没有。用 Electron 内置的 Node 运行，经插件管理器的 `pnpmCommand` 指定。

### 7.2 插件页与对话里的安装

- **安装来源**：npm 包名、git、本地文件夹。显示实际装上的版本：验证中 dsh 和 pnpm 选了比最新版旧的版本。
- **启停与卸载**：Viva 的行不可启停。
- **状态与诊断**：未激活的条目和原因（dsh 只在 stderr 打一行，如 `pending (waiting for service: connection)`）、版本不兼容和豁免、依赖构建脚本的批准。
- **影响面**：每个插件带来的工具数量。第三方组合包改了 dsh 自带的哪些行（如 `billion-context` 会整体替换 `llm-deepseek` 的 `config`）。
- **提示**：插件带 `dsh.client` 时，提示「界面部分在 Viva 里不可用」。与 `viva-memory` 等功能重叠时（例如其他记忆插件），提示冲突。
- **对话里安装**：沿用 `viva_mcp_add`、`viva_skill_install` 的做法，经审批卡片完成。

### 7.3 信任模型

插件在 dsh 进程内拥有用户的全部权限。它能读到模型 key（以环境变量交给 dsh），能读写 `memory.db`，能用用户的 key 调模型，也能注册 `tools/pre-execute` 钩子绕过 `viva-policy`。分层只能保护配置，挡不住运行时的行为。所以安装即完全信任，安装确认页要写明。

### 7.4 生态的实际可用面

下载量前 60 的插件里，54 个带 Web 客户端部分。大致分三类：

| 类 | 例子 | 在 Viva 里 |
|---|---|---|
| 纯 Web 界面（皮肤、桌宠、侧栏、市场、面板） | `dsh-pet`、`dshmarket`、`dsh-better-sidebar` | 无用 |
| 宿主侧功能 + 设置页 | `billion-context`、`dsh-free-search`、视觉、记忆、模型接入 | 宿主侧可用；设置页需要 Viva 的通用设置表单（由插件的 `Config` schema 生成，读取 schema 会导入插件代码，须在用户信任之后） |
| 依赖 Web 界面完成配置或渲染 | `@xmanrui/dsh-im`（扫码绑定）、`dsh-genui` | 不可用。`dsh-im` 在 ACP 下一直挂起，等待 Web 客户端的 `connection` 服务 |

验证结果：`billion-context` 加载后多出 6 个工具，`dsh-free-search` 多出 9 个，运行中关闭插件会撤下它的工具。尚未验证：工具实际调用的效果，以及打包后从 `app.asar` 加载 file URL。

## 8. 删除消息源

**整体删除**：

- `src/main/` 下：`source-check`、`source-contract`、`source-folders`、`source-install`、`source-poller`、`source-run`、`source-settings`、`sources-db`、`sources-ipc`、`sources-main`、`message-judge`、`message-reader`、`messages-channel`；
- `src/renderer/` 下：`source-actions`、`source-state`、`view/sources`；
- `plugins/messages`、`packages/viva-source-kit`、`scripts/build-source-kit.mjs`、`tsconfig.kit.json`；
- `docs/sources*.md`、`docs/images/sources.png`、`docs/images/suggestion.png`；
- 对应测试：`message-judge*`、`message-batch-completeness`、`message-reader`、`message-sources`、`source-install`、`source-kit`、`source-poller`、`source-run`、`test/fixtures/sources/`、`test/smoke/smoke-sources.ts`、`test/smoke/live-scenarios-sources.ts`；`test/followup-plugin.test.js` 里判断新消息的那个用例。

**消息建议随之删除**：跟进里的「建议」（`suggestions` 表）只由 `message-judge` 写入。删掉的有：`followup-store` 的 `addSuggestion`、`getSuggestion`、`listSuggestions`、`settleSuggestion`、`mutedSenders`、`recentDecisions` 和 `suggestions` 表；`followups:suggestion` 通道；通知里对未处理建议的计数；`prepare-materials` 里取消息原文的部分；界面上的建议卡片。**保留**：对话里模型提议的跟进卡片，以及给它去重用的 `declinedSince`（读的是 `suggest_declined` 事件）。

**需要修改**：
- 主进程：`main.ts`、`app-plugins.ts`（移除 `viva-messages` 及其约定）、`acp-bridge.ts`、`automation-driver.ts`、`ipc-contract.ts`、`followups-main.ts`、`followups-ipc.ts`、`followup-store.ts`、`followup-notifier.ts`、`prepare-scheduler.ts`（准备批次里先判断新消息的那一步）、`prepare-materials.ts`；
- preload 与渲染进程：`preload.cjs`、`globals.d.ts`、`state.ts`、`followup-state.ts`、`followup-actions.ts`、`view/followups.ts`、`view/settings.ts`；
- 文案与文档：i18n 两份文案、README 两份、features、architecture、internationalization、`docs/i18n-manifest.json`；
- 脚本与测试：`scripts/check-i18n.ts`（必查清单里有 kit 的 README）、`test/app-plugins.test.ts`、`test/fixtures/fake-llm.js`、`test/followup-plugin.test.js`、`test/smoke/hooks.ts`、`test/smoke/smoke-kit.ts`、`test/source-report-registration.test.ts`（只是测试数据里写了 kit 的 README 路径）。

**保留，名字只是碰巧**：`build/icons/viva-source.png` 是应用图标的原始图稿；`test/source-report-registration.test.ts` 测的是文档的 `sourceReports` 登记；记忆和自我介绍里的 `sources` 字段指用户的资料来源。`docs/releases/` 里的历史发布说明保留不改。

**产品影响**：「新消息 → 判断 → 建议跟进」的链路去掉；对话里产生的跟进、后台准备、提醒不受影响。

**不做兼容**：升级后不读取、不迁移、也不清理旧数据（用户已安装的消息源、`sources.db`、`source-data/`、`source-settings.json`），不写任何兼容代码。

## 9. 分阶段计划

每个阶段可单独评审、单独合并。P3、P5 属于 AGENTS.md 所说的重大架构变更，提 PR 前要本地跑 `npm run build` 和 `npm run smoke`。

| 阶段 | 内容 | 验收 |
|---|---|---|
| **P0** | 本文 | 评审通过 |
| **P1 删除消息源** | §8 | 测试与冒烟测试通过；i18n 检查通过；README 和 features 不再提消息源 |
| **P2 插件开放** | §7：profile 分层、file URL、HMR、自带 pnpm、插件页、对话里安装、信任提示 | 用 dsh 真实安装宿主侧插件：重启后开关保留，Viva 的行改不掉，运行中启停生效；打包产物上验证 asar 加载；新增的 state 和 actions 有单元测试 |
| **P3 进程内拆分** | D1、D2、§5：拆出后端组装入口和外壳；后端不导入 electron；外壳只转发后端通道 | 行为不变；新增测试保证 `src/backend` 不导入 electron；冒烟测试在 macOS 和 Windows 上通过 |
| **P4 事件内核** | §6：信号、路由、`apply`、事件表，按「跟进链路 → 定时器和空档 → 对话和界面操作」分批迁移 | 每批迁移前后行为一致；事件序号连续；推送带序号 |
| **P5 拆成两个进程** | D4、D5：后端成为子进程，HTTP + SSE，令牌，blob 上传，宿主能力的反向请求 | 冒烟测试通过；重测新话题预热和流式首段延迟（见现有性能报告），回退幅度在 PR 里写明 |

## 10. 风险与待定

| 项 | 说明 | 建议 |
|---|---|---|
| 后端数据库 | 后端状态分散在多个库和 JSON 文件，`apply` 无法跨库原子写入 | **已定**：合并成一个 app 数据库（§6.2）。每批迁移要写数据迁移，并测试从旧库升级 |
| 延迟 | P5 多一跳 HTTP，可能影响流式输出和新话题预热 | P5 验收时对比现有性能报告的数据 |
| dsh 版本 | Viva 固定在 0.2.0-rc.2，npm 最新是 0.2.1-rc.5；生态插件声明兼容 rc.2 的很少 | P2 之后单独评估升级 dsh；升级时插件页报告被跳过的插件 |
| 插件改写 dsh 自带的行 | 第三方组合包能改 `llm-deepseek`、预设、压缩等行 | home 级 patch 重述 Viva 依赖的行；插件页显示每个插件改了哪些行 |
| 插件安全 | 进程内插件不受约束（§7.3） | 安装确认页写明；不承诺隔离 |
| HMR 与 Viva 自己的改写 | Viva 运行中改设置（如模型）会重写 home 级 patch，HMR 会即时重组，不再需要重启 dsh | P2 里验证会话在重组时不中断 |

## 11. 参考

- [架构](architecture.zh-CN.md)：现状。
- [远期调研：workspace 作为可替换的执行环境](remote-workspace-research-20261104.zh-CN.md)。
- 验证代码只保存在本地，没有进仓库：`spike/remote-workspace/`、`spike/plugin-layering/`。

## 12. 实施记录

按阶段记录实际做法和与上文的偏差。

| 阶段 | 实际做法 | 与设计的偏差、没覆盖的 |
|---|---|---|
| P1 | 按 §8 删除；跟进卡片的「建议」入口一并删除；`task-background` 实景场景移到 `test/smoke/live-scenarios-tasks.ts` | 旧库里的消息源数据不迁移、不清理（已定：不做兼容） |
| P2 | Viva 的行写在 `$DSH_HOME/viva.patch.yml`，用 `--patch` 叠在最上层；profile 自己的 `cordis.patch.yml` 留给插件管理器；pnpm 11.28.10 随包附带，由 Electron 以 node 身份运行（`src/main/pnpm-launcher.ts`） | 对话里的安装走 dsh 自带的 `tool-plugin-manager`，没有单独的确认卡片；Windows 打包产物没有在本地验证 |
| P3 | 后端组装入口 `src/backend/compose.ts`，宿主能力接口 `src/backend/host.ts`；`test/backend-boundary.test.ts` 检查后端模块树不在运行时导入 electron | 外壳入口留在 `src/main/main.ts`，没有搬到 D1 写的 `src/shell/main.ts`：搬目录只改路径，打包配置、冒烟测试和文档都要跟着改，收益不抵成本 |
| P4 | `src/backend/app-db.ts` 建 `app.db`（`app_events`、`meta`），跟进的三张表从 `followups.db` 迁入，旧文件改名为 `.migrated` 留存；`src/backend/event-core.ts` 实现信号、路由、`apply`、`since`；跟进的写操作、提醒和准备的定时器、空档检测、唤醒、窗口回到前台、对话输入、轮次和任务结束都改走信号 | 历史记录、任务、记忆还没迁进 `app.db`，它们的写操作没有事件；设置页等其余界面操作仍是直接 IPC；信号只记录种类和形状，不记录用户说的话 |
| P5 | 后端是 Electron 以 Node 身份跑的子进程（`src/backend/server.ts`），外壳用 `src/main/backend-client.ts` 启动它。启动消息走子进程的 IPC 通道（令牌、数据密钥、旧密文的明文、后端同步读的桌面状态），之后全走回环 HTTP：页面的通道 `POST /rpc/<channel>`，外壳自己的调用 `POST /control/<op>`，字节先 `POST /blob` 再按 id 传，图片 `GET /image`；后端要桌面做的事走 SSE（`GET /events?since=`），要回答的用 `POST /host/<id>` 回。每个调用带序号，后端按外壳发出的顺序开始执行（不等前一个结束），和原来 ipcMain 的语义一致。钥匙串只在外壳：后端用外壳给的数据密钥做 AES-256-GCM（`src/backend/envelope.ts`），旧版用 safeStorage 加密的值由外壳在启动时解开交给后端，下次写入时换成新格式。窗口是否在前台、用户空闲多久、快捷键状态由外壳推给后端（镜像），空闲时间每 15 秒推一次 | 外壳在主进程里校验一遍参数，后端再校验一遍。后端意外退出时外壳提示并退出，不重启后端；SSE 断开后的补发（`since`）协议有了，但同生共死下外壳不重连。窗口推送和调用的回答走两条连接，理论上可能乱序，冒烟测试没有发现。Windows 没有在本地验证。拆开时冒烟测试抓到三处只在跨进程后才出现的问题，已修：JSON 把省略的参数变成 null（现在保留为 undefined）；服务端 5 秒关掉空闲连接，客户端复用时请求丢失、后面的调用全被它的序号挡住（现在服务端不关空闲连接，复用失败重发一次，缺的序号 5 秒后跳过）；桌面小岛页面等语言时漏掉了先到的视图（现在先收下）。性能（macOS，本机）：调用往返 p50 0.05 ms、p95 0.1 ms；266 KB 的回答往返 p50 2.6 ms；推送每条约 0.02 ms。`--project=performance` 三次对比 P3：回顾打开 16–27 ms（P3 26），200 KB Markdown 29–31 ms（P3 22），远处的消息 9–15 ms（P3 6），滚动 p95 18.1–18.8 ms（P3 18.3）；Markdown 和远处的消息多了约一帧，原因是大回答多了 2–3 ms 的往返，测量按帧轮询，都在预算（150 ms）内 |
| C1 | 不做兼容（已定）：删掉跟进从 `followups.db` 迁入、旧 JSON 历史导入、从旧应用名的数据目录拷数据、从用户 `~/.dsh` 搬会话和技能、对旧版写进 dsh profile 的内容的清理（旧的层、`link:` 依赖、`node_modules/viva-*` 转发包）、记忆库补列和画像迁移，以及读取旧版直接用钥匙串加密的 key（启动消息不再带它们） | 旧版保存的 key 要重新填；`followups.db` 里的跟进和旧 JSON 历史不会带过来 |

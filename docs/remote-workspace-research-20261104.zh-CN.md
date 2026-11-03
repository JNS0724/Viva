# 远期调研：workspace 作为可替换的执行环境（2026-11-04）

[English](remote-workspace-research-20261104.md) | 简体中文

> 状态：**远期规划，暂不实施。** 本文记录一次验证的结论，供前后端拆分之后、后端上云时参考。当前的架构重构不依赖本文。

## 1. 问题

后端以后可能上云，但 Viva 是桌面 agent：读写文件、跑 bash、启动用户的 MCP 服务器，都默认在用户的电脑上。设想是把 workspace 做成可替换的后端：可以是本机，可以是云端容器，也可以是云端后端通过一个本地节点回连用户电脑。

## 2. dsh 已有的接口

dsh 0.2.0-rc.2 按「执行环境」（execution world）抽象了三层，各有本地实现，可在 profile 里按行替换：

| 接口 | 服务 | dsh-base 里的行 | 本地实现 |
|---|---|---|---|
| `dsh-fs` 的 `FileSystem` | `ctx.fs` | `fs-sandbox` | `dsh-fs-local` / `dsh-fs-sandbox` |
| `dsh-subprocess` 的 `SubprocessRuntime` | `ctx.subprocess` | `subprocess` | `dsh-subprocess-local` |
| `dsh-shell` 的 `ShellExecutor` | `ctx.shell` | `bash-sandbox` | `dsh-bash-local` / `dsh-bash-sandbox`（经 `ctx.subprocess` 启动进程） |

文件和进程必须属于同一个执行环境：模型刚写的文件，bash 要能看见。所以要换的是「执行环境」，不只是文件系统。

## 3. 验证方法

- 一个独立进程扮演远端 workspace：真实文件在临时目录里，对外只暴露虚拟路径 `/ws`。host 上没有 `/ws`，dsh 只要在 host 上直接读写工作区文件就会报错。
- 写了两个插件替换 `fs-sandbox` 和 `subprocess` 两行：文件操作逐个转发到远端；子进程照 `ssh host cmd` 的方式，dsh 本地管理一个转发进程，命令在远端执行。
- 真实 dsh + Viva 的全部插件 + 按剧本调用工具的假模型；session 的 cwd 是 `/ws`。

## 4. 结论

**可行的部分**

- 只替换两行 profile，dsh 和 Viva 的代码都不用改；Viva 的插件照常加载（模型拿到的 44 个工具里有 `memory_*`、`viva_*`）。
- `session/new` 接受 host 上不存在的 cwd。
- read（绝对路径和相对路径）、write、edit、bash、grep、glob 全部可用；文件只在远端变化，host 的工作目录没被写入。

**必须先解决的问题**

| # | 问题 | 现象 | 可选方向 |
|---|---|---|---|
| 1 | stdio MCP 不经过 `ctx.subprocess` | `dsh-mcp-client` 直接用 `StdioClientTransport`，cwd 取 session 的 cwd。cwd 为 `/ws` 时整个 `session/new` 失败（`mcp-client(probe): initial connection or tool synchronization failed`）；对照组用 host 目录则成功 | 远端模式只允许 HTTP 类型的 MCP；或 MCP 固定跑在后端机器、另给 cwd；或请 dsh 上游让 stdio 传输走 `ctx.subprocess` |
| 2 | ripgrep 是 host 上的二进制 | grep 和 glob 把 `node_modules/@vscode/ripgrep-<平台>/bin/rg` 这个 host 路径交给远端执行，本次能跑通只因为两边在同一台机器 | 远端自带 rg，并做路径映射或配置覆盖；平台不同（如 Linux 容器）时必须处理 |
| 3 | 用户级指令和 skills 走 `ctx.fs` | dsh-home 下的 `AGENTS.md`、`skills/`、`agents/skills/` 都在远端查找 | 同步到 workspace，或做按路径分流的组合文件系统；还要确认 Viva 的 `viva_skill_*` 装到哪里 |

**远程子进程的实现要点**：必须如实传递 `spec.stdio`。验证中曾把 stdin 一律接成管道，ripgrep 在没给路径、stdin 又是管道时会去读 stdin，grep 因此静默返回「没有匹配」。这类细节应放进「本地和远程跑同一套测试」的一致性测试。

## 5. 没覆盖到的

- 沙箱：验证用 `danger-full-access`。`dsh-bash-sandbox` 用 host 的沙箱包装命令，远端应由 workspace 自己隔离（如容器）。
- 终端和持久 bash（`spawnTerminal`）、文件监听（`watch`）、`read_image`（`readBytes`）。
- 真正的两台机器：本次用路径映射模拟，bash 的 `pwd` 显示的仍是真实目录。
- Viva 自己直接用 `node:fs` 的模块：`src/main/workspace-files.ts`、`files-ipc.ts`、`file-watch.ts`、`island-files.ts`、`image-store.ts`、`work-dir.ts`。文件面板可考虑改用 dsh 的 `dsh-api-workspace-files`（建在 `ctx.fs` 上）。

## 6. 对当前重构的约束

前后端拆分时就遵守以下两条，以后接远端 workspace 不用再拆一次：

- 前端与后端之间不传本地路径，传内容或 blob id。
- 本机能力（文件、工作目录、MCP）在后端接口里单独成组，不和会话、记忆、跟进混在一起。

## 7. 复现

验证代码只保存在本地，没有进仓库（`spike/remote-workspace/`）。运行 `DSH_NODE=node node spike/remote-workspace/run.mjs`，加 `SPIKE_MCP=1` 可复现第 1 个问题，`SPIKE_SESSION_CWD=host` 是它的对照组。dsh 升级后这些结论需要重新验证。

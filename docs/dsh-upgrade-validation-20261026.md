# dsh 升级兼容验证（2026-10-26，Windows）

## 结论与范围

继续使用 ACP。本轮生产依赖保留 `0.2.0-rc.2`；在独立副本验证了 `0.2.1-rc.2`，没有把候选依赖或迁移代码复制回主项目，也没有安装、发布候选应用。

候选可通过本轮列出的兼容测试，但不能只修改三个 dsh 版本号：必须同步插件 peer 版本、Zod 版本和 persona 的工作目录模板。正式升级仍应单独提交，结合最新主分支重新验证。

- 主项目：`E:\viva\Viva`，副本创建基于 `c4c13d73a429d00ab2262e14119a4cb92f276fa4` 的工作区快照，包含当时用户的后台任务气泡改动；不包含本轮随后开发的 P0/P1 会话优化。
- 候选副本：`E:\viva\dsh-upgrade-validation-20261026`。
- 项目外打包验证目录：`E:\viva\dsh-packaged-validation-20261026`。
- Windows `10.0.26200`；Node `24.13.0`；Electron `44.7.0`（内嵌 Node `24.21.0`）。
- 模型端使用本地假 Messages/SSE 服务与测试密钥，MCP 使用本地测试进程；没有调用真实模型或发送外部消息。

## 版本选择

本次 npm 查询：`@deepseek-ai/dsh` 的 `latest` 为 `0.2.1-rc.2`，`next` 为 `0.2.1-rc.3`，均为候选版。`dsh-native-command` 与 `dsh-tool-ask-user` 的 `latest` 仍是旧版本，不能对所有包直接使用 `latest`。

副本明确安装：

```text
@deepseek-ai/dsh                  0.2.1-rc.2
@deepseek-ai/dsh-native-command   0.2.1-rc.2
@deepseek-ai/dsh-tool-ask-user    0.2.1-rc.2
zod                             4.4.3
```

所有 Viva 插件中 `@deepseek-ai/dsh*` 的精确 peer 版本同步为 `0.2.1-rc.2`。未修改 ACP SDK `1.9.0` 或 Electron `44.7.0`。

## 实际发现的破坏点与副本修复

### 1. `{{cwd}}` 不再是可用的 system-prompt 变量

仅升级版本后，打开会话成功，但 prompt 在发出模型请求之前失败：

```text
Internal error: turn failed: unknown prompt variable "{{cwd}}" in section
"deployment:persona-suffix"; registered variables: provider, model
```

Viva 的 `src/main/app-plugins.ts` 原本设置 `suffix: '你的工作目录是 {{cwd}}。'`。副本将 suffix 改为空字符串；新版默认组合中的 `dsh-working-directory` 会通过运行时上下文提供 `Current working directory: ...`，而非静态 persona 变量。`test/memory-plugin.test.js` 的 persona 测试相应改验该上下文。修复后真实模型请求和记忆、权限、流式等路径恢复。

### 2. Zod 的不同精确版本造成类型不兼容

主项目 Zod 为 `4.6.7`，候选 `dsh-session-projection`、`dsh-llm` 等精确依赖 `4.4.3`。候选初次类型检查耗尽约 4 GB Node 堆；构建明确报出 memory projection 的 `TS2589`、`TS2769`，底层类型差异为 `_zod.version.minor` 的 `6` 与 `4`。

副本将根依赖对齐 `zod@4.4.3` 后，类型检查与构建通过。没有使用类型强制转换或提高堆上限掩盖该问题。

### 3. 本次执行环境的系统 Temp 权限

Electron 的 composition dump 最初在系统 Temp 创建 profile 时遇到 `EPERM`。将 `TEMP`、`TMP` 指向副本内已创建的 `audit-temp` 后通过，未修改产品代码。该现象只能说明本次执行环境的权限边界，不能据此认定升级导致产品故障。

## 验证结果

| 检查 | 结果 | 范围 |
|---|---|---|
| 仅改 dsh/peer 后的初次检查 | 失败 | 类型/构建失败；首轮关键测试 17 项中 15 项失败，prompt 的 cwd 模板错误是主要运行时阻断点 |
| 修复后的 typecheck / build | 通过 | 全部项目 tsconfig；生成 out |
| 关键测试，Node | 17/17 通过 | 流式首增量、取消保留前缀、单例 MCP 预热失败隔离、自动/完全权限、禁止直接发送策略、记忆读写/提炼/合成/恢复、旧 home 迁移 |
| 相同关键测试，Electron | 17/17 通过 | 使用真正的 Electron Node 运行时，非 Node 替代 |
| 其他插件测试，Node | 31/31 通过 | 配置卡片、后续准备、fork、图片、消息源、模型路由/切换、问题卡片、steering、后台任务、trace；该组也包含少量纯逻辑测试 |
| 跨 dsh 版本恢复 | 通过 | 旧 `0.2.0-rc.2` 创建真实测试会话并退出，候选 `0.2.1-rc.2` 在同一隔离 home 恢复；ID 保持一致，后续模型请求包含旧历史 |
| composition / 依赖闭包 | 通过 | Electron 执行真实 `--profile acp --dump-config`，110 roots / 368 packages |
| Windows unpacked 构建 | 通过 | after-pack：368 packages，补入 36、移除 203，删除 6845 个不用的文件；asar 9973 个文件，58 个 unpacked 文件 |
| 项目外运行打包 dsh | 通过 | 解包产物复制到项目外，使用其 `Viva.exe` 和 `app.asar` 内 dsh 执行 ACP dump，得到 98 个配置条目，避免项目 node_modules 回退掩盖缺包 |
| NSIS 安装、升级安装、交互 GUI、真实用户数据、多平台 | 未运行 | unpacked 构建与协议测试不能代替这些检查 |
| `0.2.1-rc.3` 完整运行时/打包回归 | 未运行 | 只核查官方说明及源码，不把 rc.2 的通过结果外推到 rc.3 |
| P0/P1 最新优化代码与候选版组合 | 未运行 | 该副本是并行开发前的快照；正式升级时应重新组合验证 |

测试通过仅覆盖上述场景，不代表所有用户 MCP、复杂中断历史和长时间运行均兼容。

## 执行命令与复现

以下在候选副本运行，插件 peer 及 package.json 已先改为明确候选版本：

```powershell
npm install --no-audit --no-fund
npm install zod@4.4.3 --save-exact --no-audit --no-fund
npm run typecheck
npm run build

$env:DSH_NODE = (Get-Command node).Source
node --test test/stream-runtime.test.js test/prewarm-runtime.test.js test/permission-plugin.test.js test/policy-plugin.test.js test/memory-plugin.test.js test/dsh-home.test.js
node --test test/config-plugin.test.js test/followup-plugin.test.js test/fork-plugin.test.js test/images-bridge.test.js test/messages-plugin.test.js test/model-routes.test.js test/model-switch.test.js test/questions-plugin.test.js test/steer-plugin.test.js test/tasks-bridge.test.js test/trace-plugin.test.js
node audit-cross-version.mjs
```

Electron 核心测试通过 Node 启动并继承输出，避免将无测试输出的直接执行误认为通过：

```powershell
$env:TEMP = 'E:\viva\dsh-upgrade-validation-20261026\audit-temp'
$env:TMP = $env:TEMP
node -e "const env={...process.env,ELECTRON_RUN_AS_NODE:'1'};delete env.DSH_NODE;require('child_process').execFileSync(require('electron'),['--test','test/stream-runtime.test.js','test/prewarm-runtime.test.js','test/permission-plugin.test.js','test/policy-plugin.test.js','test/memory-plugin.test.js','test/dsh-home.test.js'],{stdio:'inherit',env})"
node -e "const r=require('./scripts/dsh-closure.cjs').shippedPackages(process.cwd());console.log(JSON.stringify({roots:r.roots,packages:r.keep.length}));require('fs').writeFileSync('closure-rc2.json',JSON.stringify(r,null,2))"
npx electron-builder --win --dir --publish never
```

本地审计副本保留：`upgrade-0.2.1-rc.2.patch`、`upgrade-files.json`、`audit-cross-version.mjs`、`closure-rc2.json`、`packaged-acp-dump.yml`。补丁包含依赖锁、插件清单及两处源码/测试迁移，未应用到主项目；下一轮应先检查新代码差异，不能盲目覆盖工作区。

## 收益判断与仍然存在的边界

官方 0.2.1 系列说明包含取消/超时、Agent 资源释放、恢复兼容、Windows 持久 PowerShell 等修复，值得正式升级验证。新版 ACP 取消收敛逻辑也有源码层增强；本次测试证明现有场景仍工作，没有测量这些修复在真实故障中的收益，也没有给出“升级后新话题更快”的结论。

新版 ACP 仍按会话挂载 MCP，并顺序等待；仍从 committed assistant messages 转发内容。因此当前会话预热和切换编排优化仍有必要，`viva-stream` 暂不能删除。

`0.2.1-rc.3` 相对 rc.2 的主要相关增量是 API Key 路径的模型列表更新；其 Web 菜单、草稿修复不直接改善 Viva 自有前端。采用 rc.3 前仍需重复同样的兼容验证。本轮没有足够证据为这点增量跳过已验证的 rc.2 基线。

官方来源：

- [0.2.1-rc.1 汇总说明](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.1)
- [0.2.1-rc.2 发布说明](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.2)
- [0.2.1-rc.3 发布说明](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.3)

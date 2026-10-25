# 开发、打包与测试

面向想从源码运行、修改或打包 Viva 的人。功能说明见 [features.md](features.md)，分层设计见 [architecture.md](architecture.md)，记忆方案见 [memory.md](memory.md)。

## 运行

开发需要 Node.js（npm）。dsh 内嵌在应用里，运行时用应用自己的 Electron，不需要用户另装 Node；用 `npx` 等启动的 MCP 服务器仍需要用户机器上的 Node。

```bash
npm install
npm start
```

应用从 `out/` 运行：`npm run build`（`scripts/build.mjs`）用 TypeScript 把 `src/` 和 `plugins/` 的代码写到 `out/src`、`out/plugins`，页面、样式、图标和插件的 `package.json` 原样复制过去，目录结构和仓库一样。`npm start`、`npm run smoke` 和打包会先自动构建；单独跑某个 smoke 阶段（如 `npm run smoke:memory`）前要自己先 `npm run build`。单元测试直接测 `src/`，不需要构建。类型检查是另一回事：`npm run typecheck`。

| 环境变量 | 作用 | 默认 |
|---|---|---|
| `DEEPSEEK_API_KEY` | 模型凭据（也可以在设置面板里填） | — |
| `AGENT_CWD` | 助手的工作区（dsh 会话的 cwd） | `./workspace` |
| `DSH_BIN` | 指定 dsh：`.js` 入口用 Node 运行，其他按可执行文件运行 | `node_modules/@deepseek-ai/dsh/lib/bin.js` |
| `DSH_NODE` | 开发用：改用这个 Node 运行 dsh | 应用自己的 Electron |

## 内嵌的 dsh

dsh 是应用的一部分，和你自己装的 dsh 完全隔离：

- **运行时**：用应用自己的 Electron 运行，不依赖、也不读取系统里的 Node 和 `dsh` 命令。
- **数据目录**：dsh 的 home 在应用数据目录下的 `dsh/`（macOS 上是 `~/Library/Application Support/Viva/dsh`），里面是 profile、会话、凭据和 skill。你的 `~/.dsh`、`~/.agents/skills` 都不会被读写。
- **环境变量**：交给 dsh 的环境去掉了所有 `DSH_*`、`DEEPSEEK_*`、`ELECTRON_*` 和 `VIVA_*` 变量，再放入应用自己设定的（dsh 目录、key、提供方的 key）。所以你在终端里设的 `DSH_HOME`、`DEEPSEEK_BASE_URL` 等不会影响 Viva。`DEEPSEEK_API_KEY` 仍可作为 key 的来源，由应用读出后再交给 dsh。
- **生命周期**：
  - 只允许运行一个 Viva（dsh 目录是它独占的），再次打开会切回已有的窗口。
  - dsh 意外退出时自动重启并接回当前对话，依次等 1、3、10 秒；两分钟内连续三次后停止重试，在对话里说明原因。
  - 换 key、增删模型时，先等旧的 dsh 完全退出，再启动新的，两者不会同时写同一个会话。
  - 退出应用时等 dsh 结束（最多 5 秒）：先关闭它的输入，1.5 秒后结束整个进程树（Windows 上用 `taskkill /T`，连同它启动的 MCP 服务器），再过 1.5 秒强制结束。
- **从 `~/.dsh` 迁移**：首次启动时，把 Viva 工作区在 `~/.dsh/sessions` 里的会话复制过来（不移动、不覆盖；dsh 按工作目录分组会话，你自己项目的会话不会被带走），旧对话照常接着聊、能看「过程」；再删除 Viva 以前写在 `~/.dsh/profiles` 里的 `viva`、`my-agent` profile（只删清单名称确认是 Viva 写的）。`~/.dsh/skills` 里的 skill 也复制一次（同名的跳过；只在首次迁移时做，之后在 Viva 里删掉的 skill 不会再被复制回来；你自己的 dsh 的 skill 文件夹保持原样）。

## 打包

```bash
npm run dist:mac    # macOS：dist/Viva-x.y.z-mac-arm64.dmg（未签名）
npm run dist:win    # Windows：在 Windows 上运行，dist/Viva-x.y.z-win-x64-setup.exe（NSIS，可选安装目录）
```

- **只打包用得到的 dsh（`scripts/dsh-closure.cjs`）**：`@deepseek-ai/dsh` 依赖了所有 profile 可能用到的包（网页版界面、TUI、用 LibreOffice 转换 Office 文档、语音输入等），Viva 只启动 ACP 组合。打包时用 dsh 自己的 `--dump-config` 列出 ACP 组合启用的插件，从它们、dsh 入口导入的包、Viva 自己的依赖和插件的 peer 依赖出发，顺着依赖、peer 依赖和可选依赖算出闭包，其余不打包（macOS 上 542 个生产依赖里保留 373 个，去掉了 LibreOffice 和语音识别等约 266MB）。
- **去掉运行时用不到的文件**：source map、类型声明、TypeScript 源码、README 和 CHANGELOG、测试和示例目录（约 7 千个文件）；许可证和 skill 文件保留。
- **asar**：其余文件打成一个 `app.asar`。之前上万个小文件逐个写入、被杀毒软件逐个扫描，是 Windows 上安装慢的原因；现在整个应用约 300 个文件。含原生代码或可执行程序的包（原生模块、libvips、ripgrep、node-pty）自动识别后解包放在 `app.asar.unpacked`，供系统直接加载和运行。dsh 用应用自己的 Electron 以 Node 模式从 asar 里运行；dsh 的原生模块按平台预编译，不重新编译（`npmRebuild: false`）。
- **插件入口**：dsh 的 profile 里每个插件是一个很小的转发包（`package.json` 加一行 `export * from '<插件的文件 URL>'`），插件本身留在 asar 里，它 import 的包在 asar 里解析；不需要符号链接或 junction。
- **打包后的处理（`scripts/after-pack.cjs`）**：electron-builder 自己收集依赖时，漏掉了 dsh 各包之间的 peer 依赖，又带上了 dsh 为其他 profile 准备的包。打包后的钩子把 electron-builder 打出的 asar 解开，按闭包增删包，删掉无用文件，写入许可文件，再按自己的解包规则重新打成 asar；还缺包就让打包失败。
- **工作区**：打包后的应用目录是只读的，工作区放在应用数据目录下的 `workspace/`；开发时（`npm start`）仍是仓库里的 `workspace/`。
- **体积**：macOS 的 dmg 约 152MB（裁剪前 259MB），应用解开后约 388MB，大头是 Electron 本身。
- **验证打包产物**：必须在仓库之外运行。在仓库里（`dist/` 下）运行时，Node 会顺着上级目录找到仓库自己的 `node_modules`，缺包也看不出来。对打包后的应用跑 memory 阶段的 smoke，用 `SMOKE_FIXTURES` 指向仓库的 `test/fixtures`（应用里没有测试目录）、`SMOKE_OUT` 指向输出目录：
  - macOS：只读挂载 dmg，运行里面的应用：`hdiutil attach -nobrowse -readonly dist/Viva-*.dmg`，然后 `SMOKE_PHASE=memory SMOKE_OUT=/tmp/viva-smoke SMOKE_FIXTURES=$PWD/test/fixtures DEEPSEEK_API_KEY=smoke-fake-key "/Volumes/Viva x.y.z/Viva.app/Contents/MacOS/Viva"`。
  - Windows：`scripts\verify-windows.ps1 -Package` 打安装包，静默安装到临时目录，对装好的 `Viva.exe` 跑 smoke，再卸载。
- **第三方许可证**：`THIRD_PARTY_NOTICES.txt` 由 `scripts/third-party-notices.cjs` 在打包时按实际打进去的依赖生成（各平台的依赖不完全相同），发布时随 Release 附上两个平台的版本。
- **还没做**：代码签名和公证、自动更新、Intel Mac 和 Windows ARM 的包。

## 发布

推送版本标签就会发布，安装包不经过本地：

1. 把 `package.json` 的版本改成新版本（`npm version 0.4.1-beta.1 --no-git-tag-version`，`package-lock.json` 一起改）。
2. 在 `docs/releases/v<版本>.md` 写这一版的发布说明（格式照上一版：下载、首次打开、这一版的变化、测试情况）。
3. 这两处改动走 PR 合进 main，再在 main 上打标签推上去：`git tag v0.4.1-beta.1 && git push origin v0.4.1-beta.1`。

`.github/workflows/release.yml` 接着做：先查标签和 `package.json` 的版本对得上、发布说明写了；再跑一遍 `package.yml`，在 macOS 和 Windows 上打安装包、对装好的应用跑冒烟测试；都通过了才建 GitHub Release，挂上两个安装包和两份 `THIRD_PARTY_NOTICES`。版本号里带 `-`（beta、rc）的标成测试版。任何一步失败都不会发布；修好后删掉标签（`git push origin :refs/tags/v<版本>`）再打一次。

## macOS 与 Windows

两端用同一套界面，只有标题栏两侧给系统窗口按钮的留白不同：

- **macOS**：红绿灯在左上，标题栏左侧留出位置。
- **Windows / Linux**：由系统在右上画「最小化 / 最大化 / 关闭」（`titleBarOverlay`），页面按 `env(titlebar-area-width)` 把我们的按钮让到它们左边；Windows 上不显示菜单栏。
- **状态胶囊**：始终按整个窗口居中，窗口变窄时先收缩，不会压到两侧按钮。
- **标题栏高度**：两端都是 48px。
- **窗口大小**：按屏幕可用区域计算，开了 125% 到 150% 显示缩放的笔记本也放得下；最小 880×600。
- **窄窗口**：宽度不到 1100px 时，展开的抽屉浮在对话上面，不再挤压对话。
- **快捷键**：历史面板在 macOS 上是 ⌘K，在 Windows 上是 Ctrl+K，提示文字跟着平台变。
- **启动 dsh**：用应用自己的 Electron（`ELECTRON_RUN_AS_NODE=1`）运行 dsh 的入口文件，不经过 `.bin/dsh(.cmd)` 包装脚本（Windows 不允许不经 shell 启动 `.cmd`）。dsh 的原生模块只认它列出的几个 Electron 版本（43.0.0、44.0.0、44.7.0、45.0.0-alpha.6），所以 `package.json` 把 Electron 固定在 44.7.0；升级 Electron 前要先确认 dsh 支持。
- **npm 脚本**：用 `cross-env`，在 cmd、PowerShell 里也能跑。

## 架构

```
渲染进程（界面）                主进程                        node dsh/lib/bin.js --profile viva
app.js ── state.js(reducer)     main.js ── acp-bridge.js ──stdio──▶ DeepSeek Harness
   │        selectors.js           │        history-db.js            （ACP v1 JSON-RPC）
   └─ view/*  ◀── preload.cjs ──IPC┘        dsh-profile.js                 └─ plugins/memory（记忆插件）
                                            memory.db ◀──────── 同一个文件 ────────┘
```

- **插件化分层**：模型看到什么、能做什么（记忆、过程记录、工具策略、人设）放在应用自己 profile 里的 dsh 插件中；会话怎么跑留在 ACP；界面和本机数据留在应用。插件和应用只通过带版本号的数据约定协作。详见 [architecture.md](architecture.md)。
- **主进程** 启动 `dsh --profile viva`（应用自己的 profile，见 [features.md 的「记忆」](features.md#记忆)），用官方 `@agentclientprotocol/sdk` 的 `ClientSideConnection` 说 ACP：`initialize → session/new → session/prompt`，`session/cancel` 停止，`session/close` 开新对话。
- **事件分流**（对应设计稿的「对话不含思考和工具调用」）：
  - `agent_message_chunk` → 对话区
  - `agent_thought_chunk`、`tool_call`、`tool_call_update` → 抽屉「过程」、标题栏的 Viva 岛；读写过的文件进「文件」
  - `session/request_permission` → 对话里的亮蓝确认卡片；你的选择经 `permission-broker` 回给 dsh
- **模型切换**：输入框左下角的选择器，列出 dsh 返回的模型和推理强度（Off / Low / High / Max），通过 ACP 的 `session/set_config_option` 切换，从下一轮生效；回复进行中禁用。
- **流式输出**：回复按打字机节奏逐字显示（基础约 90 字/秒，积压多时自动加速，最多落后约 1.2 秒）。注意：dsh 的 ACP 接口只推送「已完成的整段消息」，不推送模型的逐字增量，所以首字要等整段生成完才出现。dsh 将来若推送增量片段，无需改代码即可逐字显示。
- **滚动**：对话区新内容到来时跟随到底部，但长回复只滚到「最新提问贴近顶部」就停，回答从提问下方往下长，底部出现「↓ 新内容」；你一往上翻就停止自动跟随，滚回底部再恢复。抽屉重绘时保留滚动位置，停在底部时像日志一样跟随最新一步，打开「过程」直接定位到最新。
- **改名（原 my-agent）**：应用原名 my-agent，Electron 按应用名存放数据。改名后首次启动时，会把旧目录里的历史对话、记忆和过程记录**复制**过来，旧目录原样保留作为备份。加密保存的 API key 无法迁移（系统钥匙串的条目按应用名区分），需要在设置里重新填一次，或者用 `DEEPSEEK_API_KEY` 环境变量。
- **状态** 全部在 `state.js` 的纯 reducer 里不可变更新；视图只读 `selectors.js`，所有文本都走 `textContent`。
- **安全**：`contextIsolation` + `sandbox`，preload 只暴露 `window.agent` 上的方法和平台名（桌面岛的页面另有一个只能收内容、发点击的 `window.desk`），主进程校验 IPC 入参（包括渲染进程提交的历史消息），页面有 CSP。

## 猫形象素材

角色和素材规范见 [猫角色设定](cat-character.md)。应用从 `src/assets/cat/bust/` 加载：首页等大尺寸用半身图（512px），48px 及以下用同名 `-head.png` 头部特写（256px），都是从 1024px 原图缩小导出的透明 PNG；原图和生成提示词不放进仓库。换图后在首页、36px 对话头像、标题栏和桌面岛上各看一遍。

## 测试

```bash
npm test            # 574 个单元 / 集成测试，用 Electron 自带的 Node 运行，和应用的运行时一致
npm run coverage    # 覆盖率
npm run smoke       # 真的启动 Electron，分五次：
                    #   setup：没有 key，检查引导卡片、输入框禁用、按钮能打开设置；
                    #     再走一遍消息源：选文件夹安装 → 测试连接（错的令牌、对的令牌）→ 打开 → 收到消息 → 移除；
                    #   walkthrough：等待确认卡片时的状态胶囊浮层和标题栏布局（macOS 和模拟的 Windows，各在正常宽度和最窄
                    #     880px 下检查胶囊居中、不和按钮重叠，窄窗口抽屉浮层），长任务时过程抽屉和对话的滚动，文件页的预览；
                    #   relaunch：同一份数据再启动，检查上次的对话完整回来、助手接回会话，再走一遍历史面板
                    #     （⌘K、第二段对话、搜索高亮、打开旧对话、重命名、删除和撤销），最后检查 Markdown 渲染
                    #     和其中不该生效的脚本、链接、图片，以及页面不能跳转；再看桌面岛上提问、发图片、新话题和换权限；
                    #   memory：真实的 dsh 加记忆插件，配假模型：引导、「记住」、关于你页面里的关键词、
                    #     提到名称时带上记忆、「过程」里的「带上记忆」，助手反问城市（卡片、点选回答、回答记进记忆），
                    #     设置页的插件状态，在对话里接入 MCP；
                    #     主动跟进：建议卡片 → 跟进 → 选时段 → 现在就准备 → 草稿 → 接着做，以及消息建议 → 跟进；
                    #     再在设置里添加一个模型提供方，从模型菜单选中它并对话（当前对话保留）；
                    #   resume：直接杀掉 dsh，检查提示重连、自动重启并接回同一段对话
```

- **在 Windows 上验证**：在 PowerShell 里运行 `powershell -ExecutionPolicy Bypass -File scripts\verify-windows.ps1`，依次安装依赖、跑单元测试和五个阶段的 smoke，结果、日志和截图收在 `smoke\windows-report`；加 `-Live` 并设置 `DEEPSEEK_API_KEY` 环境变量，会再用真实模型跑一次记忆测试（key 不写进报告）。
- **GitHub 上的自动检查**（`.github/workflows/`）：每个 PR 都在 macOS 和 Windows 上各跑一遍类型检查、构建、单元测试和全部 smoke 阶段（`check.yml`）；改到构建或打包相关的文件时（也可在 Actions 页面手动运行），再在两个平台上打出安装包、装到仓库之外、对装好的应用跑 memory 阶段，Windows 上最后卸载（`package.yml`）。
- **什么时候在真机上测**：GitHub 的机器是虚拟机，看不到真实屏幕上的样子。
  - macOS：每次改动，提交前在真机上跑完类型检查、单元测试和全部 smoke。
  - Windows 真机，只在这几种时候：每次发版前（beta 和正式版），跑完整的 `verify-windows.ps1 -Package`，并在 4K 屏上人工看一遍界面、留截图；改到 Windows 上特有的东西时（标题栏右上角的系统按钮、托盘、桌面岛、安装和卸载、文件路径和权限）；GitHub 上的检查通过、但用户在 Windows 上遇到问题时，去真机复现。
  - 其余改动只靠 GitHub 上的 Windows 检查。
- **数据隔离**：smoke 用 `smoke/userData` 作为独立的数据目录，不会碰你自己的历史记录和 key。
- **假模型**：记忆相关的测试和 smoke 用真实的 dsh，把 `DEEPSEEK_BASE_URL` 指向 `test/fixtures/fake-llm.js`。它记录 dsh 发给模型的每个请求，并按固定规则回复（「记住：…」会调用 `memory_remember`），不需要 key。
- **假 dsh**：其余 smoke 和集成测试里的 dsh 换成 `test/fixtures/fake-dsh.js`。它讲真实的 ACP 协议，按固定剧本回复：提问里带「长任务」会连续调用 16 次工具，再输出长回复。这样走的是和真实使用完全相同的代码路径，只是不调用模型。应用里没有演示模式。

## README 的图和宣传片

README 和这份文档里的截图、动图，都是应用自己拍的，不是手工截图：

```bash
npm run showcase    # 需要 ffmpeg
```

- 用真实的 dsh 加假模型（`test/fixtures/showcase-llm.js`，回答读起来像真的在用），按 `src/main/smoke-showcase.ts` 的剧本走一遍：首页的「今天」、对话、跟进卡片、后台准备、消息建议、确认卡片、消息源、后台准备时段、文件、桌面岛。数据目录是 `smoke/showcase/userData-showcase`，不碰你自己的数据。
- 跟进的全过程按每秒 10 帧录下来，ffmpeg 做成 `docs/images/demo.gif`；截图缩到 1600px 宽放进 `docs/images/`。
- 同一份录像和截图复制到 `promo/public/`，录像的长度写进 `promo/src/demo-meta.json`。

改了界面以后重跑一次，再看一遍 `docs/images/` 里的图。

宣传片在 `promo/`，是一个独立的 [Remotion](https://www.remotion.dev/) 项目，有自己的依赖，不进安装包：

素材（`promo/public/`）由 `npm run showcase` 生成，不进仓库，先在仓库根目录跑一次：

```bash
cd promo
npm install
npm run studio      # 在浏览器里预览、逐帧看
npm run render      # 出 promo/out/viva-promo.mp4（1920×1080，30fps）
```

场景在 `promo/src/scenes/`，每个场景的长度在 `promo/src/timeline.ts`，颜色和字体在 `promo/src/theme.ts`。

## 已知限制

- `@deepseek-ai/dsh` 还是 0.2.0-rc，官方说明会有不兼容改动；ACP profile 是「自动化」定位，不提供 plan、todo 等 DSH 专有界面数据。
- 聊天内容以明文保存在本机（key 是加密的）。
- 旧对话的「过程」依赖 dsh 私有的 v4 日志格式，dsh 升级后可能读不出来；读不出时只是不显示过程，对话本身不受影响。
- 测试必须用 Electron 自带的 Node：系统 Node 24.14 的 zstd 只能解开多帧文件的第一帧，而 dsh 的日志正是多帧的。
- 记忆插件依赖 dsh 的插件接口，插件声明的 dsh 版本是精确的 `0.2.0-rc.2`，升级 dsh 时要同步更新 `plugins/memory/package.json`，否则 dsh 会拒绝加载插件（对话不受影响，只是没有记忆）。
- 对话压缩后重新带上画像的逻辑有单元测试，但还没在真实 dsh 里触发过压缩来验证。
- Windows 已在真实的 Windows 11（x64，4K 屏）上用 `scripts\verify-windows.ps1` 跑通全部测试和当时四个阶段的 smoke，包括真实 dsh 加记忆、过程记录和工具策略插件（profile 写入、插件加载）；系统窗口按钮本身由系统绘制，页面截图拍不到，需要人工看一眼。真实模型在 Windows 上的对话还没验证（需要 key）。
- 字体从 Google Fonts 加载，离线时回退到系统字体。

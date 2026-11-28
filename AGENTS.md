# 开发约定

- 新增测试使用 TypeScript（`*.test.ts`）；新增源码和内部脚本优先使用 TypeScript。
- 逐步将仓库迁移到 TypeScript：修改现有 JavaScript 模块时，优先迁移本次涉及的模块、测试和内部 fixture，并保持每批改动可独立验证。不要为了改扩展名一次性重写整个仓库。
- 迁移必须补充有效类型并进入类型检查，不用 `@ts-nocheck`、新增宽泛 `any` 或关闭 strict 掩盖问题。保留现有行为与测试覆盖。
- 测试通过 Node/Electron 原生类型擦除直接运行源码，使用可擦除的 TypeScript 语法和 `import type`；源码导入保留 `.ts` 扩展名。
- 迁移期间测试和覆盖率入口必须同时发现 `.test.ts` 与尚未迁移的 `.test.js`；迁移后删除旧文件，避免重复运行或漏跑。
- 外部工具要求的 CommonJS 入口、对外发布的 JavaScript 模板和生成产物保留其必要格式；如迁移相关源文件，同时验证构建、打包和下游调用。
- 验证改动时运行相关测试及 `npm run typecheck`；测试入口或构建配置改变后，确认完整测试集合仍被发现。

## 前端（`src/renderer`）

- 视觉与交互照 [界面规范](docs/ui-guidelines.zh-CN.md) 做；改了其中的规则，同时更新中英两份文档。
- 渲染器是原生 TypeScript 加 DOM，不引入前端框架、打包器或 CSS 预处理器。第三方模块按文件路径导入（参考 `view/markdown.ts`）。新增运行时依赖要先说明理由。
- 分层：`*-state.ts` 是纯函数且不可变，返回新对象，初始值用 `Object.freeze`，由 `state.ts` 合进 reducer；`*-actions.ts` 负责 IPC 和副作用，依赖通过 `create…Actions({ api, getState, dispatch, … })` 传入；`view/*.ts` 只按 state 构建 DOM、绑定 handlers，不直接调用 IPC。
- DOM 用 `view/dom.ts` 的 `h()` 构建，字符串一律成为文本节点。不用 `innerHTML`、`insertAdjacentHTML` 或 `outerHTML` 写入字符串，唯一例外是主进程 highlight.js 已转义的代码（`view/files-panel.ts`）。模型输出的 Markdown 走 `view/markdown.ts`，链接经 `safeHref` 和 `openLink` 打开。不放宽 `index.html` 的 CSP。
- 重绘：用 `reconcileChildren` 保留没变的节点，不整块替换对话；重建带表单的区域时用 `keepingInput` 保留输入、焦点和光标；读取布局的代码交给 `queueLayout`，同一帧内先统一读、再统一写，不在写完 DOM 后立即同步读取几何。
- 样式：颜色、字体、尺寸只用 `:root` 的 token，需要新值先加 token；状态写在 `aria-*` / `data-*` 上，不加状态类；先复用已有组件类。新 class 放进 `styles.css` 对应的区块，注释写明哪个 view 文件在用。不用 `backdrop-filter`；循环动画要有 `prefers-reduced-motion` 规则。
- 文案：界面上的字（包括 `aria-label`、`title`、占位符、空态和错误）同时加进 `src/shared/i18n/messages/en.ts` 和 `zh-CN.ts`，用 `t()` 取。静态 HTML 用 `data-i18n` / `data-i18n-*`；模块级缓存的文案在 `onLocaleChange` 里刷新。CSS 的 `content` 不放文字。
- 键盘与无障碍：处理按键先跳过输入法组合（`event.isComposing || event.keyCode === 229`）；纯图标按钮带 `aria-label`；不关闭或削弱 AX。
- 验证：state 和 actions 的逻辑补单元测试。本地运行 `npm run typecheck`、`npm test`，改了文档再运行 `npm run check:i18n`。视觉改动在 PR 里附截图；涉及标题栏、岛或窗口尺寸的改动，macOS 和 Windows 都要看过。

## 评审维度

改动自查与代码评审按以下维度逐项审视，优先收敛阻塞问题，不为低频边缘场景过度设计：

- **阻塞分级**：优先解决会导致数据丢失、重复执行或重复投递、权限与信任边界失守、崩溃恢复失真、死锁或界面卡死的问题；低风险边缘细节不阻塞主线。
- **数据归属与防旁路**：每类持久化状态和副作用队列保持单一写入入口与事务边界（经各自 store、`Effects`、`apply` 写入），跨模块不直接裸写他方 SQLite 表，不绕过 IPC 契约，也不跨云端就绪边界泄露本机路径等宿主私有状态。
- **架构整洁与防腐化**：跨进程或跨插件共享的协议格式、标识命名空间与解析逻辑收口到 `src/shared` 单一真源；下线旧能力时同步清理死代码、废弃契约、样式与文案，并通过幂等原子迁移处理历史表与未决队列，不留半拆状态。
- **生命周期、恢复与竞态**：跨异步或跨进程边界（IPC、dsh 会话切换、原生写入与回执）要审视中断重启后的幂等恢复、已删除或已替代实体的防复活（代数校验或墓碑），以及慢响应晚到不覆盖新状态（单调序号或 generation）。
- **容量与上下文边界**：区分模型上下文预算、实时通道上限与本地归档上限；送入模型或实时通道的内容按预算截断（必要时保留头尾关键上下文）并对积压分批限流，用户可展开查看的本地记录单独界定合理上限。
- **性能与资源增长**：审视启动路径、每轮持久化、流式重绘帧与长会话滑动窗口的复杂度和驻留规模；启动与高频路径走索引或轻量元数据查询，避免全表扫描和大字段反序列化；滑动窗口裁剪时同步释放窗口外关联状态，辅助持久化表保持有界；折叠态大文本按需挂载 DOM，不在隐藏态常驻重节点拖慢布局与 AX 树。
- **交互与状态闭环**：核对加载中、空态、错误态及目标已结束/已删除时的明确反馈（显式打开的目标消失时说明原因，不静默跳到无关项），并在列表刷新或删除后保持或合理回退键盘焦点。

## 冒烟测试

- PR 在 macOS、Windows 上各运行一个 check，执行类型检查、基础对话用例并构建安装包。完整源码、桌面冒烟与安装后验收由每日和发布工作流运行。
- 重大架构变更（主进程与 dsh 的生命周期、IPC 或 preload、会话与存储、构建和打包、冒烟测试工程本身）在提 PR 前先本地 `npm run build` 并运行 `npm run smoke`。排查 CI 失败时，也在本地运行对应阶段（如 `npm run smoke:memory`）。
- CI 失败不能靠重跑掩盖：先看上传的 trace、截图和日志，确认是偶发问题才重跑，并在 PR 里写明。

## Development conventions (English)

The Chinese and English sections describe the same rules.

- Write new tests in TypeScript (`*.test.ts`); prefer TypeScript for new source and internal scripts.
- Migrate touched JavaScript modules, tests, and internal fixtures incrementally, keeping each batch independently verifiable. Do not rewrite the repository merely to change extensions.
- Add meaningful types and include migrated files in typechecking. Do not hide errors with `@ts-nocheck`, broad new `any`, or disabled strict checks. Preserve behavior and coverage.
- Tests run source directly through Node/Electron native type stripping: use erasable syntax, `import type`, and `.ts` source import extensions.
- During migration, test and coverage discovery must include both `.test.ts` and remaining `.test.js`; remove migrated duplicates.
- Keep formats required by external tools, published JavaScript templates, and generated outputs. Validate build, packaging, and downstream invocation when migrating their sources.
- Run relevant tests and `npm run typecheck`. After changing discovery/build configuration, verify the full test collection is still discovered.

### Frontend (`src/renderer`)

- Follow the [UI guidelines](docs/ui-guidelines.md) for visuals and interaction. When you change one of their rules, update both language versions.
- The renderer is plain TypeScript and DOM: no frontend framework, bundler or CSS preprocessor. Import third-party modules by file path (see `view/markdown.ts`). Explain why before adding a runtime dependency.
- Layers: `*-state.ts` is pure and immutable, returning new objects, with initial values under `Object.freeze`, merged into the reducer by `state.ts`. `*-actions.ts` does IPC and side effects, with dependencies passed into `create…Actions({ api, getState, dispatch, … })`. `view/*.ts` only builds DOM from state and wires handlers; it never calls IPC directly.
- Build DOM with `h()` from `view/dom.ts`, which always turns strings into text nodes. Don't write strings through `innerHTML`, `insertAdjacentHTML` or `outerHTML`. The one exception is code already escaped by highlight.js in the main process (`view/files-panel.ts`). Model Markdown goes through `view/markdown.ts`, and links open through `safeHref` and `openLink`. Don't loosen the CSP in `index.html`.
- Redrawing: keep unchanged nodes with `reconcileChildren` instead of replacing the conversation wholesale. When rebuilding a region with form fields, use `keepingInput` to keep input, focus and caret. Hand layout reads to `queueLayout`, so each frame does all reads before all writes; never read geometry synchronously right after writing DOM.
- Styles: colors, fonts and sizes come only from `:root` tokens; add a token before using a new value. Put state in `aria-*` / `data-*`, not state classes, and reuse existing component classes first. Put a new class in the matching section of `styles.css`, with a comment naming the view file that uses it. Don't use `backdrop-filter`. Looping animations need a `prefers-reduced-motion` rule.
- Copy: interface text, including `aria-label`, `title`, placeholders, empty states and errors, goes into both `src/shared/i18n/messages/en.ts` and `zh-CN.ts` and is read with `t()`. Static HTML uses `data-i18n` / `data-i18n-*`. Refresh module-level cached strings in `onLocaleChange`. Don't put text in CSS `content`.
- Keyboard and accessibility: skip key handling during IME composition (`event.isComposing || event.keyCode === 229`). Icon-only buttons have an `aria-label`. Never turn off or weaken AX.
- Verification: add unit tests for state and actions logic. Run `npm run typecheck` and `npm test` locally, and `npm run check:i18n` after documentation changes. Attach screenshots to PRs with visual changes, and check changes to the title bar, island or window sizing on both macOS and Windows.

### Review dimensions

Self-audits and code reviews evaluate changes across the dimensions below, converging on blocking issues first without over-engineering rare edge cases:

- **Blocking triage**: prioritize issues that can cause data loss, duplicate execution or delivery, broken permission or trust boundaries, corrupted crash recovery, deadlocks, or stuck UI states; don't block on low-impact edge cases.
- **Data ownership and no bypasses**: keep a single owning store and transactional write path for each persisted table and effect queue (through its store, `Effects`, and `apply`). Don't write raw SQL into another module's tables, bypass IPC contracts, or leak host-local paths across cloud-ready boundaries.
- **Architectural hygiene and anti-decay**: consolidate wire formats, identifier namespaces, and parsers shared across processes or plugins into a single `src/shared` source of truth. When retiring a capability, remove dead code, contracts, styles, and copy together, and migrate or drop legacy tables and queued effects atomically and idempotently rather than leaving half-removed remnants.
- **Lifecycle, recovery, and concurrency**: across async and cross-process boundaries (IPC, dsh session switches, native writes and receipts), check idempotent restart recovery, prevent deleted or superseded entities from being resurrected (via generations or tombstones), and guard against stale async replies overwriting newer state (monotonic sequence numbers or generations).
- **Context, wire, and storage bounds**: separate model-context budgets, live-channel wire limits, and local archive bounds. Window and batch backlogs entering model turns or live channels (keeping head and tail context when truncating), while bounding fuller user-inspectable records separately.
- **Performance and bounded growth**: check complexity and memory residency across startup, per-turn persistence, streaming frames, and long-session sliding windows. Keep startup and hot paths on indexed or metadata-only queries instead of full-table scans or large-payload deserialization; trim out-of-window companion state alongside messages and cap auxiliary tables; mount large collapsed text lazily so hidden heavy nodes do not bloat layout or the AX tree.
- **Interaction and state completeness**: verify loading, empty, error, and gone/deleted target states (when an explicitly requested item is gone, say so instead of silently selecting another), and preserve or cleanly recover keyboard focus across list refreshes and deletions.

### Smoke tests

- Each PR has one check on macOS and one on Windows. Both typecheck, run basic conversation tests, and build an installer. Daily and release workflows run full source, desktop smoke, and installed-app acceptance.
- For major architectural changes (the main process and dsh lifecycle, IPC or preload, sessions and storage, build and packaging, the smoke test project itself), run `npm run build` and `npm run smoke` locally before opening the PR. When investigating a CI failure, run the matching stage locally too (for example `npm run smoke:memory`).
- Don't hide a CI failure by rerunning it. Read the uploaded trace, screenshots and logs first; rerun only after confirming it is intermittent, and say so in the PR.

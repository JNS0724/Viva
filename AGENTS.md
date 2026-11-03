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
- 验证：state 和 actions 的逻辑补单元测试。改界面后运行 `npm run typecheck`、`npm test`，再 `npm run build` 后运行 `npm run smoke:core`；改了文案加跑 `npm run smoke:language`；改了文档运行 `npm run check:i18n`。视觉改动在 PR 里附截图；涉及标题栏、岛或窗口尺寸的改动，macOS 和 Windows 都要看过。

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
- Verification: add unit tests for state and actions logic. After UI changes, run `npm run typecheck` and `npm test`, then `npm run build` and `npm run smoke:core`. After copy changes, also run `npm run smoke:language`. After documentation changes, run `npm run check:i18n`. Attach screenshots to PRs with visual changes, and check changes to the title bar, island or window sizing on both macOS and Windows.

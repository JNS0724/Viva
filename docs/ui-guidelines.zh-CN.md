# 界面规范

[English](ui-guidelines.md) | 简体中文

Viva 现有界面的视觉和交互规则，从 `src/renderer/styles.css`、`island.css`、`personal.css` 与 `src/renderer/view/` 提取（2026-11-03，main `27de6f4`）。本文与代码不一致时以代码为准，同时修正本文；新界面照本文做。开发约定（分层、DOM、国际化、验证）见 [AGENTS.md](../AGENTS.md) 的「前端」一节，猫的形象见 [猫角色设定](cat-character.zh-CN.md)。

## 基调

代码里的名字是「A 方案 · 工业饱和 Bento · 深海蓝」：

- **只有深色**。`color-scheme: dark`，没有浅色主题，也不跟随系统切换。
- **一个强调色**。蓝调深底，搭一个亮蓝 `--accent`。橙和红只在出现状态时使用，平时界面上看不到。
- **平面、几何**。层次靠底色深浅和 1px 描边区分。阴影只给浮起来的东西（菜单、提示、toast、展开的岛）。不用渐变底，不用毛玻璃：`backdrop-filter` 会让背后每次重绘都卡顿，所以遮罩用半透明纯色。
- **唯一的暖色是猫**。猫的对话气泡是暖纸色（`--cat-bubble*`），和船长帽同色，不挪作他用。

## 颜色

全部在 `styles.css` 的 `:root` 里定义。只用 token；需要新颜色时先加 token，写清用途。

| token | 值 | 用途 |
| --- | --- | --- |
| `--bg` | `#060B16` | 窗口底色；输入框（`.field`）内部也用它，比所在卡片低一级 |
| `--panel` | `#0D1526` | 卡片、输入区、图标按钮 |
| `--panel-2` | `#111B30` | 菜单、标签组底、悬停行 |
| `--raised` | `#15203A` | 浮起的小块：chip、badge、提示、toast、代码块 |
| `--line` | `#1B2742` | 默认描边、分隔线 |
| `--line-2` | `#263557` | 强一级描边：次要按钮、菜单边、悬停后的边 |
| `--ink` | `#EEF3FF` | 主文字 |
| `--ink-2` | `#A3B0CC` | 次要文字、未选中的控件 |
| `--ink-3` | `#7686A6` | 说明、元信息、占位符、禁用项 |
| `--mute` | `#3C4A68` | 最弱的标记（轮次刻度等） |
| `--accent` | `#5AA9FF` | 可操作、选中、焦点、完成 |
| `--orange` | `#FF8A3D` | **等用户**：确认卡片、等待中的任务、上下文快满 |
| `--red` | `#FF4D5E` | 错误、危险操作 |
| `--white` | `#EEF3FF` | 发送按钮忙碌态的底色 |
| `--drawer-bg` | `#0A1120` | 对话旁边的抽屉 |
| `--island-bg` | `#070C18` | 岛（标题栏和桌面） |
| `--line-3` | `#2E3D5E` | 虚线和描边：空态、`.btn-outline` |
| `--user-line` | `#1F2C49` | 用户自己消息的边 |
| `--line-focus` | `#3A4C72` | 输入区聚焦时的边 |
| `--error-ink` | `#FF9AA4` | 错误文字 |

颜色的语义固定，不同位置要一致：

- **蓝 = 你可以点 / 已经好了**。主按钮、选中的标签、焦点环、`data-tone="done"`。
- **橙 = 在等你**。在岛的边、猫的圆底、确认卡片的边和脉冲点，以及 `.btn-primary` 上出现。橙色按钮只用在「等用户决定」的卡片里，一般页面的主操作用蓝色 `.btn-accent`。
- **红 = 出错了**。边框、左侧 3px 色条，或 `color-mix` 调出的淡底色。错误文字用 `--error-ink`，直接用 `--red` 写字对比度不够。

透明度变体从 token 混出来，例如 `color-mix(in srgb, var(--accent) 12%, transparent)` 或 `color-mix(in srgb, var(--orange) 16%, var(--panel))`，不写 `rgba(90, 169, 255, .12)`。阴影用的黑色 `rgba(0, 0, 0, …)` 不在此列。

`test/renderer-css.test.ts` 会检查这些规则：`:root` 之外不能出现十六进制色值，强调色、橙、红也不能写成 `rgba`。代码高亮的 `.hljs-*` 是一组独立配色，例外保留。

## 字体

| token | 字体 | 用途 |
| --- | --- | --- |
| `--font-sans` | Space Grotesk → Noto Sans SC → PingFang SC → 微软雅黑 | 界面和正文 |
| `--font-mono` | JetBrains Mono → SF Mono / Cascadia Mono / Consolas | 标签、路径、快捷键、密钥、代码、时间 |
| `--font-dot` | Doto | 点阵大字，只用在设置页的密钥状态 |

网页字体通过 Google Fonts 以 `display=optional` 加载，加载不到就用系统字体，不闪烁。CSP 只放行 fonts.googleapis.com 和 fonts.gstatic.com，新增字体也只能从这里来。

字号：

| 字号 | 用途 |
| --- | --- |
| 11px | `.label`、时间、快捷键、元信息 |
| 12px | 次要说明、chip、菜单附注 |
| 13px | 控件文字、菜单项、帮助文字、toast |
| 14px | 正文、字段、话题标题 |
| 15–16px | 按钮、输入框（输入框是 16px） |
| 22px | 卡片标题、提问、首页副标题 |
| 28px | 页面标题、确认卡片标题 |
| 48px | 首页问候语 |

- 字重用 400 / 500 / 700。600 用在列表里的标题（话题名、小标题），800 只配 Doto。
- 行高：正文 1.6，说明文字 1.7，标题 1.2–1.3，单行控件 1。
- `.label` 是小号大写等宽标签：mono 11px、500、`letter-spacing: .14em`、`text-transform: uppercase`。用 `view/dom.ts` 的 `label()` 生成。
- 12.5px、13.5px、14.5px 这类半号已经存在但不再新增，取相邻整数。

## 间距与圆角

间距大致以 2px 为步长。常用 `gap` 依次是 8 > 10 > 12 > 6 > 4。列表和控件组用 6–10px，卡片内部的区块用 14–16px，对话里的消息之间用 28px。

| 圆角 | 用途 |
| --- | --- |
| 2–3px | 细条、刻度、进度条 |
| 6–8px | badge、chip、小标签、`kbd` |
| 9–10px | 菜单项、标签、图标按钮、小按钮 |
| 12px | 按钮、字段 |
| 14px | 卡片、菜单、话题、代码块 |
| 16–18px | 空态、拖放区 |
| 20–22px | 输入区、确认卡片、首页卡片、密钥状态 |
| 999px | 胶囊：toast、回到最新、时间线上的工作目录 |
| 50% | 圆点、头像 |

嵌套圆角要同心：内层圆角 = 外层圆角 − 内边距。岛的猫头就是这样对齐的（`island.css` 的 `.isl-cat`）。`--radius-tile`（28px）定义了但目前没有使用。

## 布局

- **标题栏**：`--titlebar-h` 56px，岛高 `--island-h` 48px，上下各留 4px。主进程 `window-options.ts` 的 `TITLEBAR_HEIGHT` 和这个值必须一致。
- **窗口按钮的留白**：macOS 左侧留 `--reserve-left` 84px 给红绿灯；Windows / Linux 用 `env(titlebar-area-width)` 算出右侧要让出的宽度。这个值只写在 `.titlebar` 上，避免窗口缩放时让所有消息的继承样式失效。
- **状态胶囊**：始终按整个窗口居中，空间不够时先收缩，不压到两侧按钮。
- **对话列**：`--col` 默认 760px，可以拖动边缘调整。左侧 `--rail-lane` 40px 留给轮次刻度，右侧留给任务栏。
- **抽屉**：`--drawer-width` 440px。窗口不超过 1100px 时浮在对话上方，不挤压对话。
- **断点**：720px（页面改单列）、760px（首页卡片竖排）、1100px（抽屉浮起）。窗口最小 880×600。
- **层级（z-index）**：

| 值 | 层 |
| --- | --- |
| 1–10 | 区域内部：拖动边缘 6、任务栏 8、轮次刻度 9、下拉菜单 10 |
| 29–30 | 浮在内容上的菜单和它的遮挡层、窄窗口下的抽屉 |
| 32 | hub 页面（搜索 · 关于你 · 设置 · 后台） |
| 35 | 标题栏（岛向下展开时盖住对话） |
| 50 | 遮罩对话框 `.overlay` |
| 60 | toast、工作目录面板的遮罩 |
| 61 | 工作目录首次选择面板 |
| 90 | 拖入文件夹或图片时的全窗提示 |

新增层级时选一个已有档位，不要再插入新的数字。

## 组件

现有组件优先复用，不要另写一套相似的样式。

- **按钮 `.btn`**：46px 高、12px 圆角、15px / 700。再加一个角色类：
  - `.btn-accent`：蓝底，一般页面的主操作（保存、连接）
  - `.btn-primary`：橙底，等用户决定的卡片里的主操作（允许、确认）
  - `.btn-secondary`：透明底、1.5px `--line-2` 描边，和主操作并列的选项
  - `.btn-outline`：40px，1px 描边，列表和设置里的一般操作
  - `.btn-text`：无边框，最不重要的操作
  - 尺寸修饰：`.btn-small`（34px）、`.btn-field`（48px，与字段同高并排）
  - 一张卡片里只放一个实心主按钮，其他用描边或文字按钮。参考 `prompt-card.ts`。
- **图标按钮 `.icon-btn`**：40px（标题栏 36px），10px 圆角，`--panel` 底。必须带 `aria-label`。按下状态用 `aria-pressed="true"`，变成蓝边蓝字。
- **图标**：`view/icons.ts` 的 `icon(name, size)`，24 视图框、1.9 描边、圆端，颜色跟随 `currentColor`，`aria-hidden`。新图标加进 `ICONS`，保持同样的线条风格，不引入图标库。
- **字段 `.field`**：48px、12px 圆角、`--bg` 底、`--line-2` 边，聚焦时变成蓝边。默认用等宽字体（密钥、路径、模型名）；`textarea.field` 和 `select.field` 改用无衬线字体。多个字段并排用 `.field-row`。
- **开关**：原生 checkbox `.switch`，`accent-color: var(--accent)`。整行做成 `.pref-row` 的 label，标题和说明放在 `.pref-copy` 里。
- **分段选择 `.seg`**：选中项 `aria-pressed="true"`，`--raised` 底加粗。
- **标签页 `.tabs` / `.tab`**：选中项 `aria-selected="true"`，蓝底深字。
- **chip / badge**：`.chip` 28px、等宽 12px；`.badge` 20px、11px。都用 `--raised` 底。
- **菜单**：参考 `.ctx-menu`，`--panel-2` 底、`--line-2` 边、14px 圆角、6px 内边距；菜单项 `.ctx-item` 9px 圆角，悬停时 `--raised`。附加的快捷键用 `kbd`，说明用 `small`。
- **卡片**：`--panel` 底、`--line` 边、14px 圆角。需要用户处理的卡片换成 22px 圆角加状态色描边：确认卡片 `.confirm` 是橙边，首页的待办卡片是蓝边。
- **空态 `.empty`**：虚线边、16px 圆角、居中、13px `--ink-3`，说明这里会出现什么、怎么让它出现。
- **toast**：胶囊形，位于底部居中，最多带一个蓝色操作按钮。有遮罩或 hub 页面打开时改到顶部，避免盖住按钮。通过 `showToast` 弹出，不要每个页面自己写提示条。
- **遮罩对话框 `.overlay`**：`rgba(6, 11, 22, .82)` 纯色遮罩，不模糊；需要 `aria-modal`，Esc 关闭。
- **错误和提示**：表单下方用 `.form-error`（浅红）/ `.form-notice`（蓝），13px。说明文字用 `.help`。

## 状态写在属性上

状态通过属性表达，CSS 按属性选择，不另加 `.is-active` 这类状态类：

- 无障碍属性能表达的就用它们：`aria-pressed`、`aria-selected`、`aria-current`、`aria-expanded`、`disabled`、`hidden`。
- 其余用 `data-*`：`data-open`、`data-busy`、`data-status`、`data-form`，以及语气 `data-tone`。
- `data-tone` 已有的取值和颜色：`pending`（`--line-2`）、`working`、`waiting` / `waits`（橙）、`done` / `ok`（蓝）、`error`（红）、`full`（橙，上下文快满）、`quiet` / `off`（弱化）。新状态先看能不能归进这几类。
- `[hidden]` 全局是 `display: none !important`，组件不需要另写隐藏类。

## 阴影与动效

浮起程度（只给浮层用）：

| 场景 | 阴影 |
| --- | --- |
| 提示气泡 | `0 10px 28px rgba(0, 0, 0, .45)` |
| toast | `0 16px 40px rgba(0, 0, 0, .5)` |
| 菜单、输入区 | `0 20px 50px rgba(0, 0, 0, .5)`（输入区是 .45） |
| 展开的岛 | `0 24px 60px rgba(0, 0, 0, .6)` |
| 聚焦 / 拖入时的光晕 | `0 0 0 3–6px` 的 accent，透明度 .08–.18 |

动效：

- 悬停、透明度、小位移：0.1–0.15s。颜色、边框、阴影：0.3s。
- 岛的伸缩用回弹曲线：`cubic-bezier(.3, 1.3, .5, 1)`，0.5s。其他地方不要用回弹。
- 循环动画只用来表示「正在进行」和「在等你」：脉冲点、转圈、呼吸、打字光标、猫的动作。
- `prefers-reduced-motion: reduce` 时全局关闭动画和过渡。新增的循环动画仍要单独写一条 reduce 规则，在需要时给一个静止状态（例如呼吸停在 `opacity: .8`）。

## 无障碍与键盘

- 焦点环统一用 `:focus-visible`：2px `--accent` 描边、偏移 2px。如果元素自己画了焦点样式（轮次刻度、拖动边缘），才可以写 `outline: none`。
- 只有图标的按钮必须有 `aria-label`；装饰性图形加 `aria-hidden`。
- 状态变化需要读屏播报的区域用 `aria-live="polite"`：对话区、输入去向提示、toast。
- 自定义控件补全角色和键盘操作。例如拖动边缘是 `role="separator"` 加 `tabindex="0"`，方向键调整宽度，Home 恢复默认。
- 处理 Enter / Esc 之前先判断输入法：`event.isComposing || event.keyCode === 229` 时直接返回。
- 不关闭、不削弱 Chromium 的无障碍树（AX），性能问题另想办法解决。

## 文案

- 界面上的每一句话（包括 `aria-label`、`title`、占位符、空态和错误）都放进 `src/shared/i18n/messages/` 的中英两份资源。CSS 的 `content` 里不写文字；伪元素要显示文字时，由脚本把 `t()` 的结果写到属性上，再用 `content: attr(…)` 读出。拖入文件夹或图片时的全窗提示就是这样做的（`body` 的 `data-drop-hint`）。测试会检查这一条。
- 用口语说清三件事：**发生了什么、用户的东西怎样了、下一步怎么做**。例如：「这段内容太长，一次最多 20,000 个字符。请缩短后再发，原文已保留。」
- 不怪用户，不写错误码和堆栈，不说「操作失败」这种空话。
- 动作按钮用动词，并且和结果对得上（「从这里重来」「改了重发」「后台做」）。
- 品牌名、工具和协议 id、路径、用户输入、模型输出保持原样，不翻译。

## 平台

两端用同一套界面，只有标题栏两侧的留白不同（见[布局](#布局)）。改动标题栏、岛或窗口尺寸时，macOS 和 Windows 都要看一遍；Windows 还要看 100% 和 150% 缩放。

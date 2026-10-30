# Viva 性能验证与修复交接

完整项目交接已扩展为 [Viva 全面验收与开发交接](E:/viva/release-qa-20261028/docs/project-handoff-20261030.md)，包括功能、安全、UI、规格、发布、环境、测试工具与清理事项。请优先使用总交接；本文件保留性能专题版本。

更新日期：2026年10月30日，Asia/Shanghai。面向接手代码分析、性能修复与验收的开发者。

**结论：目标未完成，不能宣告可发布。** 后台任务详情的重复重建已做未提交修复，当前代码通过完整测试、开发构建及独立实际安装的六阶段回归。大量过程首次展开、200KB长文展开和原生快速滚轮等性能门槛仍未全部通过；真实命令工具测试被 Windows 沙箱准备错误阻塞。

## 1 工作区与交付状态

| 项目 | 当前值 |
| --- | --- |
| 产品工作区 | `E:\viva\release-qa-20261028` |
| 分支 | `codex/performance-20261029` |
| 基础 HEAD | `f043e2dfffb126116a983a9e376bb5f2860ea279` |
| 测试与原始证据目录 | `E:\viva\qa-20261029-performance` |
| 当前候选身份 | 测试目录中的 `qa211-candidate-manifest.json`；基础 HEAD 不包含未提交改动 |
| 当前产物 | `package-qa223\win-unpacked`，独立安装器在 `package-qa229` |
| 提交与发布 | 当前性能候选未提交、未合并、未发布 |

以下证据路径未特别注明时，均相对于测试目录。旧报告采用追加记录，前面的结论可能已被后续实验更新；交接时优先使用本文件和对应最新原始证据。

关键入口：

- [验收合同](E:/viva/qa-20261029-performance/CONTRACT.md)
- [过程检查点](E:/viva/qa-20261029-performance/CHECKPOINTS.md)
- [评估数据](E:/viva/qa-20261029-performance/current-evaluation.json)
- [弱点记录](E:/viva/qa-20261029-performance/WEAKNESSES.md)
- [详细诊断历史](E:/viva/release-qa-20261028/docs/qa-performance-diagnosis-summary-20261030.md)
- [静态分析材料](E:/viva/release-qa-20261028/docs/qa-performance-static-handoff-20261030.md)

## 2 用户要求与不可变约束

用户要求使用真实模型模拟用户行为，覆盖功能、UI遮挡/形变、规格与性能，允许自主修复和验证，记录缺陷及尚不构成明显缺陷的弱点。

重点投诉有两个：

1. 后台任务运行时，鼠标滚轮快速连续滚动主对话，尤其已展开且代码、表格较多的长回答，感到卡顿。
2. 后台任务详情的“过程”一点展开就卡。

用户后来已允许重新占用窗口测试。此前选择优先自动验证，没有完成要求用户手动滚动的验证。

必须遵守：

- **封存 stash `12d75c9` 不使用、不测试、不合入。** 不要把本轮工作误接回封存的长对话改动。
- 保留完整正文、复制、搜索、选择与无障碍语义；不能靠关闭 AX、删内容、降低消息上限达标。
- 用户已允许取消全页 DOM≤4000 的硬门槛，DOM数量仅作诊断；其他性能门槛未获准降低。
- 用户曾授权满足条件后合入发布，但当前仍未满足发布条件。
- 无需新增跨会话消息或外部交接评论；本交接文件尚未发送给第三方。

## 3 当前代码改了什么

### 后台任务详情与过程列表

主要文件：[tasks-page.ts](E:/viva/release-qa-20261028/src/renderer/view/tasks-page.ts)。

原实现展开“过程”会重建整个详情，包括长回答、输入框和滚动容器；真实流式更新也会重复重建。已加入：

- 按容器记录先前渲染状态，仅过程开关变化时局部更新过程区域。
- 同一任务且状态、handlers兼容时保留主区域、正文、输入框及滚动容器，复用原有 `renderThread` 协调。
- 过程行按 `traceItems().key` 缓存，只重建内容、时间或状态变化的条目；收起清缓存。
- 任务状态变化仍走完整更新与输入保留逻辑，避免输入模式不切换。

测试文件：[task-steps-render.test.ts](E:/viva/release-qa-20261028/test/task-steps-render.test.ts)。动态DOM回归另在测试目录，覆盖20/200/500条过程及节点、草稿、焦点、选区、增量正文和结束状态。

### 其他尚未提交的改动

- 历史搜索 iframe 隔离候选：`history-search-frame.ts/html/css`，及 `app.ts`、`index.html`、`styles.css`、对应测试和 smoke 支撑。
- `column-resize.ts`：读取 `clientWidth` 后再写 `--col`，避免重复读写交错。
- `main.ts` 的 `showNotice`：smoke模式提前返回，避免测试原生通知注册改写开始菜单入口。正式运行通知行为未改。
- 测试 harness 禁用原生通知支持探测。因此这些自动化测试不覆盖正式原生通知功能；无障碍功能仍开启。

交接时 `git status --short` 还包括 `live-scenarios-app.ts`、`smoke-perf.ts`、`smoke-timeline.ts`、`smoke.ts` 等验收支撑文件。应审核完整 diff 与新文件，不能只审过程列表文件。

## 4 性能证据与当前判断

| 场景 | 结果 | 可以得出的结论 |
| --- | --- | --- |
| 真实模型约8019字，18表格/18代码块 | QA198点击2.6ms，随后1秒最大rAF间隔16.6ms，节点保留，AX最大11.271ms | 此样本通过局部更新验证；不同生成内容不能算严格前后加速倍数 |
| 已有500条过程追加1条 | QA201同步2.4ms，AX最大4.424ms | 增量行复用有效，不能代表首次展开 |
| 首次展开500条过程 | QA217展开后的 `scrollHeight` 读取22.6–26.8ms；AX单次56–60ms | 同步布局与AX均有明显成本，未解决 |
| 200KB全文冷展开 | QA173昂贵AX在点击后约259–266ms结束；后续对照也超150ms | 全文预算失败 |
| 长文宽度变化 | QA157移除6232、新增6238个InlineTextBox，3594个StaticText子节点关系变化 | 支持宽度变化放大AX重建成本，不能直接当滚轮投诉根因 |
| 后台真实输出与自动滚轮注入 | 部分样本无明显主线程长任务，但有动画丢帧诊断 | 尚不能证明物理鼠标快速连滚已通过 |

特别注意：双 `requestAnimationFrame` 和 Long Tasks API 会漏掉延后的AX工作。QA213两轮双rAF约91/96ms，但昂贵AX在点击后420/303ms才结束。不能用“handler短”“rAF正常”或“无LongTasks”单独宣告不卡。

### 已试过但未采用的方向

- Electron44.10.0、45.1.0隔离运行：完整文本保持，AX仍约165–178ms；未改产品依赖。部分模型代理启动错误意味着这些实验不是升级兼容性验收。
- 删除过程轨道空装饰节点：AX只小幅下降，仍超过50ms，视觉不完整；未采用。
- 代码/表格 `overflow:visible`：无稳定收益；压力夹具没有真实横向溢出，不能证明宽内容保真；未采用。
- 过程行 `contain:layout style`：文字哈希、高度和滚动位置一致，但无稳定性能收益；未采用。
- 首次列表离线组装：产品候选仍约31ms，已撤回。早期诊断的约8ms来自延后插入绕过了同步滚动布局，不是可靠收益。

重点静态入口是 `renderTasksPage`：`updateSteps` 后，为保持底部定位读取 `scroller.scrollHeight` 并写 `scrollTop`。这次读取触发布局，但简单挪到下一帧只是转移工作，不等于降低总卡顿。任何调整必须验证最终位置、用户滚动竞态和完整AX。

## 5 真实工具测试的独立阻塞

QA220开始只记录了步骤数；补抓工具事件后发现首条纯乘法命令实际失败。QA222修正了测试配置后仍复现：

```text
SetNamedSecurityInfoW failed (Win32 5):
grantWrite(E:\viva\qa-20261029-performance\desktop\profile-qa222-task-steps\workspace)
```

当前已核实：

- 应用新话题会沿用当前话题cwd，仅设置 `AGENT_CWD` 不会覆盖复制历史中的目录。
- QA222等待新话题ready后，通过应用 `switchWorkDir` 切到本轮独立工作区，`getWorkDir`确认正确。
- 权限事件只有工具ID；参数在关联 `tool_call` 事件。按taskId/toolCallId关联后，仅批准 `Write-Output (小整数 * 小整数)`，允许附带description，不放开其他命令。
- 首条命令仍在新目录的沙箱准备阶段失败；任务立即停止，未修改ACL或扩大权限。
- QA222的3条过程展开3.6ms和runner exit0，不代表12次计算成功。

证据：`desktop/qa220-live-after-approval.json`、`desktop/qa222-task-steps.json`。不要盲目重复同样命令或把该失败混写成UI性能问题。

## 6 功能回归与安装验收

| 验证 | 当前状态 |
| --- | --- |
| 类型检查、构建 | QA211通过；此后无保留的产品改动，撤回尝试后已重新构建 |
| 完整测试 | QA211原生Windows 776/776通过；QA215也通过但属于已撤回尝试，不能替代当前身份记录 |
| 当前开发构建六阶段 | QA219全部通过，快捷方式未再次变化 |
| 打包内容 | QA223的297个out文件与ASAR完全一致；374依赖清单存在，5个仅描述/脚本字段被裁剪 |
| 同字节打包程序运行 | QA226从独立临时目录六阶段全部通过 |
| 当前实际安装 | QA229安装后142个payload哈希全匹配，六阶段全部通过 |
| QA229卸载隔离 | 卸载exit0，目标app目录已不存在；卸载前后快照确认既有注册项/快捷方式不变，QA229注册键已移除 |

QA229证据在 `package-validation-qa229`，尤其：

- `manifest.json`、`installer-built.json`
- `install-temp-source.json`
- `installed-temp-source-six-phase.json`
- `before-uninstall-temp-source-isolation-check.json`
- `uninstall-temp-source.json`
- `after-uninstall-temp-source-isolation-check.json`

ASAR SHA256：`b259d9852ff662ec45bde95f64795d4d1c81d8032c60e15d41cad6b673cd1303`。

QA229安装器 SHA256：`3d0eee7c295ce610f235e9be7380a3f97ad6aa0531b505266549a083d713da67`。

独立QA注册与临时目录安装不覆盖正式升级、正式快捷方式和原生通知；更不替代性能门槛。

### 程序目录相关启动异常

QA224/225在 `package-qa223\win-unpacked` 直接启动，进入应用前即以 `0x80000003` 退出，日志为空。可执行文件的ASAR头完整性值匹配，不能归为该值过期。

将142个文件原样复制到C盘独立临时目录后六阶段通过。交叉对照进一步确认：临时目录exe配原cwd通过；原目录exe配临时cwd仍失败。**失败跟随程序所在目录，不是cwd。** 具体ACL、路径或系统机制尚未定位；未通过关闭安全功能规避。

证据：`qa224-integrity.json`、`qa226-copy.json`、`qa226-path-acl-normalized.json`、`qa227-smoke/result.json`、`qa228-smoke/result.json`。

## 7 快捷方式与环境清理

QA210旧测试曾把开始菜单 `Viva.lnk` 改指向其临时安装。原快照只有hash，无原目标或字节，因此无法声称恢复原样。当前链接备份位于 `package-validation-qa210/shortcut-backup-after-detection`，是检测后的版本。

**用户最新决定：这台电脑平时不用正式Viva，入口处理“随便”。无需再追问正式exe路径。** 推荐接手时核对链接仍指向QA210后，备份并移除这个测试入口，再按精确GUID卸载QA210；不要伪造一个“原正式路径”。本交接轮未执行这项清理。

- QA210仍保留：GUID `795dd037-1f8a-4a16-8212-074c6de61d94`，安装根目录在 `package-validation-qa210/install-temp-source.json`。
- QA229已卸载：GUID `c9aa8334-ebed-46a7-9fce-4df93654b62d`，清理验收完成。
- 更旧QA140/QA164未删除，不应把它们称为正式生产安装。
- QA226临时复制产物仍保留，路径见 `qa226-copy.json`；原始证据目录不要批量删除。

## 8 接手顺序与完成门槛

1. 读合同、当前工作区diff和源码清单。核对新修改是否仍与证据对应；不要只看HEAD或旧测试绿灯。
2. 按用户最新决定收尾QA210入口与安装清理，验证不影响其他注册项和快捷方式。
3. 优先解决“过程首次展开”的同步布局与AX成本，补少量/大量步骤、长detail、运行中/结束后、阅读中/底部两类滚动位置对照。不要只优化handler计时。
4. 补原始投诉的可靠原生快速连续滚轮测试：真实后台任务、已展开代码表格长回答，同时观察主线程、屏幕帧与丢帧，而非单次大delta或仅rAF。
5. 继续200KB全文与原生窗口尺寸性能门槛；保留全文选择hash、语义与锚点检查。
6. 独立排查真实命令工具沙箱准备失败；修复后在任务运行时保存每个工具的参数、结果、状态，完成12步任务，不能靠过程行数推断成功。
7. 每次保留的产品修改后刷新源码身份、相关回归及安装证据，再运行评估器。

合同关键门槛：1000轮历史、200条当前/100条旧话题范围；200KB全文507节保真；预览和全文各至少5个独立样本p95≤150ms；滚动帧p95≤20ms/max≤33.4ms；阅读堆增长≤30MB；锚点漂移≤2px；重复大于50ms主线程卡顿必须解释并处理；输入反馈≤100ms、就地导航≤200ms各至少20次；原生Windows尺寸/WPR矩阵及100/150%应用缩放；空闲、流式、重复阅读后的资源有界。

尚有false/null的聚合项代表缺证据或失败，不能逐项解释成新发现的功能缺陷。完整性能验收通过前保持目标未完成。

## 9 常用命令与证据纪律

产品目录执行：

```powershell
npm run typecheck
npm run build
npm test
```

测试目录执行：

```powershell
node E:/viva/release-qa-20261028/node_modules/typescript/bin/tsc -p tsconfig.json --pretty false
node evaluate.ts current-evaluation.json
```

- 沙箱中测试曾出现MoveFileExW/EACCES，原生Windows相同集合通过；区分环境失败与产品失败。
- 验收脚本多为一次性证据脚本，拒绝覆盖旧输出。新轮使用新编号，先检查是否有实例仍活着。
- 端口19348属于隔离harness。操作前核对PID、profile、源目录；结束用 `finish-owned-qa.ts` 正常退出，保存cleanup。
- 跟随已有进程/session handle；观察超时不等于进程结束，不能据此重复启动。
- Chromium事件有嵌套，不能把父子耗时相加。只按事件起点筛窗会混入跨窗工作；保留边界说明。
- Electron45的trace可能是Perfetto二进制，即使扩展名为json；原始文件保留，离线转换后分析。
- Windows asar API使用本机路径分隔符；最初正斜线路径造成的缺包误报已保留并纠正。
- `current-evaluation.json`中部分历史证据链接尚待统一整理；当前安装结论以QA229原始证据为准。评估器输出不替代逐项证据审阅。

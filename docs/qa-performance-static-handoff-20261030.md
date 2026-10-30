# Viva 性能诊断：当前静态分析交接摘要

更新：2026-10-30，证据截至 QA162。本文替代旧交接报告的当前结论；逐轮历史保留在 qa-performance-diagnosis-summary-20261030.md。整体性能验收仍未通过。

## 1. 原始问题与边界

用户在后台真实模型任务持续输出时，快速连续滚动鼠标滚轮，浏览已展开且代码、表格较多的长回答，感觉卡顿。

该原始场景尚未完成可靠的原生连续滚轮验收。QA84 注入 320 个 wheel 事件并有真实输出的对照未复现明显卡顿；QA139 原生大 delta 只形成一个 trusted wheel，且无后台任务，不能代替快速连滚。下列窗口缩放、搜索与冷展开问题是独立证实的性能路径，不能直接当作原始投诉的完整根因。

## 2. 分项结论

|问题|实测与定位|当前状态|
|---|---|---|
|列宽回调同步布局|原生 150% 最大化/还原时 apply 耗时 39.108/49.297ms；读取 clientWidth 后写 --col，再读 clientWidth，触发同步样式/布局|已改为一次读取；同场景回调降至 0.067/0.074ms，但整体卡顿未解决|
|150% 调整窗口剩余停顿|改后仍约 100ms；QA151 目标 RunTask 99.452ms，其中 RunAccessibilitySteps 99.305ms，SerializeLifecycleStage 89.717ms|明确定位 renderer AX 更新/序列化，未解决|
|完整长文冷展开|QA142 五次全文 247.9–256.7ms，超过 150ms 门槛；QA111 单次总 259.452ms，AX 169.474ms、样式布局 45.216ms|未解决；QA142 为列宽修改前证据，不冒充最新候选重测|
|回顾/搜索切换|基线约 240–270ms；移除 input 仍卡，空 label 亦可触发；改外层 div 并将原 input 移至同源无脚本 iframe 后，QA108 20轮最大帧间隔 14.5ms、零长任务|已有候选修复；完整读屏、原生输入及缩放矩阵仍待验收|
|browser/UIA 长工作|100% 原生窗口操作 renderer 最大 16.6ms/零长任务，但 browser 仍 186–199ms；精确微软符号确认 BulkFetch/Traverse 栈|UIA 跨进程查询参与，外部客户端未知，不能把全部时间归因截图工具|

AX 即无障碍树。上述 trace 时间存在父子嵌套，不可相加。

## 3. 最值得静态分析的证据链

QA154 同初始列宽、四个独立 renderer 的 ABBA 对照：

- 正常列宽从 755→760px、正文 705→710px：AX 更新 97.277/100.084ms。
- 仅实验中固定初始列宽：AX 更新 22.974/22.496ms，无长任务。
- 内容一致、完整 AX 开启；操作为程序化 setBounds，不能代替原生输入验收。固定列宽是诊断，不是可接受的功能修复。

QA157/158 持久 CDP AX 会话的前后身份差分：宽度变化时 InlineTextBox 移除 6232、新增 6238，保留 328；3922 个 StaticText 保留，其中 3594 个 childIds 改变。无 resize 对照保留 6547 个 InlineTextBox，StaticText childIds 变化为零。

这支持文本布局变化伴随大量 AX 文本子节点身份更新。它不是实际 native serialization payload 计数，也不证明全树重建。CDP 本身改变观测条件。

负载范围必须准确：目标长回答为 35047 字符、60个代码块、60个表格；整页实际包含当前 200条消息、100个 markdown 区域、188个 pre、189个表格。另四条未展开长预览合计贡献大量富文本，并非隐藏历史残留或重复渲染。目标回答 1747 个 InlineTextBox 全部更换，目标外另有 4485 个更换；不能把整页成本都归于目标回答。AX code 角色计数不等于 pre 数量。

优先假设：实际正文宽度变化导致大量文本布局/AX inline 子节点失效，序列化成本随整个已渲染消息窗口放大。具体 Chromium 调用因果、可避免范围及后台更新是否走同一路径仍待验证。

## 4. 请检查的源码与问题

产品根：E:\viva\release-qa-20261028
分支：codex/performance-20261029
HEAD：f043e2dfffb126116a983a9e376bb5f2860ea279
注意：必须包含当前未提交修改和未跟踪新增文件；仅看 HEAD 或旧 ZIP 会漏掉候选修复。

- src/renderer/view/column-resize.ts：apply 第62行附近；--col 写入、clamp、resize 回调及重复写入是否造成可避免失效？保持拖宽与响应式行为。
- src/renderer/view/thread.ts：answer-more 路径、预览生成、THREAD_MAX=200；区分必要正文创建与无关旧正文更新。
- src/renderer/view/render.ts、view/reconcile.ts、app.ts：真实后台流式更新是否触及未改变的主对话节点、属性或样式？需要调用链证据，不能仅凭框架推测。
- src/renderer/styles.css：列宽依赖、文本换行与布局传播；避免以改变代码块尺寸/减少正文换性能。
- src/renderer/history-search-frame.ts/html/css 及 app.ts、index.html：input adopt、焦点/IME/选区、失败/晚到 load 回退、监听器生命周期、读屏与快捷键。
- 精确 Chromium 152.0.7977.130 AX 源码：StyleChanged、TextChangedWithCleanLayout、ChildrenChangedWithCleanLayout、ClearBlockFlowCachedData 与 SerializeChanges。源码存在这些路径不等于已证明本次执行路径。

每项请输出：文件/行号和调用链、已证实事实、假设及反证、最小可证伪实验、保留完整功能的修复建议与风险。先只读分析，不改代码。

## 5. 已尝试而不能作为修复的方向

- 非继承 --col 并同步六个消费者：AX 约 88–98ms，无稳定实质改善。
- code display:block;width:max-content：AX 仍约 91–98ms，且改变代码块/全文高度，拒绝。
- content-visibility/分组方案曾仅向 AX 暴露 10/507节，拒绝。
- composer label 改 span、aria-live 关闭等既往实验没有解决冷展开。
- 同时记录 browser/renderer 的详细 trace 曾淹没缓冲、没有覆盖动作（QA150）；该轮不得用于归因。QA151 renderer-only 详细 trace 覆盖有效。

## 6. 环境与验证状态

Windows，系统 DPI175%，显示120Hz；Electron44.7.0 / Chromium152.0.7977.130。完整 AX 开启。100%/150% 指应用缩放。

另有发行程序启动环境问题：E:\viva 新生成 EXE 继承 Low mandatory label，实际进程 Low；同哈希 C TEMP 副本为 Medium 并正常运行。窗口站创建失败路径捕获错误5。不能归因搜索 JS，不修改安全策略或使用 --no-sandbox 绕过。

最新候选 QA161：775/775测试、严格类型检查通过；QA147构建通过。QA162 当前开发构建六阶段 smoke 的结果文件显示均 exit0。QA140 已安装产物属于列宽修改前候选，不能算当前候选安装验收。回归通过不代表性能通过，不能发布就绪宣告。

约束：保留完整复制、搜索、选择、读屏和内容；不关闭 AX，不降低 150ms 完整冷展开门槛，不删预览或减少200条消息合同。DOM数量仅诊断。封存 stash 12d75c9 不应用、不测试、不合并。

## 7. 可复核证据

统一根：E:\viva\qa-20261029-performance（以下相对该目录）。

- desktop/qa147-longtasks.json、qa148-column-comparison.json：列宽修改前后。
- desktop/qa151-ax-task.json、qa151-rich150.trace.json：剩余约100ms原生窗口停顿。
- desktop/qa154-comparison.json：同初始宽度 ABBA。
- desktop/qa157-identity-analysis.json、qa158-identity-analysis.json：AX身份差分和阴性对照。
- desktop/qa159-ax-regions.json、qa159-rich-subtree.json、qa160-dom-response.json：负载与区域范围。
- desktop/qa108-candidate-navigation.json：搜索候选；desktop/qa138-frame-load.json：字体加载夹具。
- desktop/qa111-expand-window.json、qa111-cold-expand.trace.json：冷展开细分；完整逐轮报告记载QA142五次结果。
- symbols-qa145/manifest.json、resolved.log、stack-resolved.log：browser UIA符号。
- qa136-context/：启动完整性环境；qa161-candidate-manifest.json：候选文件哈希。
- qa161-full-tests-native.log、qa161-typecheck-native.log、qa162-smoke/result.json：当前回归。

旧交接 ZIP 仅到 QA85，已经过时。本次仅整理既有证据与核对当前源码/结果，未新增性能实测。

## 后续补充（QA166–169）
真实输出期间目标正文节点与宽度保持；约52Hz Electron滚轮注入仍未复现主线程长任务。但QA169发现每个注入形成独立begin/first-update/end手势，且动画跟踪存在非零dropped计数。rAF最大8.5ms不等于屏幕无掉帧，不能把注入当物理连滚验收。详细证据见逐轮报告QA169和desktop/qa169-jank-details.json。

QA170修正：原生sky单次滚轮也产生独立begin/first-update/end，故QA169手势形态不能单独证明Electron注入异常。仍缺连续原生滚轮证据；单次动作后500ms rAF max8.4ms、无longtask，trace缺end不能记全覆盖。

QA172关键补充：双rAF展开计时会漏掉延后AX。两次fullMs90.1/96.4ms时，trace仍显示AX点击后101–268ms/114–291ms执行，不能当性能改善。见desktop/qa172-click-ax-timing.json；CSS containment原型未证明收益，不合入。

QA174补充：快样本昂贵AX是后续独立BeginMainFrame任务，紧前调度来源明确指向Chromium CommitAXUpdates:3603延迟重试。慢样本布局与AX同一帧任务。解释双rAF计时差异，不解释为CPU工作减少；详见desktop/qa174-ax-task-ancestry.json。

QA175：冷展开AX身份差分显示正文子树新增23139原始节点、移除3；原预览几乎保留。正文外新增65/移除43，未见整页旧文本子节点重建。与宽度变化时大量旧InlineTextBox失效不同。稳定ID不排除重新序列化，详见desktop/qa175-subtree-difference.json。

## 最新优先线索：后台任务“过程”展开即卡（2026-10-30，QA183）

用户补充：后台任务的过程展开，一点就卡。应优先单独复现这一动作，不能用主对话滚动正常替代验收。

### 已核对的静态调用链
- app.ts:804：toggleTaskSteps dispatch tasks_page_steps。
- tasks-state.ts:420：仅翻转 tasks.page.steps。
- view/render.ts:123：tasks.page 引用变化使 renderTasksPageIfChanged 调用 renderTasksPage。
- view/tasks-page.ts:226：renderTasksPage 读取滚动几何，再 keepingInput + container.replaceChildren(sideView(...), mainView(...))。
- 同文件 mainView:210 附近：新建 .tp-thread 并 renderThread，再新建 .tp-main、.tp-scroll 和输入表单；stepsView:136 附近一次生成全部 trace 行。

结论：展开局部“过程”会走整个任务详情重建路径，这是已证实的静态行为。长回答 DOM 创建、布局和 AX 更新被放大的可能性高，但尚未获得该点击的有效 trace，不能称已锁定实测根因。还应检查真实任务流式更新导致 tasks.list 变化时，是否重复走同一路径。主对话节点缓存正常不代表后台详情缓存正常。

### 最新复现边界
QA183 修复验收脚本字符串语法并通过严格类型检查后启动隔离实例。后台提交未成功，页面明确报“没有交给后台：当前对话已经结束，请稍后再试”；task_update=0，未进入过程点击。因此这一轮不是性能失败样本，也不是通过样本。此前任务数量上限、启动时序等解释仍无证据，不作为根因。正常退出已确认 cleaned=true、remaining=[]、API不可达。
证据：E:/viva/qa-20261029-performance/desktop/qa183-task-steps.json。

### 建议静态分析者回答
1. 能否仅更新 .tp-steps，保留回答、输入框和滚动容器节点？比较过程开关和任务实际内容更新，避免缓存漏更新。
2. 流式更新能否复用 thread reconciliation，而不是每次从新容器开始？必须保留任务切换、输入草稿、IME、焦点/选区、滚动和自动跟随行为。
3. 分别测少步骤/多步骤、短正文/代码表格长正文、任务运行中/结束后；记录点击 handler、布局、AX、实际呈现，持续观察点击后至少1秒，避免双rAF漏掉延后AX。
4. 不以关闭AX、删正文或降低完整功能要求作为优化。未经实测，不宣告此问题修复。

### 其他最新证据修正
- QA173 冷展开五次 AX 结束边界为点击后约259–266ms，仍超150ms；双rAF快样本会漏测延后工作。
- QA177 使用与实际 Electron PE debug ID 匹配的官方 Breakpad 符号，516个唯一栈地址解析509个；序列化相关栈支持继续检查AX成本。栈含CPU及上下文切换记录，出现次数不是CPU占比，也不是本次过程点击证据。
- QA164 当前候选独立安装身份下142个payload哈希匹配，六阶段smoke通过且清理通过；旧文“当前安装尚未测”已被后续证据更新。这不改变整体性能FAIL。

本轮未修改产品代码、未提交、未合并、未发布；封存 stash 12d75c9 未使用。

## QA184–187：真实后台过程展开，2026-10-30
- QA184 在观察器初始化前读取 ready 失败；无性能结论。QA185 等待观察器后 Ctrl+N 新建有效会话，真实任务提交成功，排除了持续被旧会话 missing 拦截的夹具问题。
- QA185 短正文73字、1步骤：点击handler4.3ms，thread/input均更换。静态重建行为得到动态佐证，未复现明显卡顿。
- QA186 真实任务完成时观测到9623字、6025次更新，未达到夹具15000字条件而退出；无点击性能结论。
- QA187 夹具改为8000字后点击（性能门槛未更改）：正文8062字、22表格/22代码块、1步骤。handler11ms，随后观察窗口最大rAF间隔16.7ms，LongTasks为空。详细trace中RunAccessibilitySteps最大14.658ms，SerializeLifecycleStage最大10.652ms；父子时间不可相加。trace包含点击和观察完成标记。
- QA187 thread/input均更换；sameText=false发生在真实流式继续输出期间，不能解释成内容丢失。需在同步点击边界采样节点，避免后续流式重建混入归因。
- QA187正常清理：cleaned=true、remaining=[]、API不可达。产品仍未改动。
- 下一步：当前只有1条过程，不代表大量工具/思考过程的展开负载。需要多过程条目和长detail对照，并验证点击后的正文/输入节点保留方案，不能仅凭重建就宣称已找到用户卡顿根因。新会话恢复解决了验收路径，未证明历史会话missing是产品缺陷。
证据：desktop/qa185-task-steps.json、qa186-task-steps.json、qa187-task-steps.json、qa187-task-steps.trace.json（根E:/viva/qa-20261029-performance）。整体性能FAIL保持。

## QA188–194：过程局部更新候选与验证（2026-10-30）
产品改动：src/renderer/view/tasks-page.ts 增加按容器WeakMap记录上次输入，仅所有其他输入引用一致且steps变化时局部更新过程列表，保留正文、滚动容器、输入框、原按钮。关闭清缓存；任务内容/选择/其他状态变化仍完整更新。新增test/task-steps-render.test.ts验证复用条件与失效条件。

验证：相关6项测试通过；构建通过。QA190真实Electron合成DOM回归，20/200/500条长detail，反复展开/收起全部行数、节点身份、草稿/焦点/选区、正文内容、新增回答和关闭行为全部通过。500条同步handler31.2–33.9ms，不能当绘制或完整AX时间。QA189原先嵌入JS换行转义错误，修正为独立QA190保留失败证据。

QA188/191真实任务在32秒等待条件内未达到正文体量而退出，非产品性能结论。QA192将等待上限扩到180秒并在已有handle继续观察，实际成功：8025字、22table/22pre。点击handler3.6ms；同步断言thread/input/toggle保持、草稿保留、焦点保留、选区[1,3]保持。随后真实流式更新仍触发整页重建，因此1秒后sameThread/input=false，不冒充流式路径已优化。rAF最大33.3ms、LongTasks为空，仍不能宣告全场景不卡。正常退出cleaned=true、无残留/API。

QA191完整测试在沙箱内689通过/87失败，日志包含MoveFileExW EACCES等环境错误；QA193相同测试集正常Windows环境776/776通过、无跳过。未以沙箱错误当产品缺陷，也未忽略失败记录。

当前状态：局部展开修复为未提交候选；仍需多过程完整呈现/AX对照、真实多工具过程验收，以及流式详情重建优化。更新current-evaluation：旧安装验收不适用于新候选，installedCurrent=false，smoke/installed待重跑；整体性能FAIL保持。封存stash未使用。

## QA195–200：流式详情复用候选（2026-10-30）
QA195补齐20/200/500条过程展开后的1秒renderer trace。500条展开AX单次最大54.670/57.539ms；200条22.778/21.732ms。局部展开仍有大量新增AX节点成本，不能宣告不卡。analyze-qa195.ts及desktop/qa195-boundaries.json保留分窗结果；RunTask可能跨窗口边界，不可把sum/max当严格归因或相加，周期性AX最后结束时间也不是展开完成时间。

产品新增：同一任务且status/handlers相同，保持.tp-main/.tp-scroll/.tp-thread及输入表单；调用原有renderThread增量协调；更新侧栏、标题和状态；仅过程相关输入变化时更新过程区域。status变化保持原完整更新与keepingInput，避免输入模式错误。缓存记录now以正确刷新相对时间。尚未优化thought/tool更新时过程区域整体替换。

QA196首次DOM断言把整个thread.textContent作为不可变子串，追加回答会改变操作栏位置导致失败；QA197改为检查旧Markdown节点身份和完整正文，未改变产品绕过断言。20/200/500条全部通过：过程开关、输入焦点/草稿/选区、追加正文后thread/input/旧Markdown身份保持、新过程行更新、完成状态切换“接着问”及草稿保留、关闭清空。

QA198真实模型：8019字、18table/18pre。展开同步handler2.6ms；点击瞬间节点/草稿/选区断言通过，随后1秒持续输出中thread与input仍相同，正文变化符合继续输出。最大rAF16.6ms，无LongTasks，trace AX单次最大11.271ms。与QA192不同生成内容/不同运行，不能宣称严格配对加速倍数。所有实例已正常清理。

QA198类型检查通过；本轮构建通过；QA199正常Windows完整776/776测试通过，无跳过。当前候选未提交、未发布；source/smoke/安装包仍需当前代码验证，整体性能FAIL。下一步继续验证真实多工具过程、过程列表增量更新，以及剩余长文冷展开/resize AX性能问题。

## QA201–204：过程行增量复用（2026-10-30）
产品：tasks-page.ts 以traceItems的key缓存过程行，只重建内容/时间/tone变化的行，reconcileChildren保留未变行和列表；展开按钮保留；收起时删除行缓存，避免持有整个已关闭列表。整体详情复用与状态变化回退保留。
QA201合成20/200/500条长detail过程追加1条：同步更新1.3/1.7/2.4ms，完整窗口AX最大0.639/2.137/4.424ms；未变行与按钮身份保持，变化的detail正确更新；草稿、正文、焦点、结束模式等既有DOM断言全部通过，清理成功。
注意：原analyze-qa201把起点在窗口内、终点超出窗口的RunTask纳入，出现58ms而实际包含end标记之后的测试工作。qa201-contained-boundaries.json仅统计完整落在窗口内的事件，500条窗口RunTask最大5.616ms；不代表跨边界任务全部没有成本，也不应按累计值相加嵌套事件。首次500条展开成本未解决，QA195约55–58ms AX仍作为历史失败证据。
QA202真实模型多工具场景：请求依次执行纯整数乘法，遇权限卡后只允许严格匹配Write-Output(两个小整数乘法)的命令，最多12次/60秒，其余不授权。到6条以上过程后测量展开；最终7条过程，handler4.1ms，观察5秒max rAF8.5ms、无LongTasks；thread/input以及即时草稿/焦点/选区保持，正常清理。这里只证实真实工具流程/UI，未完成12次计算验收。清理后尝试读取该profile trace.db，按taskId/起始时间未找到记录，因此不能声称计算结果全成功。后续真实工具验收需在运行时保存过程标题、详情和状态，不能仅数步骤。
QA203：产品及QA脚本严格类型检查通过，构建通过，Windows完整测试776/776通过，无跳过。未提交、未发布。新候选仍需smoke/安装与剩余性能合同；总体FAIL保持。
证据：desktop/qa201-steps-dom.json、qa201-steps-dom.trace.json、qa201-contained-boundaries.json、qa202-task-steps.json、qa202-task-steps.trace.json；qa203-typecheck.log、qa203-full-tests-native.log。

## QA205：当前候选六阶段集成回归（2026-10-30）
按qa204-candidate-manifest.json逐文件哈希校验当前候选后运行隔离开发构建smoke，setup/walkthrough/relaunch/memory/resume/timeline六阶段全部exit0。结果、每阶段日志和截图位于qa205-smoke；本轮未修改产品源码。
只读Win32_Process检查记录的六个根PID均不存在，root-process-check.json明确仅核对根进程，不冒充完整后代清单。current-evaluation.regressions.smoke更新为true，installed仍false。
再次执行evaluate.ts，整体pass=false。未完成或证据不足项目包含保真完整矩阵、全文150ms、绘制数量/帧/锚点、剩余长任务、原生尺寸WPR矩阵、反馈与资源矩阵及当前安装产物。聚合false不等于每项新发现功能缺陷；不能用本轮smoke通过替代性能合同。
源码排除：聊天renderMarkdown的代码块当前直接创建code文本节点，未调用highlight.js构造语法span；styles.css有高亮样式不代表聊天正文使用它。因此“减少聊天代码高亮span以降低AX”不适用于当前实现，本轮未尝试此类产品变更。
当前优先级仍是剩余长文/resize AX成本和大量过程首次展开成本。QA205仅刷新集成回归，不增加性能PASS声明。新安装验收待刷新。

## QA206–207：装饰节点与运行时对照（2026-10-30）
QA206同renderer ABBA诊断，在500条过程展开后移除每条轨道中两个空装饰span（保留全部文字、过程行和轨道宽度；视觉刻意不完整，仅诊断）。原版AX最大58.796/58.060ms，去装饰51.873/53.842ms；仍>50ms，handler约30–33ms。不是独立renderer随机实验，且删除发生于原点击布局后，不能直接当产品性能收益。未合入任何装饰删除或样式变更。

官方npm只读查询：当前44系列44.10.0，latest45.1.0。QA207通过@electron/get开启校验下载官方44.10.0（未发现mirror/custom/checksum覆盖环境变量），zip SHA256 64c2d874fea1bd4c8d2e1f2df3a547497044159a6b853dee7fcdff357ff0e3cd；独立临时目录解压，exe SHA256 4d313d128cb9d2412dc17a7beefb1d79269825e3a3ffa0af611c203c836a1ab6。项目依赖与既有44.7.0均未修改。

QA207五个全新renderer运行身份确认Electron44.10.0/Chromium152.0.7977.169，全文507标题/表格/代码、选择文本hash保持9966d570777e5f79e2e6d6bd9174b88fc4789c80474a2c3fc8f2d148778cbd59。双rAF为258.854/263.021/261.448/254.600/89.090ms；昂贵AX结束边界为点击后258.637/262.819/261.212/254.374/299.939ms，AX自身165.510–171.680ms。第五个快计时仍漏掉延后AX，不能视为通过。全部五轮cleaned=true，进程/API退出。
结论：同主版本更新未解决200KB冷展开150ms门槛；没有据此升级产品。此为独立运行时实验，不覆盖当前候选原生窗口/安装验收。当前overall FAIL不变。
证据：desktop/qa206-steps-dom.json、qa206-contained-boundaries.json；runtime-qa207/download.json、extracted.json；desktop/qa207-cold-expansion.json、qa207-measured-boundaries.json及每轮trace/cleanup。

## QA208：最新稳定Electron45.1.0隔离对照（2026-10-30）
独立下载官方Electron45.1.0，@electron/get启用校验；zip SHA256 55eaba17abff7b5bba6c3bbc85068967379024fe742fe9c7fdba9118922ccbe2，exe SHA256 c579acaab64b1c456bda1693cdf1a2ec7e4de7738b0e2d1b6349d60e8087143c。运行身份为Electron45.1.0/Chromium156.0.8078.49。未改项目依赖或当前候选代码。
五个新renderer，507标题/表格/代码及选区hash全部保持；全部cleaned=true。双rAF254.927/263.770/257.101/255.966/87.652ms；昂贵AX结束边界254.707/263.510/256.773/255.751/290.405ms，AX自身165.652–178.057ms。第五次再次出现双rAF漏计延后AX。仍不满足150ms，最新稳定运行时未解决此负载。
新版本contentTracing输出为Perfetto二进制，虽然文件仍叫.trace.json；旧JSON解析失败不代表trace失效。保留原始文件，使用Perfetto官方v59.1 Windows工具离线转为.converted.json后分析。工具来自官方tools/traceconv清单，SHA256 3acc5aca1c764541033a82ba3bb0a47524b5c3c0aa194eea8d9a7b0cdb346bdc，清单保存在qa208-traceconv-bootstrap.txt。以traceconv.exe命名时入口自动注入convert，因此实际用法为traceconv.exe json input output；最初重复convert参数失败，未覆盖原始证据。
兼容性边界：实验运行时stderr出现safeStorage弃用提示及ACP代理启动失败；QA207部分日志也有代理启动错误。本组仅是合成历史渲染性能对照，不算新版模型/工具功能或升级验收通过，未将它作为当前44.7.0产品回归。不采用运行时升级作为本次性能修复。
证据：runtime-qa208/download.json、extracted.json；desktop/qa208-cold-expansion.json、qa208-measured-boundaries.json、qa208-fidelity-cleanup.json、各原始/转换trace与stderr。
当前候选仍为qa204源清单，QA205六阶段smoke有效。整体FAIL保持；安装产物和其余合同项继续待验证。

## QA209–212：打包验证、发现快捷方式隔离缺陷及保护（2026-10-30）
QA209打包完成，qa204候选297个out文件与ASAR逐一匹配，ASAR SHA256 59e127d6c117d2d49fa54db596e91e5b7f568c7c8b4cb74dca422ad88b9b3890。
QA210独立GUID 795dd037-1f8a-4a16-8212-074c6de61d94，QA程序名VivaPerformanceQA20261030QA210；安装器SHA256 977a7783c19a261cbe106e8bb4f0f552c18e56dfebd0b3f3ae4bc0ed52b7fd9d。实际安装root C:/Users/ADMINI~1/AppData/Local/Temp/viva-performance-install-Om9Ood，142个payload哈希全匹配。实际安装六阶段全部通过。

重要失败：smoke后卸载前快照发现开始菜单Programs/Viva.lnk从0D170A7F...变为ADA5A720...，目标为本次QA210 exe，修改时间10:21:12.561 UTC，在resume启动附近。两个桥接快捷方式哈希及既有Viva注册项未变。卸载尚未执行，避免留下失效链接。既有注册项实际只有QA140/QA164，不应称为已验证的正式生产安装；此前“注册项未变”仅指这些既有记录。
基线仅存hash没有原目标/原字节，无法据此可靠恢复。已异步询问用户正式Viva.exe启动路径；当前链接已备份到shortcut-backup-after-detection（明确是检测后字节，不冒充原件）。QA210目前仍安装，等待恢复入口后清理。请勿宣称清理完成。不要擅自删除旧QA140/164。

源码风险路径：main.ts固定Windows app ID app.viva.desktop，showNotice在smoke中也会调用系统通知。新增smoke guard，使自动化smoke不触发真实系统通知注册；正式运行通知行为不变。性能desktop-harness.ts也隔离Notification.isSupported，旧mjs备份为desktop-harness-before-qa211.mjs。此隔离区别必须保留，后续原生通知功能需专门独立身份验收，不能拿这些测试冒充。
QA211类型检查、构建及Windows完整776/776测试通过；新候选source清单qa211-candidate-manifest.json。QA212开发构建memory/resume两阶段通过，前后Viva.lnk原始hash相同；只证明这两阶段未再次改写，尚不等于新安装包完整隔离验收。
current-evaluation的smoke/installed仍false，QA210为新增隔离保护之前的产物，不算当前安装证据。整体性能FAIL仍在，快捷方式恢复亦未完成。
证据：qa209-package-audit.json；package-validation-qa210/manifest.json、install-temp-source.json、installed-temp-source-six-phase.json、install-isolation-check.json、current-production-shortcut.json、notification-registration-after-detection.json；qa211-*-log；qa212-smoke/result.json、shortcut-check.json。

## QA213：溢出滚动容器对照（2026-10-30）
四个全新renderer，ABBA顺序，原Electron44.7.0、完整AX；B仅对目标回答的.md-code/.md-table-wrap设置overflow:visible，未修改产品CSS。
基线AX昂贵区间163.720/179.009ms，对照170.144/179.762ms，没有支持取消overflow可解决本负载的证据。基线双rAF90.791/96.005ms，但昂贵AX结束边界420.178/302.990ms；对照结束261.301/273.693ms。调度延后差异不能当实际加速，不能用双rAF替代完整观察。
四轮全文选择hash均为9966d570777e5f79e2e6d6bd9174b88fc4789c80474a2c3fc8f2d148778cbd59，各507标题/表格/代码，锚点漂移0，页面宽1360等于viewport。此夹具没有真正横向溢出的代码/表格，因此不能证明overflow:visible对宽内容保真；未采用该诊断样式。
四轮cleanup均cleaned=true、remaining=[]、API不可达。合成点击，不是原生滚轮或屏幕实际呈现验收。无新增产品改动，整体FAIL保持；QA213不解除当前包回归和快捷方式恢复未完成状态。
证据：E:/viva/qa-20261029-performance/desktop/qa213-cold-expansion.json、qa213-measured-boundaries.json及四轮trace/cleanup。下一步优先重新对准过程首次展开的节点/AX负载，不继续假设overflow或运行时版本即可解决。

## QA214–215：首次过程列表挂载诊断与否证（2026-10-30）
QA214在同renderer进行500条过程ABBA对照，诊断临时拦截trace列表insertBefore，直到toggle.click返回后才插入DocumentFragment。同步耗时基线33.2/29.4ms，对照7.7/8.6ms；AX仍55–65ms。节点、草稿和条数断言通过，正常清理。
随后产品候选改为先离线组装ol再挂载，QA215完整20/200/500 DOM回归通过，但500条展开仍31ms，追加2.4ms。此结果否证了“批量插入带来此前约4倍收益”的解释：QA214把插入延后到renderTasksPage的scrollHeight读取之后，改变了布局/定位时序；旧断言未验证展开后底部定位，因此不能把QA214视为保真优化。该产品尝试已撤回，未提交。
当前重要线索：renderTasksPage过程分支updateSteps后读取scroller.scrollHeight并写scrollTop，强制完成新增列表布局；诊断延后插入绕过了该成本。下一步需比较相同最终滚动位置、帧/AX和用户滚动竞态的布局调度方案，不能只缩短handler计时。
QA215类型检查/构建通过；完整测试日志qa215-full-tests-native.log属于已撤回候选，不能刷新当前源码验收。QA214/215 cleanup均成功。整体FAIL，既有封存stash和发布状态不变。

## QA216–217：滚动几何成本直接测量（2026-10-30）
在scroller实例包装原生scrollHeight/scrollTop/clientHeight getter/setter，原调用立即执行，不延后DOM变更；四轮500条过程，完整节点/草稿/焦点回归仍通过。QA216启动使用QA215已撤回候选的旧out；明确不冒充当前源码。随后重新build并执行QA217确认当前源码。
QA217四轮展开后scrollHeight读取26.8/22.6/25.1/25.7ms，展开前几何访问和scrollTop写入未出现同级成本；QA216对照23.7–29.3ms。展开后高度76365、scrollTop约75663.43、clientHeight701，定位到底部（取整偏差约0.57px）。证明新增列表后的强制布局是handler主要开销，不证明其为唯一卡顿根因，也不证明把读取移到下一帧能减少总工作。昂贵AX仍需独立解决。
QA217正常清理，进程/API无残留。未增加产品改动；已将out重新构建到当前撤回后源码。下一步对布局调度/容器结构做保真对照，必须把底部定位、阅读位置、原生输入竞态及完整AX纳入，不只看handler。
证据：desktop/qa216-steps-dom.json、qa216-contained-boundaries.json；desktop/qa217-steps-dom.json、qa217-contained-boundaries.json、qa217-geometry-summary.json。整体FAIL，当前安装回归及快捷方式恢复继续未完成。

## QA221–222：新工作区复核仍为沙箱准备失败（2026-10-30）
源码确认：main.ts的workDirFor/新话题沿用当前话题cwd，因此仅设置AGENT_CWD不会改写复制历史的当前目录。QA221过早调用switchWorkDir，返回unavailable；未进入工具测试，cleanup成功。QA222改为新话题ready后切换，getWorkDir确认current/defaultDir均为本轮profile-qa222-task-steps/workspace。
权限匹配修正为按taskId/toolCallId关联tool_call.rawInput，只接受command/description键和严格纯小整数乘法，allow_once最多12次；本轮成功批准1次。首个工具call_00_zU7X37UxVSgPS6ejxhYx7620返回failed：SetNamedSecurityInfoW failed (Win32 5): grantWrite(E:\viva\qa-20261029-performance\desktop\profile-qa222-task-steps\workspace)。新目录仍失败，否证“仅旧配置路径导致”的解释。没有修改ACL或扩大工具权限，失败立即stopTask。
QA222仅3条过程，展开handler3.6ms、节点/草稿/焦点保持，但12个计算未成功，不能宣告真实多工具或大量过程性能通过。runner exit0不是业务成功。cleanup=true、remaining=[]、API不可达。原始结果及错误在desktop/qa222-task-steps.json和trace，QA221失败保留。
下一步：真实命令工具验收暂被沙箱准备阶段阻塞，可继续独立UI/性能和安装证据工作。不得通过自动重试或放开权限掩盖此错误。整体FAIL保持。

## QA224–225：当前打包程序启动失败（2026-10-30）
QA224六阶段计划在setup第一阶段即退出，code2147483651（0x80000003），约72ms，应用测试未开始，setup.log为空。QA225仅添加--enable-logging和指定log-file复核，约22ms同码退出，未产生日志；没有关闭沙箱。不能将QA223文件核验当可运行证明，也不能称此包可发布。
只读PE检查：ELECTRONASAR内resources\\app.asar的SHA256与最终header hash均a9a98cfa570deb5f72b2758b92daa932e377b08256de2ee47146dee7826fa2f5，排除该记录与归档头不一致。exe SHA256 f441d97d4a0e69e3bf09fabcf044f639cf6231ccea8a3eae8efe1945062d1e77。未获得匹配Windows应用事件；缺日志不证明无原生崩溃。启动环境没有NODE_OPTIONS、NODE_PATH或ELECTRON_RUN_AS_NODE遗留（仅CODEX_MCP_NODE_PATH不相关名）。
快捷方式前后hash一致，备份qa224-shortcut-before；这不代表旧QA210入口恢复。未安装、未发布。当前开发构建QA219回归有效，但当前包运行FAIL/安装未完成。下一步需隔离产物位置/运行时原生启动与依赖路径，保留准确二进制哈希，禁止用关闭安全设置掩盖失败。
证据：qa224-smoke/result.json/setup.log/shortcut-check.json、qa225-smoke/result.json/setup.log、qa224-integrity.json。整体FAIL继续。

## QA226：相同产物临时目录六阶段通过，收窄启动失败范围（2026-10-30）
将QA223 win-unpacked复制到独立临时目录C:/Users/ADMINI~1/AppData/Local/Temp/viva-qa226-nXDeI3；142个文件逐一SHA256一致，未安装或修改ACL。该路径Viva.exe运行setup/walkthrough/relaunch/memory/resume/timeline六阶段全部exit0，memory/resume使用内置DSH，其他对应阶段使用明确fixture。源码仍qa211候选清单。
因此QA224/225的0x80000003不是该二进制在所有环境下必然失败，目录环境相关性得到对照支持。但同时改变了程序路径与cwd，不能单独归因于E盘、某条ACL或路径长度。只读目录/文件ACL已保存在qa226-path-acl-normalized.json；首次复杂IdentityReference序列化有截断，旧报告保留，不用它替代规范化结果。
后验快捷方式hash与qa224基线相同，精确临时目录下程序及六阶段根PID无残留。复制目录仍保留供复核，不称已删除。六阶段只证明当前打包产物从此临时目录可运行，不是实际安装、正式通知、真实模型或性能通过。旧快捷方式恢复仍未完成，installedCurrent仍false，整体FAIL。
证据：qa226-copy.json、qa226-smoke/result.json/各phase日志/post-check.json、qa226-path-acl-normalized.json。下一步可在此已验证产物上推进隔离安装验证；还需分别验证原目录程序与cwd因素及性能门槛。

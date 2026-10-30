# Viva 性能诊断摘要：供静态分析交接

日期：2026-10-30。证据更新至 QA125 及 QA126 源码追踪。请优先阅读第八节最新交接补充；前七节保留截至 QA102 的定位过程，其验证待办以第八节更新为准。旧交接报告保留实验历史，阶段性表述不能当作当前结论。

## 一、需要解释的现象

原始用户反馈：后台真实模型任务输出时，在已展开、包含较多代码和表格的长回答中，鼠标滚轮快速连滚感觉卡顿。

现有证据将问题分为三条，不能混为一个已证明根因：

| 问题 | 当前证据 | 状态 |
| --- | --- | --- |
| 后台任务输出期间快速连滚 | Electron 注入滚轮未复现明显卡顿；未完成可靠的 OS 原生快速连滚验收 | 原始问题未关闭 |
| 大文档下回顾/搜索页开关 | 完整 AX 下稳定约 240–270ms 渲染线程长任务；候选实现明显改善 | 有可重复定位与未提交修复 |
| 原生窗口还原/最大化、输入反馈 | 曾观察到约 950–975ms 帧间隔及部分端到端输入超预算 | 尚未完成 OS/工具/应用归因 |

## 二、代码与复现环境

- 工作树：`E:\viva\release-qa-20261028`，分支 `codex/performance-20261029`。
- 当前 HEAD：`f043e2dfffb126116a983a9e376bb5f2860ea279`；产品基线 `7a2f244ca575cfff808b8c9f1937e9727a1ec4ce`。
- **候选修复尚未提交，分析 HEAD 不会包含修复，必须同时查看工作区 diff 与新增文件。**
- Electron 44.7.0 / Chromium 152.0.7977.130 / V8 15.2.124.28-electron.0；Windows 系统 DPI 175%、屏幕 120Hz。
- 压力内容：200KB、507 节文档，加上 60 表格和 60 代码块的展开回答，约 1.76 万 DOM 元素。
- 完整 AX 包括 nativeAPIs、webContents、inlineTextBoxes、extendedProperties。QA85 同进程正常启动 AX=false 时导航 max10.3ms，开启完整 AX 后出现六个 248–260ms 长任务。不能泛化为所有用户正常启动都必然出现。

## 三、诊断证据链（优先阅读）

1. **业务导航逻辑不是必要条件。**只切换 `hub.dataset.open`、不执行搜索及业务 render，也出现约 242–258ms 停顿。常规滚动本身在这些对照中没有同等级长任务。
2. **主要耗时落在 AX 序列化阶段。**QA68 trace 中 `SerializeLifecycleStage` 约 248/242ms；QA87 对应线程 CPU 时间约 247.5/241.4ms，支持 CPU 工作占主导。嵌套 `SendPendingAccessibilityEvents` 约 59/57ms，位置收集约 0.012ms。不能把嵌套或跨进程时间相加，不能把剩余时间直接归给某个函数。
3. **独立最小复现成立。**不加载 Viva 业务代码时，文本控件显示/隐藏成本随文档规模增加：约 1.2 万元素时 122–140ms，2.4 万元素时 249–263ms；按钮对照没有对应长任务。Shadow DOM 不改善，iframe 输入框明显改善。
4. **真实应用早期 iframe 反例已经进一步解释。**只迁走 input 仍卡。QA92–95 发现移除 input 后仍卡，搜索 label 单独存在仍卡，空页面或仅结果列表则快。
5. **空 label 足够触发。**QA96 空 label max251.6ms；去掉 input 的同样式 div max10.3ms、无长任务。隐藏文字、SVG、输入框均不是这一 label 路径的必要条件。
6. **组合原型反复可逆。**同时把外 label 换 div、把原 input 迁入独立子文档：QA98 基线/原型/恢复 max270.4/13.0/268.0ms，长任务数6/0/6。仅在真实应用中把 input 移到 iframe 而保留原 label，不足以改善。
7. **子文档边界确实存在。**QA90 按 frame 获取 AX 快照，父树44,872节点、子树9节点且包含命名 searchbox。快照节点数不是一次更新发送量，也不能证明独立进程。

**目前可以说：文本控件及 label 语义相关的 AX 路径是搜索切换停顿的强定位线索。尚不能说：已证明整棵 AX 树重建、已锁定 Chromium 某个具体 C++ 函数，或已解释原始后台快滚问题。**

## 四、当前候选修复与验证边界

实现：搜索容器 label→div，为 input 保留明确 aria-label；同源 iframe 使用 `sandbox="allow-same-origin"`，子文档禁止脚本，加载后迁入原 input，保留对象及监听器；在子文档注册相同键盘/关闭/拖放处理函数。加载错误、错误文档或5秒超时回退原输入框；迁移保留焦点及选区。子文档没有 `window.agent`。

发现并修复的回归：`:focus-within` 不跨 iframe，导致搜索栏蓝色焦点边框消失。现在用 input focus/blur 同步容器 class，QA102 原生复测边框恢复、Tab 离开后正确取消；150% 应用缩放所查看状态未见搜索框遮挡。

验证：

- QA99 完整 AX/完整压力正文下20轮合成导航：max帧间隔12.6ms、0长任务；事件至两帧max17.2ms。搜索、全选、快捷键和正文保真检查通过。不是物理输入端到端指标。
- QA100 771项完整测试通过，新增3项另行通过，六阶段 smoke 通过。**该完整回归早于焦点边框修复**；后者有3项专项测试、typecheck、重新构建及 QA102 原生复测，尚未重跑完整 smoke。
- QA101 原生 Tab/Shift+Tab 能进出子输入框，Escape 能关闭；Unicode 注入可搜索，不等于真实拼音 IME。
- UIA `focused_element` 仍报告父 RootWebArea，与实际 DOM 焦点及可输入状态不一致，尚未解释，不能宣称读屏验收通过。
- 真实 IME、读屏行为、子文档拖放、完整回退及安装产物复测仍未全部完成。

## 五、请静态分析人员优先检查

### Chromium 路径

精确版本源码已在证据目录保存：`chromium-152-ax-object-cache-impl.cc`、`chromium-152-blink_ax_tree_source.cc`、`chromium-152-ax_object.cc`、`chromium-152-ax_node_object.cc`。

重点回答：

1. label（包括空 label）显示/隐藏时，哪些名称关联、脏节点传播或序列化依赖可能扩大到大文档？请给出实际源码调用链，而不是仅凭现象断言全树重建。
2. 文本控件是否还有另一条独立触发路径？为什么移走 input 不够，而同时移除父文档 label 语义、建立子文档边界后改善？
3. 哪些机制与文档规模相关，哪些需要新增 CPU 栈或实际 AX 更新节点数才能证明？

### Viva 路径及候选风险

- `src/renderer/index.html`、`styles.css`：hub显示、label语义、隐藏规则、焦点和缩放。
- `src/renderer/view/hub.ts`、`history-actions.ts`：可见性切换、focus/select。
- `src/renderer/history-search-frame.ts`、`.html`、`.css`（新增）：加载竞态、超时与晚到 load、错误文档、节点迁移、选区、资源加载、沙箱和可访问性。
- `src/renderer/app.ts`：`wireDismissal`、`wireFolderDrop` 跨文档注册，IME/快捷键/事件传播及监听器生命周期。
- `src/renderer/view/render.ts`、`view/reconcile.ts`：后台输出是否触发主对话无关 render、布局读取或 AX 更新；请将这条原始快滚假设与已经复现的搜索切换路径分开分析。
- `src/main/smoke.ts`、`smoke-timeline.ts`、`smoke-perf.ts`、`live-scenarios-app.ts`：本次仅适配查找子文档内真实 input，审查是否存在漏检。
- `test/history-search-frame.test.ts`：覆盖与真实浏览器语义之间的差距。

每个根因假设请附：证据强弱、精确源码路径、反证、一个最小可证伪动态实验。特别审查 iframe 是否以新的焦点/读屏/IME问题换取性能改善。

## 六、原始快滚与测量限制

QA84 空闲/真实后台输出各320次 Electron wheel，实际间隔约15.3–15.5ms，帧p95均8.4ms、max8.5/16.7ms，0长任务；后台组任务更新171→1006、输出字符707→3718、未结束，确认真实输出与滚动重叠。正文60表格/60代码块保持完整。

这些 `webContents.sendInputEvent` 即使 isTrusted=true，也不等于物理鼠标输入。尚不能因此否定用户感知。

原生截图会额外访问 UIA；曾观察到截图后的65,850个开始/结束元数据事件，不能称为65,850次独立请求。部分采样已避免工具绑定，但原生滚轮、窗口缩放仍需区分工具、系统与应用开销。WPR 原件已保存，完整CPU/GPU栈归因尚未完成。

## 七、交接文件与不可改变的约束

证据根目录：`E:\viva\qa-20261029-performance`。

- 总记录：`CHECKPOINTS.md`、`CONTRACT.md`、`WEAKNESSES.md`、`current-evaluation.json`（仍未通过）。
- 主要证据：`desktop/qa68-reading-detailed-summary.json`、`qa84-checkpoint.json`、`qa85-checkpoint.json`、`qa87-serialization-subevents.json`、`qa90-frame-boundaries.json`、`qa96-label-semantics.json`、`qa98-prototype-audit.json`、`qa99-candidate-navigation.json`、`qa102-focused-response.json`、`qa102-blurred-response.json`。
- 旧详细报告：`docs/qa-performance-static-handoff-20261030.md`，按实验时间理解，优先以本摘要更新结论。
- **旧 ZIP `handoff/static-analysis-20261030.zip` 只到 QA85，不含最新突破及候选代码，请勿作为当前完整快照。**
- 封存渲染 stash `12d75c9` 不应用、不测试、不合并。
- 保留完整复制、搜索、选择及读屏功能；不关闭 AX，不截断正文；DOM 数仅诊断指标。
- 本稿供静态分析，未执行新的动态测试；当前尚不能宣布完整发布验收通过。

## 八、最新交接补充（2026-10-30，QA103–126；优先于前文阶段状态）

### 当前结论

必须把四条问题独立分析：原始后台快滚未关闭；搜索切换已有有效候选修复；全文冷展开仍超预算；新发现发行程序启动位置相关失败。最后一项发生在应用 JS 启动前，不能归因于搜索 iframe。整体验收仍 FAIL，候选未提交、未合并、未发布。

### A. 搜索候选最新状态

- QA108：最新当时构建、完整 AX、17,656 DOM，20轮开关、40状态检查零异常；max帧间隔14.5ms、零长任务，合成事件到两帧max18.3ms。搜索2命中、全选、组合状态Escape保护、普通Escape关闭和完整正文均通过。
- QA103：原生拼音输入确实出现候选，compositionstart/update与组合input为trusted；Escape取消候选并保留搜索，r+空格提交“人”并得到11结果，再按Escape关闭。compositionend出现trusted=false，保留限制，不能称完整IME认证。
- QA106：修复失败回退时无条件重插input导致失焦；仅input不在原host时才插回。boot改为异步启动迁移，不阻塞renderTick/getInfo。
- QA114：字体链接初始不设置href，input迁移及焦点恢复后才启用远程字体。实际字体失败延迟3/2512/6506ms时，frame分别16.6/7.2/8.6ms加载成功，焦点、内容和选区均保留；慢字体不再阻塞frame或触发5秒回退。尚未验证字体成功到达后的视觉变化。
- QA107完整775项测试、typecheck/build、六阶段smoke通过，早于QA114。QA114四项专项测试、typecheck/build通过；QA118包含最终字体改动的发行目录副本六阶段smoke全部通过。不是安装/升级验收。
- UIA仍曾报告父RootWebArea获得焦点，与DOM实际input焦点不一致；读屏、拖放、完整输入法与缩放矩阵仍需验证。

### B. 全文冷展开：可重复的独立性能缺陷

QA110五个独立新renderer，完整AX，通过实际answer-more处理函数合成点击，未绑定截图工具：

| 指标 | 五次样本（ms） |
| --- | --- |
| 预览 | 76.3 / 75.7 / 78.4 / 78.3 / 79.4 |
| 全文展开至两帧 | 274.8 / 253.3 / 251.4 / 254.0 / 251.1 |
| 同步处理函数 | 24.5 / 22.6 / 23.3 / 23.4 / 23.3 |
| 长任务 | 250 / 230 / 228 / 230 / 227 |

全文五次均有507标题、507表格、507代码块，选择文本SHA256一致：9966d570777e5f79e2e6d6bd9174b88fc4789c80474a2c3fc8f2d148778cbd59。预览通过150ms预算，全文五次均失败。两帧指标不是实际呈现或物理输入延迟。

QA111限定单次展开标记区间的trace：总259.452ms；EventDispatch22.502ms，后续BeginMainFrame236.654ms。其中样式布局45.216ms（Layout30.538ms嵌套），AX169.474ms；AX内deferred updates36.505ms、serialization132.662ms，后者内send29.678ms、位置收集4.874ms。这些时间有嵌套，不能求和。部分tdur大于dur，不据此计算精确CPU占比。

可以定位到布局与AX阶段，不能宣称“全树重建”。QA113检查发送/接收trace参数为空，没有节点数。精确版本源码遍历pending_objects_to_serialize_、调用SerializeChanges、去重节点ID；这不说明实际更新范围。系统有UIA事件但客户端身份未知；未绑定截图工具不等于没有AX客户端。

反证：QA112把composer的label临时改span并保留aria-label，三次全文248.6–256.5ms，无明显改善。不要机械推广搜索label修复。历史content-visibility/分组方案只暴露10/507节给AX，已拒绝，不能以功能损失换指标。

优先静态检查：src/renderer/view/thread.ts的answer-more路径，view/render.ts、view/reconcile.ts的更新范围，以及Chromium AXObjectCacheImpl更新/序列化依赖。需要回答新增正文必要成本与无关旧正文失效成本如何区分，并提出可测量的节点范围实验。

### C. 发行程序启动失败：另一条阻塞，根因尚未闭环

- QA115生成win-unpacked；六个renderer资源与构建产物哈希一致，PE内ASAR integrity与最终ASAR头一致。
- 原E盘包QA116/117约21–71ms退出0x80000003，应用日志为空。QA120另一个E盘目录仍失败。
- QA118将完整142个文件复制到C盘TEMP并逐文件校验相同，全部六阶段smoke通过；cwd/输出仍在E盘。说明存在运行位置相关现象，不证明E盘本身有问题。
- C/E均NTFS、4096分配单元、Healthy；失败EXE无Zone.Identifier。ACL存在差异，但未证明因果，不要修改ACL或安全策略来掩盖原因。
- QA121–125原生调试捕获稳定故障RVA=0x33A29CE，指令int3/ud2；目标restricted_token=0。故障前虚调用返回非零，QA125故障寄存器RAX=12。
- 精确Chromium152.0.7977.130源码sandbox/policy/sandbox.cc：Sandbox::Initialize → InitBrokerServices → CreateAlternateDesktop(Desktop::kAlternateWinstation) → CHECK(result == SBOX_ALL_OK)。sandbox_types.h定义12为SBOX_ERROR_CANNOT_CREATE_WINSTATION。与二进制分支、参数2和返回12吻合。
- 因此可确认失败步骤是备用窗口站创建；底层Windows失败码、为什么与启动路径相关仍未知。上游提及第三方软件/desktop heap只是一般可能性，不是本机结论。不得以--no-sandbox作为修复。
- QA126 broker_services.cc进一步指向AlternateDesktop::Initialize(true)。请沿此路径核对实际Windows调用、命名、权限、资源与错误传播。当前无有效符号化调用栈，QA122/123重复PC不能当作调用栈。

产物身份：EXE SHA256=d509c1983ceaa11d9bea993716a2152d092b592bf10fb382eca7589fe8232190；ASAR SHA256=d9deea0f527b9d5d54f88e2a7f45f6761f96d837da460b284ba5fa9f421fd6d1；PDB GUID=51ADB449-8389-3086-4C4C-44205044422E，age1，electron.exe.pdb。

### D. 原始快滚与窗口问题仍需独立解释

QA84注入wheel对照没有复现明显卡顿，但不等于物理快速连滚验收。优先分析真实后台输出→状态更新→主对话reconcile→样式布局/AX→合成呈现链条，指出后台更新是否不必要地触碰已展开正文。原生窗口还原/最大化的历史大帧间隔也仍缺完整WPR CPU/GPU归因，不能只凭独显在工作排除或确认GPU问题。

### 最新证据索引

以下路径均相对于E:\viva\qa-20261029-performance：

- 搜索：desktop/qa108-candidate-navigation.json；字体：desktop/qa114-frame-load.json。
- 冷展开：desktop/qa110-cold-expansion.json、qa111-cold-expand.trace.json、qa111-expand-window.json、qa113-ax-payload-audit.json。
- Chromium AX源码：desktop/chromium-152-ax-object-cache-impl.cc、chromium-152-blink_ax_tree_source.cc、chromium-152-ax_object.cc、chromium-152-ax_node_object.cc。
- 发行回归：qa118-packaged-smoke/result.json、completion.json及各阶段日志；路径对照desktop/qa118-copy.json、qa120-copy.json。
- 启动：qa125-startup/debug.log；native/qa124-disasm-corrected.txt、qa124-referenced-strings.json、qa125-sandbox.cc、qa125-sandbox-types.h、qa126-broker-services.cc。
- **无效证据警示：native/qa126-desktop.cc不是desktop实现。原下载404后PowerShell复用了旧变量，将broker_services.cc误写到此名下。该文件保留用于审计，不得引用为AlternateDesktop实现。**

### 给静态分析人员的任务要求

请基于当前工作区源码（含未跟踪新增文件）分别分析A/B/C/D，不把四条现象拼成单一根因。每项输出：源码调用链与位置、已证实事实/假设、支持及反证、最小可证伪实验、保留完整功能的修复建议及风险。重点审查iframe的焦点、IME、读屏、失败/晚到load、监听器生命周期以及smoke是否漏检。只分析不修改代码，先返回结论供后续动态验证。

封存stash 12d75c9继续不应用、不测试、不合并。不能关闭AX、截断正文或降低完整复制/搜索/选择/读屏能力。旧ZIP仅到QA85，不能当作当前代码快照。本次交接整理未运行新的性能测试。


### QA127源码追踪追加

官方目录确认并下载native/qa127-alternate_desktop.cc及qa127-window.cc。CreateAltWindowStation第18–49行：获取当前窗口站DACL后调用CreateWindowStationW，名称nullptr（OS生成），权限GENERIC_READ|WINSTA_CREATEDESKTOP；仅ERROR_ACCESS_DENIED时以WINSTA_READATTRIBUTES|WINSTA_CREATEDESKTOP重试，最终空句柄返回12。尚无实际Windows错误码，不能断言是访问拒绝；也不能推断EXE路径进入窗口站名称。需捕获真实调用返回点的错误，避免拿后续CHECK处可能陈旧的LastError作根因。

### QA129运行证据追加：实际错误为访问被拒绝

原生硬件断点捕获CreateWindowStationW两次调用返回点：首次access=0x80000008、重试access=0xA，均handle=0、Windows LastError=5（ERROR_ACCESS_DENIED）；两次名称均nullptr。通过NtQueryInformationThread读取目标线程TEB，status0、LastError字段4字节读取成功。随后仍退出0x80000003。证据qa129-startup/debug.log、native/startup-api-qa129.cpp。

这确认访问拒绝，但尚未确认拒绝来自哪一项访问控制/防护机制，不能直接归因文件ACL。QA128初版因user32晚加载未设成断点，calls=0，不是API成功对照。未修改系统安全策略或关闭沙箱。

### QA130–132重要限定：诊断条件影响成功路径

最新同哈希对照：C副本经E盘原生调试器也出现两次错误5并崩溃；C副本直接Start-Process运行隔离setup则exit0/checks passed；E副本相同直接启动仍0x80000003。证据qa130-startup/debug.log、qa131-direct/result.json、qa132-direct/result.json。无调试的路径差异仍成立，但调试器/父进程位置与继承环境存在混杂。错误5是调试条件下确证，不能据此无保留断言无调试E失败已经定位到同一访问拒绝根因。请将启动方式纳入静态分析及下一轮最小实验。

### QA133–135：父进程位置对照进一步收敛

E盘原生启动器取消debug标志后，启动C副本仍80000003。将该启动器逐字节复制到C TEMP，目标EXE和cwd保持不变，则exit0。再把原硬件断点调试器逐字节复制到C TEMP，窗口站首次创建返回非零句柄、目标exit0，无降权重试。证据qa133-startup/debug.log、qa134-startup/copy.json/debug.log、qa135-startup/debug.log。

这表明调试标志本身不足以解释；父进程位置或随位置变化的进程安全环境是重要变量。还不能确定具体ACL、token/job限制或安全产品，需要进一步只读核对。不可通过关闭沙箱规避。

### QA136：启动环境差异已定位到完整性级别

同哈希只读探针：E新生成EXE的进程完整性为Low(S-1-16-4096)，C TEMP副本为Medium(S-1-16-8192)。其余所查token、Job限制、窗口站DACL、win32k mitigation相同。icacls证实E:/viva有可继承Low mandatory label，新E发行EXE及探针继承该标签；旧开发electron.exe和C TEMP探针没有。证据qa136-context/e-context.log、c-context.log、file-labels.log。

结合QA129–135，工作区Low标签及执行后Low完整性为路径/父进程位置相关窗口站拒绝提供强解释，不能归咎于搜索JS或仅凭额外ALLOW SID判断。未修改安全设置，标签来源/设置时间未知。可使用同哈希正常临时副本继续验收，但安装/升级及性能合同仍未完成。

### QA138回归补充

远程字体成功加载已补真实模块+生产搜索样式夹具：frame挂载6.8ms，远程CSS/fonts.ready后DOM焦点、输入、选区保持，输入宽不变，高22→19.714px仍完整位于26pxframe内，无横向溢出；已查看截图未见文字裁切。原件desktop/qa138-frame-load.json、qa138-font-loaded.png。仅该尺寸局部夹具通过，不替代全应用缩放/读屏验收。

### QA139原生滚轮覆盖限制

实际sky.scroll大delta1200只产生1个trusted wheel（应用delta约1000），不是连续事件序列。60表格/60代码完整回答上该单次动作后250ms帧间隔8.2–8.4ms、无长任务、正文保持；无后台模型并行。不能将其计为用户“鼠标快速连滚”场景通过。原件desktop/qa139-result-response.json，实例已正常退出清理。

### QA140安装产物进展

最新候选已通过独立QA身份的实际NSIS安装，142载荷文件与候选包全部一致，当前297个out文件与ASAR逐字节一致。现有Viva快捷方式hash/注册枚举前后相同。安装后六阶段回归正在运行，setup/walkthrough/relaunch已exit0，memory及后续阶段尚未取得终态；不能记为全部通过。证据package-validation-qa140/。此隔离注册身份不覆盖生产快捷方式或真实升级行为。

### QA140/141最终回归终态

实际安装后的六阶段全部exit0，路径限定进程检查remaining[]；最新候选775项完整测试与严格类型检查均通过。原件package-validation-qa140/installed-temp-source-six-phase.json、smoke-completion.json、qa141-full-tests.log、qa141-typecheck.log。current-evaluation.json已更新候选身份与证据（旧报告保存evaluation-before-qa141.json），实际评估仍FAIL，不能把回归通过替代性能通过。

### QA143–144原生窗口与系统采样补充

最新候选60表格/60代码长回答、100%应用缩放：原生最大化/还原的renderer最大帧间隔16.6ms、无长任务；三次resize与Chromium标记匹配，WPR头时间覆盖两动作、lost0。browser主线程仍有186–199ms工作。

对还原后199.351ms工作加40ms护栏的WPR解析保留211个CPU样本：Electron95、UIAutomationCore25、COM14等、未映射23；762栈记录中存在UIA/COM/RPC。支持无障碍交互参与但没有外部客户端/函数级根因，2条image decode错误保留，不可全归因UIA。证据desktop/qa143-rich100-actions-analysis.json、qa143-coverage-and-dispatch.json、qa144-restore-profile-analysis.json。这里只覆盖空闲长回答100%一组，不是完整窗口矩阵。

### QA145函数级系统符号证据

用本机UIAutomationCore精确GUID/age匹配的微软官方PDB，DbgHelp确认SymPdb且无mismatch。25个UIA CPU样本包括属性读取、节点构建与缓存响应序列化；205条含UIA的保留栈中157条出现Incoming_BulkFetch / CrossProcess_BulkFetch / BulkFetch::Traverse。支持跨进程批量UIA查询参与browser长工作，但请求客户端未知，不能推断全部耗时归属或拿它替代renderer冷展开归因。原件symbols-qa145/resolved.log、stack-resolved.log、manifest.json；栈计数字段samples表示栈出现数，不是CPU百分比。

## QA146：150%富文本原生最大化/还原新增失败证据（2026-10-30）
复用并核实隔离PID21444，60表格/60代码、35047字符、DOM6977；应用缩放1.5。原生最大化1793342804427–4506、还原1793342816008–6081（UTC epoch ms）。renderer viewport906x574→1463x791→906x574。native-auto session9287 exit0，analyze-native valid=true；3452帧，max108.3ms，三个longtask55/106/68ms。相较QA143 100%最大16.6ms/零长任务，本组新增明确停顿，但只有一次动作对，不能据此断言缩放是唯一原因。
Chromium trace24781239bytes、buffer9.2%；全录制汇总UpdateLayoutTree max23.735ms、Layout max22.042ms，尚未完成长任务内部及系统栈归因，不将全区间累计值当作单次停顿成本。工具截图可能引入UIA查询，最大化截图也显示外部ToDesk面板，记录为环境混杂，不操作外部程序。
WPR VivaQAPerformance-47bbe6c19a3e start/stop均0、ownRecordingStopped=true，ETL1159725056bytes，SHA256622227AD3EB396DE1B5D822BFCC790DB5262D27C3A3703E39F0A22605875EF92。ETL头覆盖/lost尚未另行解析。原件位于C:/Users/Administrator/AppData/Local/Temp/viva-wpr-performance-47bbe6c19a3e/windows-native-performance.etl。
证据desktop/qa146-native-actions.json、qa146-rich150-{begin,end,actions-analysis,wpr-receipt}.json、qa146-rich150.trace.json、qa146-rich150-summary.log。正常退出回执qa146-native150-cleanup.json：remaining[]、API不可达、无录制进程、cleanedtrue。
本次不改产品代码。150%原生窗口性能未通过，原始真实后台快速连滚仍未关闭，完整目标保持active。

## QA147：150%长任务定位到列宽回调，候选消除写后读（2026-10-30）
只读解析QA146的三个renderer RunTask。55.009ms任务内column-resize.js apply占39.108ms，含UpdateLayoutTree17.141ms及Layout21.776ms；68.350ms任务内apply49.297ms，含UpdateLayoutTree23.735ms及Layout22.042ms。trace明确给出函数URL，布局dirtyObjects23/totalObjects12600、partialLayoutfalse。另106.170ms任务仅见0.011ms采样回调，lean trace不足以解释，不归因列宽或AX。
源码apply先读area.clientWidth，写root --col/aria-valuenow后再次读area.clientWidth供onWidth，形成写后布局读。本次仅改为一次读取available，供clamp及onWidth共享，保持宽度计算和回调语义；尚未进行改后原生性能对照，不能声称卡顿已修复，也不保证减少总布局成本。
相关task-dock测试15/15，完整npm run typecheck、build成功；新增analyze-qa147-longtasks.ts通过QA strict类型检查。证据desktop/qa147-longtasks.json、qa147-task-dock-tests.log、qa147-typecheck.log、qa147-build.log。QA146 ETL header解析成功eventsLost0/buffersLost0，尚未做本轮CPU栈解析。
注意：当前产品候选已新增column-resize.ts改动，QA140安装包/QA141完整回归属于改前搜索候选，不能当作最新代码完整回归。旧性能评价仍FAIL，候选身份/打包回归需在改后实测有效后更新。下步150%同场景原生对照，保留106ms未解释路径；封存stash不动，无提交/发布。

## QA148：列宽写后读修复原生对照（2026-10-30）
最新build、独立PID21188、复制已关闭QA146合成profile，同60表格/60代码35047字符DOM6977、150%缩放。原生最大化1793343136611–6684，还原1793343156241–6317。renderer906x574→1463x791→906x574，trace标记/resize映射validtrue；4563帧max100ms，仍有102/104ms长任务。整体窗口性能未通过。
apply回调：QA146最大化39.108ms/还原49.297ms；QA148最大化0.067ms/还原0.074ms（中间重复resize0.043ms）。支持消除该函数中的同步布局等待，不能等同总布局成本消失；此前55/68ms长任务本组未出现，但约100ms另一条停顿仍在。每组仅一次动作对且截图时序不同，不是重复随机对照分布，不将全部差异归因修改。
正文textUnchangedtrue、35047字符/60表格/60代码；还原列宽755px、area907，两grip aria-valuenow均755，满足area-152约束。首张最大化截图系统动画叠影，重新观察稳定后再还原。原生动作与截图仍可能引入UIA。
WPR VivaQAPerformance-e7ac4d6b6ef9 start/stop0、complete，session5693 exit0；Chromium33801493bytes、buffer12.1%。证据desktop/qa148-rich150-{begin,end,summary,actions-analysis,wpr-receipt}.json及trace、qa148-native-actions.json、qa148-column-comparison.json、qa148-fidelity-response.json。比较脚本strict检查通过。实例正常退出remaining[]/API不可达/无录制进程。
保留局部优化候选，但不宣称整体修复；下一步分析剩余约100ms renderer工作内部/匹配WPR CPU栈，避免把browser BulkFetch直接套到renderer。最新完整回归/安装验证尚待更新，目标active。

## QA149：剩余104ms renderer工作WPR归因与采样边界（2026-10-30）
复用QA148已结束的ETL，只读解析renderer PID9788/TID10684还原后104.103ms RunTask，加前后20ms护栏。UTC06:52:36.536–36.680，144.1032ms。原生reader session10610 exit0，扫描946937264bytes/28.281s，110CPU样本、155栈。CPU模块Electron92、unmapped14、ntdll3、kernelbase1；本组未见UIAutomationCore样本，不等于排除浏览器端UIA请求触发renderer工作。2imageDecodeErrors保留，栈/采样无溢出及malformed，精确栈样本配对仍未证明。
trace两个长任务均src_file cc/trees/proxy_impl.cc，src_func ScheduledActionSendBeginMainFrame；此字段是任务来源，不是104ms内部函数归因。CPU时间102.917ms接近wall104.103ms，支持忙于执行而非单纯等待。lean配置只含devtools.timeline/blink.user_timing/toplevel，不能通过内部AX事件缺席排除AX。
证据desktop/qa149-renderer-profile-{state,analysis}.json、qa149-renderer-profile.jsonl；run-qa149-profile.ts、analyze-qa149-profile.ts严格检查通过。native-auto新增可选--detailed（默认lean保持），用于下一次仅目标动作的cc/blink/accessibility详细trace；尚未执行详细采样，不能计通过。无产品新改动，目标active。

## QA150：详细采样缓冲耗尽，未覆盖动作，不能用于归因（2026-10-30）
最新候选隔离PID4308，60表格/60代码35047字符/DOM6977、150%原生最大化还原。native-auto session98255 exit0但后续覆盖核对失败：trace693850240bytes、buffer0.9981、5468680事件仅3.35216秒，resizeEvents为空，而独立帧采样有3次resize。analyze-native明确Resize coverage mismatch。因此脚本exit0不等于有效性能证据；本次trace未覆盖目标动作，不用于改后通过或根因判断。
独立帧记录max91.6ms、longtasks97/53ms，仅描述本次受详细录制影响的运行。trace早期大量GetPropertyValue/get_ProviderOptions/GetPatternProvider等事件；这些计数混合trace相位，不等于独立UIA请求次数。未证明外部客户端身份。最新详细配置同时包含browser/renderer，使浏览器UIA细粒度事件淹没缓冲。
准备下一轮--detailed --renderer-only：通过Electron声明支持的included_process_ids仅请求renderer，保留AX/cc/blink类别，不关闭AX功能。此为测试工具改动、尚未实测过滤有效；下一轮仍必须检查标记和动作覆盖。node --check与QA严格类型检查通过。产品无新改动。
证据desktop/qa150-rich150-{begin,end,summary}.json及trace、qa150-native-actions.json。应用正常退出cleanup remaining[]/API不可达/无录制进程。完整目标active。

## QA151：renderer限定详细采样成功，剩余99ms定位AX序列化（2026-10-30）
最新列宽候选，隔离PID33480/renderer11252，同60表格60代码35047字符DOM6977，150%缩放，单次原生最大化。仅renderer included_process_ids成功：除metadata外所有事件PID11252；trace81188254bytes、buffer28.50%，起止标记2、两resize映射validtrue，未出现QA150覆盖缺失。2870帧max91.7ms，longtask99ms。session20185 exit0。
目标renderer TID38884 RunTask99.452ms，ProxyMain::BeginMainFrame99.448ms，Commit99.357ms；LocalFrameView::RunAccessibilitySteps99.305ms，Blink.Accessibility.UpdateTime99.303ms。AX内SerializeLifecycleStage89.717ms、ProcessDeferredUpdatesLifecycleStage9.458ms；发送RenderAccessibilityImpl::SendPendingAccessibilityEvents20.636ms、位置收集1.315ms嵌套其中，不能相加。
这次直接证明150%原生最大化后剩余约100ms renderer停顿主要处于AX更新/序列化，补齐QA148 lean与QA149 WPR仅Electron模块的缺口。不是browser UIAutomationCore符号证据的简单套用。仍无实际序列化节点数/客户端身份，不能宣称全树重建或单独归因工具。完整正文/读屏要求保持，不能禁用AX绕过。
证据desktop/qa151-rich150-{begin,end,summary,actions-analysis}.json及trace、qa151-ax-task.json、qa151-native-actions.json。分析脚本strict通过。实例正常退出remaining[]/API不可达/无录制进程。下一步对比100%与150%实际宽度变化/AX失效范围，寻找保留功能的优化；冷展开与原始后台快滚仍未关闭，目标active。

## QA152：列宽变化与AX停顿的程序化对照（2026-10-30）
独立同合成profile/完整AX/60表格60代码35047字符/150%，QA接口setBounds到2195x1187，不是原生最大化验收。default列宽755→760px，markdown705→710px；frameMax91.6ms/longtask99ms，AX更新max99.146ms、序列化89.890ms。narrow通过现有右grip ArrowLeft处理函数调为675px，放大前后列宽675/正文宽625不变；frameMax41.6ms、无longtask，AXmax18.554ms、序列化16.082ms。两组文本完全相同、起止标记齐全，缓冲1.37/1.45%。
支持正文宽度变化/重排与约100ms AX工作相关，而不仅是窗口外框变大；但各一次且初始正文宽度不同，不能证明全部差值只由5px变化造成，尚无实际dirty节点量。不得将固定窄列/削弱拖宽功能作为修复。下一步保留原列宽行为检查宽度失效传播与序列化机制。
首轮narrow在启动后info遇ECONNRESET，finally已正常清理；改QA请求connection:close避免跨实例持有旧连接，以新stem qa152-narrow-retry补跑成功。不能将初次连接错误当作产品崩溃；原stderr还有退出时bridge closed记录，保留。所有三个实例cleanup均成功。
证据desktop/qa152-width-control.json、qa152-width-control-retry.json、qa152-comparison.json及qa152-default/qa152-narrow-retry.trace.json；qa152-width-control.ts、analyze-qa152.ts strict通过。无产品新改动，完整目标active。

## QA153/154：同初始列宽的ABBA诊断确认5px变化路径（2026-10-30）
QA153四样本的fixed夹具未生效，实际均755→760，不能当固定列宽对照。新增style受页面style-src限制的解释与现象一致，但未单独保存CSP拒绝事件；不把解释当API错误确证。原数据保留。
QA154不改CSP，仅在隔离实例现有本地styles.css CSSOM插入诊断规则:root --col755px!important。ABBA顺序fixed/default/default/fixed，四个独立renderer，完整AX，初始列宽均755px/markdown705px，同35047字符60表格60代码。API setBounds同2195x1187，非物理输入验收。
fixed两次放大后仍755/705，AX更新max22.974/22.496ms，序列化20.008/19.566ms，frameMax11.966/16.6ms，无longtask。default两次变760/710，AX更新97.277/100.084ms，序列化89.147/90.658ms，frameMax83.2/100ms，longtask98/100ms。四份trace起止标记齐全，缓冲1.48–2.37%，正文textUnchanged均true。
消除了QA152初始窄列不同的主要混杂，支持本场景5px正文宽度变化触发较大AX序列化，而非仅移动/扩大窗框。仍未量化dirty节点集合，且程序化尺寸不替代原生快滚。fixed是因果诊断，不能合入为限制列宽的产品方案。所有8实例cleanup成功，无新产品代码。
证据desktop/qa153-width-control.json、qa154-width-control.json、qa154-comparison.json、四份qa154 trace及cleanup。脚本strict检查通过。后续沿文本布局/inlineTextBox失效及序列化源码找保留原布局功能的方案，完整目标active。

## QA155：非继承列宽变量原型不足以解决AX重排停顿（2026-10-30）
静态源码AXObjectCacheImpl::StyleChanged会MarkAXObjectDirty；TextChangedWithCleanLayout在StaticText且ShouldLoadInlineTextBoxes时ChildrenChangedWithCleanLayout；ClearBlockFlowCachedData可移除inlineTextBox。均为可能路径，不是本次实际调用栈/节点计数。
隔离原型CSS.registerProperty --col inheritsfalse，并拦截root.style.setProperty同步六个真实消费者thread/earlier/ctx/composer/两个grip；保留列宽755→760、正文705→710，不改CSP/AX/内容。ABBA scoped/default/default/scoped四个独立renderer，程序化同bounds，文本35047字符均不变、trace起止齐全。
scoped AXmax87.942/98.361ms、serialize81.706/90.221ms、帧max83.3/91.7ms，longtask88/99ms；default AX101.250/98.981ms、serialize91.856/91.226ms、帧100/91.6ms，longtask101/100ms。第一轮局部下降没有稳定复现，不能宣称非继承变量解决问题，不将原型加入产品。
证据desktop/qa155-width-control.json、qa155-comparison.json、四trace/cleanup；qa155-width-control.ts、analyze-qa155.ts严格类型通过。实例全部清理。剩余主要成本仍与实际文本布局变化相关，但inlineTextBox再建的因果尚待进一步证据。完整目标active，无产品新改动。

## QA156：代码块内在宽度原型未通过性能与布局等价（2026-10-30）
源码pre.md-code内包含语言span与inline code，white-space pre/横向滚动。隔离CSSOM原型code display:block;width:max-content尝试让代码内部宽度独立于列宽；ABBA code-size/default/default/code-size，完整AX、同列宽755→760、同正文35047字符。四样本结束并清理，strict通过。
code-size AXmax98.18/91.22ms、longtask114/92ms；default99.90/105.70ms、longtask100/107ms，未获得稳定实质改善。原型首代码块高度257→211px、全文34995→31874；default首代码块始终257，全文34995→34966（5px自然重排）。尽管文本不变，原型明显改变布局，不能视为等价优化，已拒绝，不改产品CSS。
证据desktop/qa156-width-control.json（原/最终几何）、qa156-comparison.json及四trace/cleanup。源码路径检查提示inline text重排/AX序列化存在必要成本，仍不能量化具体无关失效。此实验不关闭原始后台滚动及冷展开缺陷，目标active。

## QA157/158：AX身份差分及无resize对照（2026-10-30）
新增测试harness持久CDP Accessibility.enable会话的start/read/stop，保持AX IDs跨快照稳定；只用于结构诊断，不将快照成本混入原生性能验收。TypeScript源同步rendererOnly选项，旧mjs保存desktop-harness-before-qa157.mjs，当前mjs从TS擦除类型生成，语法/strict通过。
QA157完整AX/150%/60表格60代码同profile，前后窗口755→760列宽。全父文档InlineTextBox6560→6566，其中仅328保留ID、新6238/移除6232；StaticText4040→4046，3922保留、3594个保留节点childIds变化；ListMarker390全部保留但子列表均变。
QA158同流程但不改窗口，InlineTextBox6547保留、新19/移除13；StaticText4027保留且childIds变化0；少量UI状态新增/移除仍存在，不能把全部变化归窗口。该阴性对照支持QA157的大量InlineTextBox更换与宽度变化关联，而不是每次getFullAXTree普遍换ID。
这不是实际native serialization payload计数，范围全父文档而非单独富文本，CDP启用会改变观测条件；不能将6238直接当本轮发送节点量或宣称全树重建。与源码TextChangedWithCleanLayout/inlineTextBox children invalidation一致但调用因果未全证实。下一步将变化节点归属正文/其他区域，定位可能的无关失效。
证据desktop/qa157-before.json、after.json、identity-analysis.json和qa158对应文件；两个实例normal cleanup成功，产品未改，完整目标active。

## QA159：AX节点区域归属，纠正压力负载范围（2026-10-30）
离线复用QA157/158快照，无新UI操作。按最近语义祖先分类：宽度变化时table InlineTextBox2088全换、code2086全换、paragraph892/893换、list390全换、heading195全换。上述正文分类父StaticText均保留ID且文本不变，说明主要是子节点身份更新，并非正文字符串改写。无resize对照对应正文分类零替换。
进一步唯一定位heading“软件验收手册（60 节）”的父AX generic13811并遍历后代：3790节点，恰60code/60table，1747 InlineTextBox全部换。该子树之外14088节点、130code/129table、4813 InlineTextBox其中4485换。
重要范围纠正：过去“60表格60代码35047字符”是被定位目标回答的数量，不是整页总量。QA157父文档实际190code/189table。不能把整页AX约100ms全部归因这一条目标回答，也不能假定外部4485节点是隐藏/无关内容；需映射DOM区域及渲染窗口。既有性能证据保留，但静态分析/对外报告必须附此范围。
证据desktop/qa159-ax-regions.json、qa159-rich-subtree.json；两分析TS strict通过。不是native序列化payload计数，不证明全部AX树重建。下一步核对会话渲染窗口及其他回答是否存在不必要重排，完整目标active，产品无新改动。

## QA160：DOM区域确认是200条当前消息加四个长预览，非旧话题残留（2026-10-30）
独立同profile准备目标后读取DOM：body6963后代元素（document全体6977）、当前thread6692后代/200 data-msg/100 markdown/188pre/189table；earlier0消息0代码表格，history-list与drawer为空，openTopics[]、closedTopicsWithRows0。符合THREAD_MAX200；OPENED_TOPIC_MAX100是另一独立旧话题上限，不能混淆。
目标m2001完整60pre60table/35047正文字符。其他四条m2003/2005/2007/2009均保留answer-more未展开，预览分别32/35/30/31pre与32/35/30/32table，行textContent约12953/12629/13163/12925字符（含按钮等非正文）。这四条预览解释目标外大部分富文本负载，没有发现重复渲染/隐藏旧话题残留证据。
修正QA159口径：AX role code190不等于DOM pre代码块；本轮实际pre188，AX还可包含内联代码语义。QA159 code190/table189是AX角色计数，不应对外称190个代码块。
证据desktop/qa160-dom-response.json及setup/cleanup；实例正常退出。之后优化不能简单删除四条预览或减少200条合同来制造通过；可针对同负载的文本更新效率继续验证。无产品新改动，完整目标active。

## QA161：列宽候选完整回归通过，刷新验收身份与历史结果边界（2026-10-30）
首次npm test在受限沙箱下session90223最终exit1，日志含sandbox临时目录MoveFileExW EACCES/Win325等失败，qa161-full-tests.log原样保留。终态确认后在常规本机权限重跑，session81877 exit0，775/775测试通过，duration20788.5529ms；npm run typecheck全套通过。没有改代码/系统安全设置来掩盖受限环境错误。
最新源文件含列宽write-after-read修复，qa161-candidate-manifest.json记录baseHEAD及所有已改/新增src/test文件SHA256。原QA140安装产物早于此修复，所以current-evaluation更新manifest、fullTests/typecheck证据，将smoke/installed置false（未复测当前候选，不是已知功能失败）。旧报告保留evaluation-before-qa161.json。构建证据仍QA147，因为之后产品源码未改；QA142冷展开数值保留并明确历史候选，不冒充最新重测。
评估器实际运行仍FAIL，current-evaluation-verdict.json更新。下一步当前候选六阶段smoke与实际产物验证，以及尚未解决的AX/全文/原生快滚性能项目。无需重复运行未改代码的完整单测。完整目标active。

## QA162：当前源码六阶段 smoke 终态核对
2026-10-30：qa162-smoke/result.json 六阶段 setup/walkthrough/relaunch/memory/resume/timeline 均 exit0；逐阶段日志终行均 checks passed 且无 console warnings/errors。本轮重新读取终态和日志，正常权限进程命令行查询未发现 qa162-smoke/SMOKE_PHASE 匹配进程（该查询不证明所有后代进程清理）。开发构建、隔离假模型 smoke，不是实际安装或真实模型性能验收。current-evaluation 仅更新 smoke=true，installed 仍 false；整体性能仍未通过。未改产品代码。

## QA163/164：最新候选打包一致性通过，独立安装包构建中
2026-10-30：QA163 electron-builder --win --dir exit0。audit-package-qa163.ts 核对 QA161 候选源码哈希未变，全部297个 out 文件与新 ASAR 字节一致；ASAR SHA256=2408940d56b53cf0dd14a3ba2ed8648f2dff8ceb3780a0b6e11460564b5cdcc3。证据 qa163-package.log、qa163-package-audit.json。准备独立QA164身份，142载荷文件清单及配置在 package-validation-qa164/manifest.json，GUID 4d67fccb-eeeb-4b08-a662-1fe457e2a744。NSIS构建 exec session8361 已启动，尚未确认终态；下轮应先轮询同会话，不重启。日志 qa164-installer-build.log。尚未执行安装，不更新 installed gate。新增两个TS工具严格类型检查通过。产品源码未改，性能目标未完成。

## QA164：当前候选实际安装及六阶段回归全部通过
NSIS构建session8361 exit0；独立GUID 4d67fccb-eeeb-4b08-a662-1fe457e2a744，安装进程32024 exit0。安装根 C:/Users/ADMINI~1/AppData/Local/Temp/viva-performance-install-VCyLsR/app，142载荷文件逐个hash一致；安装器SHA256 d9709b3b857aced37da000e48d8908ca98099a64497b5e93efca723f0a812cc7。注册/快捷方式前后快照比较：现有条目与三个快捷方式hash不变，新QA身份注册成功。
安装后smoke session24694 exit0，setup/walkthrough/relaunch/memory/resume/timeline全部exit0、六日志checks passed且无console warnings/errors。正常权限查询隔离安装根下remaining[]。证据package-validation-qa164/{install-temp-source.json,installation-isolation.json,installed-temp-source-six-phase.json,smoke-completion.json}。仅覆盖独立注册安装，不是生产升级/快捷方式行为或真模型性能验收。
current-evaluation更新installed=true与当前安装manifest，整体性能缺项与失败保留。未新增产品改动，无合并发布。下一步回到全文冷展开与原始后台快滚性能诊断。

## QA166：真实后台输出期间正文mutation与AX诊断
当前候选、独立PID34160、完整AX、150%同富文本负载。真实后台任务经bg-send启动，viva_stream事件确认；5秒测量窗口task_update计数52→1482。目标markdown与thread其他区域mutation均0，root属性mutation0，节点身份/全文text一致，正文705px/列宽755px不变。该观察支持纯后台输出没有在本轮重建主对话正文，不能证明同时快滚路径无问题。
后台612帧p95 8.4ms/max8.6ms、零longtask；renderer-only详细trace起止标记齐全，612个RunAccessibilitySteps最大0.544ms。空闲619帧p95 8.4ms/max133.4ms，有147ms longtask；空闲紧随setup/zoom且未详细trace，可能含收尾成本但未证明，不丢弃也不将空闲/后台差值归因模型。Observer仅thread/root，不覆盖composer等全部区域。单样本、未滚动，不计原始原生快滚验收通过。
任务停止后正常退出，remaining[]/API不可达/无录制进程。证据desktop/qa166-background-mutations.json、同名trace、qa166-summary.json；工具qa166-background-mutations.ts/analyze-qa166.ts严格类型通过。未改产品代码。下一步相同稳定负载+真实输出+连续wheel对照，原生输入范围仍独立记录。

## QA167：真实后台输出+连续Electron滚轮对照，速率不足需明确限定
当前候选完整AX/150%，setup后额外稳定1.5秒，空闲与后台均renderer-only详细trace。各注入并实际收到160个wheel；空闲154次scroll、后台152次scroll，正反向循环回到起点。空闲注入5965ms、后台9198ms，平均约26.8/17.4Hz，远低于请求16ms节奏；接口往返开销限制，不得称为物理快速连滚通过。
空闲733帧/后台1119帧，p95均8.4ms、max均8.5ms、零longtask；AX max0.065/0.624ms，起止标记齐全。后台前5秒task_update47→1240，目标与thread/root mutation0、宽705/列755不变，节点及文本保持。mutation窗口仅5秒，短于两组完整注入时间；不能推断其覆盖全部wheel期间，也未记录每个更新与每个wheel交叠时间。数据不支持本轮正文重建卡顿，但不足关闭原投诉。
任务停止/实例正常退出remaining[]、API不可达。证据desktop/qa167-background-mutations.json、qa167-summary.json、idle/background traces。QA工具strict通过，无产品修改。下一轮需要提高可重复注入速率、同步观测区间及记录实际到达分布，并继续区分Electron输入与原生物理输入。

## QA168：提高输入频率并补齐完整观测与真实输出交叠
当前候选完整AX/150%，独立隔离实例；每组320个Electron wheel全部实际收到。最多8个并发请求、8ms调度目标，实际首末到达空闲5642.5ms/后台6096ms（约56.5/52.3Hz，仍不是125Hz）。后台wheel首末之间task_update增加1349，确认真实输出与滚动交叠。scroll事件560/511；异步滚动可多次，不把它当wheel次数。
空闲727帧/后台790帧，p95 8.4ms、max8.5ms、零longtask；AXmax0.121/0.484ms。MutationObserver从输入前持续到所有请求结束后300ms，目标/thread/root变化均0；目标节点与text保持、正文705px/列宽755px不变。两组详细renderer trace，有起止标记。未复现原生快速连滚投诉；Electron.sendInputEvent不等于物理鼠标或最终屏幕呈现验收，也不排除合成线程/GPU/输入路由/其它内容条件。
任务停止、正常退出remaining[]/API不可达。证据desktop/qa168-background-mutations.json、qa168-summary.json和idle/background trace；prepare/runner/analyzer TS严格通过。无产品改动。下一轮应避免重复相同无效对照，优先验证实际滚动到达分布、原生输入与呈现差异，或回到已确证的冷展开/窗口AX问题。

## QA169：复用QA168 trace检查合成/呈现证据，收紧滚动结论
只读离线分析，未启动应用。主对话markdown代码块原本为单个code文本节点，highlight.js spans用于文件预览；排除以代码高亮DOM膨胀解释当前主对话负载的假设。
QA168 trace包含ScrollJankV4：空闲238条、后台149条携带is_janky的记录，均ph=b、is_janky=false。原事件总数476/298包含结束相位，不能重复计数。EventLatency的MOUSE_WHEEL记录640条不等于640次输入（实际320），所见has_high_latency均false；未对超JS安全整数的事件ID做join，也未将未核实单位的args字段换算为时长。
两组各320条GESTURE_SCROLL_BEGIN、320 FIRST_GESTURE_SCROLL_UPDATE、320 GESTURE_SCROLL_END元数据，说明注入形成逐次独立手势；不能声称其等价于物理连续wheel序列。具体真实鼠标手势形态尚未录制，对照不充分。
FrameSequenceTrackerV3存在非零dropped_v3/v4：例如后台RAF expected660、dropped_v3=18/v4=1，JSAnimation expected661同18/1；这些分类可能重叠且时间范围可能跨标记，不能相加为用户滚动丢帧率。没有checkerboarded/missing_content的所示记录不足以代表全设备。原max8.5ms是rAF采样，不是完整屏幕帧间隔；不再把无主线程长任务理解为无合成掉帧。
证据desktop/qa169-compositor-inventory.json、qa169-jank-details.json，分析TS strict通过。下一步需要原生物理输入/浏览器合成链边界证据；原问题仍未闭环。产品无修改，目标active。

## QA170：真实后台任务+原生单次滚轮，校正手势假设
通过computer-use sky选定唯一窗口Viva 验收 qa170-native-wheel/PID28588，完整AX/150%，观察截图后单次scrollY600并立即刷新。动作UTC08:43:24.169–24.208；实际收到1个trusted wheel delta333.3333，事件时task_update累计2745，最终7043；目标全文text一致，动作后500ms60帧max8.4ms、无longtask。
原生单动作trace同样有GESTURE_SCROLL_BEGIN/FIRST_GESTURE_SCROLL_UPDATE/GESTURE_SCROLL_END各1条；故QA169的“每个注入形成独立手势”不能单独证明注入不符合原生路径，仍需真正连续原生事件对照。该修正是原生实测反证，不能继续把独立手势作为故障解释。
trace存在目标wheel及ScrollJankV4 is_janky=false，但只找到qa-native-start，缺end；可能长录制缓冲截断，尚未核实，不作完整覆盖通过。原生输入与截图会引入UIA，500ms仅rAF不代表最终呈现。非物理快速连滚验收。
任务正常结束/stop后实例退出remaining[]、API不可达、无录制。证据desktop/qa170-{setup,begin,end,summary}.json、qa170-native-wheel.trace.json与cleanup。全部新增TS strict通过，无产品改动。目标active；下轮优先核查trace范围或已确证冷展开性能，不重复单次wheel代替连续操作。

## QA171/172：冷展开偶发快样本实际漏计延后AX，发现测量边界问题
QA171四个新renderer ABBA contain:layout style/default/default/contain。全文247.3/84.7/85.7/79.6ms，几何相同193181.40625x672.857px、507节表格代码、选择hash一致、完整AX flags及约3.84万AX节点。由于未改CSS的baseline也变快，不能归因contain；原型不合入。
QA172原样式五个新renderer，前后AX enabled=true且nativeAPIs/webContents/inlineTextBoxes/extendedProperties一致；详细renderer trace记录。原双rAF fullMs90.1/262/259.1/252.3/96.4。分析最后一次EventDispatch click与后续RunAccessibilitySteps：
1：AX点击后101.203–267.753ms，耗166.55ms；旧计时90.1ms提前结束。
2：AX91.342–260.913ms，耗169.571ms。
3：AX94.160–257.958ms，耗163.798ms。
4：AX84.594–251.924ms，耗167.330ms。
5：AX113.633–290.660ms，耗177.027ms；旧计时96.4ms提前结束。
这是双rAF完成不等于AX更新完成的直接证据，短样本不能当修复/性能通过。旧PerformanceObserver在100ms等待后断开也可能漏掉延迟投递记录；具体投递机制尚未单独证实。trace没有qa-native-start/end（冷脚本未调用frame-start/stop），但两次click与昂贵AX均存在；不是QA170缺end的同一覆盖结论。后续测量需显式点击标记、固定后观察窗口、保留同步/视觉/AX分别完成时间，不以等待窗口长度冒充展开耗时。
全部实例finally正常清理；strict通过。证据desktop/qa171-cold-expansion.json、qa172-cold-expansion.json、qa172-trace-comparison.json、qa172-click-ax-timing.json及各trace。无产品新修改。整体仍FAIL，下一步修正冷展开观测边界并定位AX延后工作来源，不采用无效CSS原型。

## QA173：明确标记与后观察窗口确认冷展开AX仍超标
五个当前候选新renderer，完整AX，添加performance.mark点击/双rAF/后观察结束；双rAF后继续观察1000ms并takeRecords。三标记每个trace各唯一，buffer5.3–6.1%，全部507节DOM/AX及选择hash保持。昂贵AX endFromClick分别263.787/259.829/266.283/264.068/258.732ms，AX自身164.828–171.614ms；双rAF88.560/260.044/267.595/265.377/258.959ms。观察1000ms仅用于覆盖，不是展开耗时。
第一轮AX开始98.959ms、结束263.787ms，双rAF88.560ms已返回；即使延长观察并takeRecords，LongTasks仍只报告22.1ms开始的66ms任务，未报告后段164.8ms AX。因此QA172所述“可能仅延迟投递”不足解释；LongTasks API未覆盖该工作，具体任务归属需再看trace。不能以无longtask或双rAF提前返回宣告通过。
证据desktop/qa173-cold-expansion.json、qa173-measured-boundaries.json、qa173-receipt.json和五trace；新增工具strict通过。五个cleanup回执均cleaned。current-evaluation追加最新候选AX边界与证据，保留历史fullMs口径并说明差异，实际评估FAIL。未改产品代码，下一步分析快/慢样本AX所在task/调用来源，定位为何可跨双rAF但依然阻塞。

## QA174：快/慢样本任务归属与Chromium延迟AX调度证据
离线分析QA173五trace，在同PID/TID查找完全包含昂贵AX的X事件。快样本1：点击后98.867ms开始独立RunTask166.036ms，ThreadControllerImpl来源cc/trees/proxy_impl.cc ScheduledActionSendBeginMainFrame802，ProxyMain::BeginMainFrame→Commit→RunAccessibilitySteps。慢样本2–5：RunTask点击后23–29ms开始、耗234–244ms，布局与AX同属该帧任务。
快样本AX前150us出现ThreadControllerImpl::RunTask，src_file third_party/blink/renderer/modules/accessibility/ax_object_cache_impl.cc、src_func CommitAXUpdates、src_line3603、task_delay_us147259，随后ScheduleVisualUpdate路径。现有精确版本源码3495–3507 GetDeferredEventsDelay加载后150ms/加载前350ms；3532–3610 CommitAXUpdates检查in-flight与距离上次序列化的间隔，不足时PostDelayedTask(ScheduleAXUpdate)后返回。trace任务来源与该代码相符，支持AX被另一次帧提交执行，解释双rAF计时波动。不能将147ms任务计划延时直接当成点击后的额外等待（相对起点不同），也未单独证明LongTasks API为何不归属该任务。
这是调度解释，不是关闭AX、改Chromium延迟常量或把工作挪后即可解决；约165–172ms实际AX执行仍在，用户输入可能受阻。验收继续区分视觉双帧、实际AX工作与后续交互，不将固定观察窗口算展开耗时。
证据desktop/qa174-ax-task-ancestry.json、chromium-152-ax-object-cache-impl.cc；analyze-qa174.ts strict通过。无新运行/产品修改，目标active。后续应针对AX实际工作量或节点范围优化，避免继续用调度巧合制造通过。

## QA175：冷展开AX身份差分主要为新增正文，区别于宽度变化失效
当前候选隔离新renderer、完整AX、默认缩放；冷预览71标题/70表格，持久CDP Accessibility.enable会话前后getFullAXTree。全文507节。全父文档StaticText4506→10187，4492保留、5695新增/14移除、保留节点childListChanged0；InlineTextBox6458→12139，6444保留、5695新增/14移除。所有231个既有heading、224table、225code角色保留，未见宽度变化实验那种大量旧inline身份更换。
以唯一“第 1 节”heading的parent为正文子树，前3736/后26872原始AX节点（含ignored节点），新增23139、移除3、仅1个保留节点children改变；标题71→507、表格70→507。正文外15683→15705，新增65/移除43、7个保留节点children变化，旧160heading/154table保持。
这支持展开主要新增完整正文，而不是重复重建旧预览/整页；但稳定ID不证明节点没有被重新序列化，CDP快照不是native payload计数，也不作性能计时。不能将raw节点数与可见AX nodeCount混用。下一步关注必要新增结构的序列化成本及是否重复发送稳定节点，不套用窗口宽度失效根因。
证据desktop/qa175-before.json、after.json、identity-analysis.json、subtree-difference.json；所有工具strict通过，实例finally正常清理。无产品改动，目标active。

## QA176：取得官方Electron符号并完成既有renderer CPU样本函数映射
官方GitHub electron/electron v44.7.0资产查询：PDB包约2.06GB，选择59,941,442字节Breakpad symbols包。下载SHA256 3f2a792a8acd8a5d67e76c86e209472700073bec43da633eb0f0d92701fac2b7 与release资产digest一致。文件MODULE windows x86_64 51ADB449838930864C4C44205044422E1 electron.exe.pdb；直接解析实际运行E:/viva/Viva/node_modules/electron/dist/electron.exe PE debug directory得到相同RSDS GUID+age，非仅按版本猜符号。
流式解析553264个FUNC范围，将QA149已完成WPR reader中92个Electron CPU instruction样本全部映射；其余14unmapped/3ntdll/1kernelbase不在本次符号范围。出现AX SerializeUnignoredAttributes/AXNodeData/AXSelection/AXBlockFlowData、文本布局、allocator/memcpy/Mojo buffer等。最高单函数9样本，无足以确证单一主热点的分布。Breakpad范围可能涉及链接器折叠/别名、无inline调用链；不能把所有allocator样本直接归为AX，更不能把窗口resize样本套到冷展开。
证据desktop/qa176-symbol-assets.json、qa176-symbolized-cpu.json，symbols-qa176/symbols.zip与extracted/breakpad_symbols。symbolize-qa176.ts strict通过，无新应用操作/产品修改。下一步可用匹配符号解析既有栈，或冷展开WPR采样，补足AX成本函数归因。源码SerializeChanges去重逻辑只说明机制，仍无实际序列化节点payload计数，不能声称已证明是否重复发送稳定节点。

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

## QA218：过程行contain布局隔离否证（2026-10-30）
同renderer四轮ABBA，仅诊断CSS .tp-steps .trace-row{contain:layout style}。基线handler34.2/29.9ms、AX61.245/59.001ms；对照handler29.6/31.3ms、AX60.234/56.603ms，无稳定收益，不采用产品修改。
四轮完整选择文本hash5269648b66748acf3f4d663c3276fb796b0ec3d5d058d988397ac86029f173ed一致，列表高度68964.289、scrollHeight76365、top75663.43一致，页面宽1360无溢出。全部节点/草稿断言通过，cleanup成功。不是原生滚轮或视觉验收。整体FAIL保持。
已准备smoke-qa219.ts，校验qa211源码清单并补当前保护后的六阶段开发构建回归，尚未启动；启动前需备份当前快捷方式原始字节及目标元数据，结束后再次比较。未完成的原快捷方式恢复继续独立记录。

## QA219：当前源码通知保护后六阶段smoke通过（2026-10-30）
smoke-qa219.ts逐文件校验qa211-candidate-manifest后，当前开发构建setup/walkthrough/relaunch/memory/resume/timeline全部exit0。测试前原始Viva.lnk字节及目标保存在qa219-shortcut-before，测试后hash相同。此仅证明本轮未再次改写，不代表此前QA210造成的入口变化已恢复。根PID只读检查无残留，仅根PID范围，不宣称完整后代清单。
current-evaluation.regressions.smoke更新true；实际安装当前保护版本仍未完成，installed仍false。原生通知被smoke guard隔离，本轮不验证真实通知。整体性能FAIL继续，未提交/发布。
证据：qa219-smoke/result.json、各阶段log和output、post-check.json；qa219-shortcut-before/snapshot.json及原始lnk。

## QA220：真实工具结果证据发现沙箱准备失败（2026-10-30）
真实后台任务fork-81808d82-e3eb-4449-860c-86a85f2d4b5b请求12次纯整数乘法。权限事件仅toolCallId，参数在关联tool_call事件，rawInput含command和description；脚本原白名单因此未放行。运行中读取精确参数后仅手动批准perm-1，命令Write-Output (17 * 19)。后续未扩大权限或修改ACL。
关联工具结果明确status=failed：SetNamedSecurityInfoW failed (Win32 5): grantWrite(E:\viva\qa-20261029-performance\desktop\profile-qa51-live-rich\workspace)。计算未执行成功，不能把步骤数量、脚本exit0当12次工具验收通过。复制配置仍指向旧profile工作区是下一步需核查的夹具路径问题，不先归为产品缺陷。
模型随后加载诊断技能并提出重试；本轮未授权目录修复，主动stopTask，同一runner正常结束并保存cleanup。中途事件保存在desktop/qa220-live-interim.json、qa220-live-after-approval.json，最终UI与trace在qa220-task-steps.json及trace。临时关联授权安装尝试报Script failed，不能认为已成功安装；唯一确认的额外授权是已读回命令对应perm-1。
下一步修正工具事件关联与隔离profile工作区配置再验收，不使用更宽权限掩盖准备错误。总体FAIL，真实12步工具结果完整验收未通过。

## QA221–222：新工作区复核仍为沙箱准备失败（2026-10-30）
源码确认：main.ts的workDirFor/新话题沿用当前话题cwd，因此仅设置AGENT_CWD不会改写复制历史的当前目录。QA221过早调用switchWorkDir，返回unavailable；未进入工具测试，cleanup成功。QA222改为新话题ready后切换，getWorkDir确认current/defaultDir均为本轮profile-qa222-task-steps/workspace。
权限匹配修正为按taskId/toolCallId关联tool_call.rawInput，只接受command/description键和严格纯小整数乘法，allow_once最多12次；本轮成功批准1次。首个工具call_00_zU7X37UxVSgPS6ejxhYx7620返回failed：SetNamedSecurityInfoW failed (Win32 5): grantWrite(E:\viva\qa-20261029-performance\desktop\profile-qa222-task-steps\workspace)。新目录仍失败，否证“仅旧配置路径导致”的解释。没有修改ACL或扩大工具权限，失败立即stopTask。
QA222仅3条过程，展开handler3.6ms、节点/草稿/焦点保持，但12个计算未成功，不能宣告真实多工具或大量过程性能通过。runner exit0不是业务成功。cleanup=true、remaining=[]、API不可达。原始结果及错误在desktop/qa222-task-steps.json和trace，QA221失败保留。
下一步：真实命令工具验收暂被沙箱准备阶段阻塞，可继续独立UI/性能和安装证据工作。不得通过自动重试或放开权限掩盖此错误。整体FAIL保持。

## QA223：当前通知隔离版本打包与依赖清单核验（2026-10-30）
当前源码qa211清单核验通过，electron-builder --win --dir --publish never输出到package-qa223，全程未安装/发布。297个out文件与ASAR逐一字节匹配；ASAR SHA256 b259d9852ff662ec45bde95f64795d4d1c81d8032c60e15d41cad6b673cd1303。后处理374包（366补齐），10199归档文件、68解包文件；初始依赖收集警告不能直接当最终缺包。
独立核验374个运行依赖package.json均可读取；369字节一致，5个（zod/yaml/marked/highlight.js/@agentclientprotocol/sdk）仅keywords/bugs/scripts/tags/contributors中部分字段差异，入口与依赖字段一致。最初核验使用正斜线传给Windows asar接口误报缺失，失败报告保留；改用path.join后确认路径问题，不能把初始报告当缺包事实。
这不是运行时解析/安装验收：当前包六阶段运行、实际安装与通知隔离仍需验证，installedCurrent保持false。未解决QA210快捷方式恢复。当前目录可用于下一轮独立打包运行证据，不能代替安装回归。整体FAIL。
证据：qa223-package.log、qa223-package-audit.json、qa223-dependency-audit.json（错误路径报告）、qa223-dependency-audit-native-path.json、qa223-dependency-audit-fields.json。

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

## QA227–228：程序目录/cwd交叉对照（2026-10-30）
QA227使用C临时目录同字节Viva.exe、cwd=原qa224-smoke目录，setup exit0；QA228使用E原产物Viva.exe、cwd=C临时目录，setup约23ms以0x80000003退出。由此支持失败跟随可执行文件所在目录而非cwd；尚不能单独归因于具体ACL/磁盘。原exe无Zone.Identifier，仅:$DATA。未修改任何权限。
QA229已准备当前产物独立安装身份，GUID c9aa8334-ebed-46a7-9fce-4df93654b62d，名称VivaPerformanceQA20261030QA229；源码297文件与QA223 ASAR一致、142payload有清单。安装器构建在进行，尚未安装，不宣称安装回归通过。旧QA210保留等待快捷方式恢复。
证据：qa227-smoke/result.json、qa228-smoke/result.json、package-validation-qa229/manifest.json/qa-installer-config.json、qa229-installer-build.log。整体FAIL。

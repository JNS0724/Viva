# 解锁后窗口矩阵与标题栏作用域优化

2026-10-30，工作区 `release-qa-20261028`，分支 `codex/performance-20261029`。产品基线 `b86d61922dd8c183f9097928f43cfd0560924624`；测试时 HEAD `32033f1fc993c4effabf0c112162b5ea7be655f4`（中间均为记录提交）。原始文件位于 `E:/viva/qa-20261029-performance/desktop/`。封存 stash `12d75c9` 未使用。

## 原生矩阵 QA60

独立 profile `profile-qa60-unlocked-matrix`，主进程 21308、renderer 5820、窗口 330592。1000 轮历史、当前 200 条/旧话题 100 条、507 节约 200KB 全文。系统缩放 175%、刷新率 120Hz。动作时间和失败原样保存在 `qa60-native-actions.json`。

| 场景 | 实际完成及帧最大间隔 |
| --- | --- |
| history100 / history150 | 最大化、还原完成；各 25ms，无 renderer 长任务 |
| full100 | 最大化、还原完成；133.4ms，两个动作窗口分别 133.4/116.6ms |
| full150 | 最大化完成；动作窗口 208.4ms、全段 250ms，renderer 长任务 109/166ms；还原输入报 unknown screenshotId，不能算往返完成 |
| full-resize100 | 刷新截图后完成一次 100% 还原，108.3ms；并未拖动、未覆盖最小窗口，且在 WPR 结束之后 |

`*-begin.json`、`*-end.json`、`*.trace.json` 保存原始值。full100/full150 有 trace 摘要和动作分析。Full100 的 renderer UpdateLayoutTree 约 40–46ms、task 约 100–116ms；full150 task 约 109/166ms、FunctionCall 约 74ms。Browser 主线程同时有约 365–408ms 消息任务，当前未独立确认调用者，不能直接套用旧 QA52 的 UIA 来源结论。ToDesk 浮层遮挡独立记录，不能归为 Viva 样式缺陷。

WPR 实例 `VivaQAPerformance-47a1ccef162f` 使用微软签名 WPR 的 GeneralProfile.Light / GPU.Light / DesktopComposition.Light；start/stop 均 0。录制约 2026-10-29 23:53:05.824–23:56:07.085 UTC，覆盖两种 history、full100 和 full150 的成功最大化。ETL 6,868,172,800 字节，SHA256 `3B98B16D006E32F5A84B8687689C3FAD75960DB920739F98F8AB2FAE1B51AC7A`，工作区副本重新校验一致。文件头 loss counters 为 0，但只读取了 4096 字节、没有遍历事件，CPU/GPU 归因仍待完成。

## 同进程 A/B/A 可逆对照

只改变现有 CSSOM 的 selector：将 Windows/Linux 的 `--reserve-right` viewport 计算从 html 限定到 `.titlebar`，随后撤销恢复。无 WPR 并发，轻量 trace 条件一致，未改产品源码或隐藏正文。apply/revert 回执禁止覆盖。

| 条件 | 全段最大帧间隔 |
| --- | ---: |
| A100 原规则 | 116.8ms |
| B100 限定标题栏 | 25ms |
| A100 撤销恢复 | 125ms |
| B150 限定标题栏 | 208.3ms |
| A150 撤销恢复 | 216.7ms |

B100 解析 124829 个事件、rejected=0，没有达到 3ms 的 UpdateLayoutTree；PrePaint 最大 13.1ms。100% 的改善有撤销反转支持，150% 的剩余停顿仍未解决。

作用域改变前后：标题栏左右 padding 为 12/149px，居中区 left566/width228/height48 不变；全文 507 标题/代码/表格、DOM13058、100% 高193215px 不变。全文选择 SHA256 `9966d570777e5f79e2e6d6bd9174b88fc4789c80474a2c3fc8f2d148778cbd59` 保持。无障碍 nativeAPIs/webContents/inlineTextBoxes/extendedProperties 始终 enabled。150% 窄窗口正文高193709px 是相应布局，标题栏几何前后同样不变。

## 产品候选与回归范围

据对照将 selector 局部优化落入 `src/renderer/styles.css`。构建、严格类型检查、完整 771/771 测试和 diff 检查通过，日志为 `titlebar-scope-{build,typecheck,full-tests}.log`。六阶段 smoke（setup/walkthrough/relaunch/memory/resume/timeline）也全部通过，session51717 最终 exit0，独立目录 `smoke-titlebar-scope-native`。受限环境的第一次 setup 启动异常退出（-2147483645），原日志 `titlebar-scope-six-phase.log` 保留；原生环境第二次使用全新目录、日志 `titlebar-scope-six-phase-native.log`，未覆盖首轮。memory 中预设失败 MCP 的自动恢复走到 dsh-recovered 检查成功。新构建原生及安装产物验证仍需完成，不能继承旧版本的安装或性能 PASS。

150% 轨迹 `qa60-scope-b150-functions.json` 明确记录 `column-resize.js` 的 apply 回调耗时 68.591/76.530ms，内部包含 36.933/39.330ms 的 UpdateLayoutTree 和布局。该函数在 html 写入 `--col` 后再次读取 area.clientWidth；响应断点和继承变量变化的贡献需要可撤销对照分离，尚未确认全部原因。

QA60 已正常退出，`qa60-unlocked-matrix-cleanup.json` 核对所有所属进程、API、录制和模型任务清理。总评估仍未通过，目标继续 active。后台真模型运行时，对已展开代码/表格长回答快速连滚的专项仍需复测；窗口切换优化不能代替该项验收。

## 新构建 QA61 原生验证

标题栏修复本地提交 `7a2f244ca575cfff808b8c9f1937e9727a1ec4ce`。独立 QA61 主进程12940、renderer38184、窗口1510278，profile `profile-qa61-titlebar-build`。没有采用以下列宽实验作为产品代码。

- `qa61-build100-clean` 成功完成原生最大化/还原，尺寸1360×861 → 2195×1187 → 1360×861。p95=8.4ms，全段最大17.7ms，两个动作窗口各最大16.7ms，visibility无变化、无长任务，trace解析有效。这确认了标题栏优化在新构建的100%场景有效，尚不是完整P02通过。
- 首轮 `qa61-build100` 保留失焦/hidden及4166.8ms间隔；还原输入被拒，提示点位位于其他应用，不能算成功往返。没有把后台节流间隔报成产品修复失败，也没有删掉它。
- 准备函数已提前展开全文，再调用要求初次显式展开的 audit 导致 `Expected explicit full expansion`。`qa61-warm-fidelity` 明确失败且不作冷展开/保真PASS；这是测试前置状态不符合，不归为产品缺陷。该准备过程后来打开旧话题，列宽对照使用完整507节全文、100条旧话题和200条当前消息。

150% 同进程列宽 A/B/A：原规则往返全段175ms；注册 `--col` 为非继承变量，仅给六个静态使用节点赋值后往返158.2ms；撤销后成功最大化175.1ms，接下来的还原输入报unknown screenshotId，不算往返完成。三段visibility均无变化。原apply回调55.546/62.969ms，对照42.798/37.402ms，撤销最大化63.668ms。对照有局部改善，仍有133/136ms长任务、约40ms布局，未达到帧预算。没有据此宣称150%修复或直接引入产品。

列宽实验保留完整选择哈希，六个使用节点的几何及193709px全文高度保持，AX各项保持开启。首版实验尝试新增style标签，被原CSP阻止（sheet为null），没有运行性能对照，已撤销并保留失败证据。第二版在现有样式表insertRule/deleteRule，核实CSSPropertyRule及正文不再继承该变量；未修改CSP或安全设置。两个版本回执均保留，不覆盖。

动作记录为 `qa61-native-actions{,-final}.json`，失败后重新选窗口、刷新截图；刷新后的一次还原另标 `restore-after-a150-return`，没有放入已结束的轨迹。QA61已正常退出，清理回执确认所有所属进程/API和录制清理。随后用五个全新profile测量新提交的冷展开，避免继承旧来源时间。

## 新来源五进程冷展开与真后台快速滚轮

`qa62-titlebar-cold-series.json` 五个全新进程均完成：预览73/75/69/73/74ms（p95=75），全文105/95/95/253/91ms（p95=253），第四次不满足150ms门槛，未删除或重测替换。其同步JS22ms，但记录到245ms长任务，完整延迟不能用同步JS替代。全部507标题/代码/表格、1521列表项/单元格/列头、完整选择哈希、193215px高度、锚点漂移0、200当前/100单个旧话题上限通过；五个进程均正常退出。

QA63 主进程29012、renderer38220、窗口1311636，全新profile复制已关闭的合成QA52历史，重新用当前构建打开此前真模型回答。主回答35047个渲染字符、60代码块/60表格、34890px高、3055个全页元素，100%应用缩放/175%系统缩放/120Hz。空闲、真后台各三轮32上/32下、192次原生滚轮请求、delta120，逐次请求时间和原始轨迹均保存。

| 项目 | 空闲 | 后台持续输出 |
| --- | ---: | ---: |
| trusted wheel事件 | 170 | 129 |
| 动作期间rAF p95 / max | 16.6 / 16.7ms | 16.6 / 16.8ms |
| 滚动位置更新间隔p95 / max | 41.7 / 100.1ms | 87.4 / 102.7ms |
| wheel处理到首帧max | 15ms | 13ms |
| 主回答所属thread新增/移除节点 | 0 / 0 | 0 / 0 |

两份短trace均有起止标记、wheel数量匹配、时钟误差小于0.18ms、解析rejected0、缓冲区未满。后台逐wheel输出字符26237→27621、task_end始终0；对应真实任务00:30:59.056–00:32:48.005 UTC正常done，共108949ms，覆盖全部00:31:51.963–55.674手势。任务结束后原回答节点、Markdown根、逐字文本、全部60代码/表格和展开状态保持。没有新观察到阅读可用性缺陷，残余滚动断续仍存在。

后台录制开始时应用一度hidden；原始全段15478.4ms rAF间隔位于手势之前，重新激活观察后才开始输入。原值保留，动作窗口另行报告，不能把它当手势卡顿。每条件只有一次手势，且空闲未录WPR、后台有WPR，不能据此估计稳定的后台开销比例。当前browser WM_USER1024约63–72ms与断续重叠，未独立确认调用者或GPU归因。

WPR19ebb4a383d2已停止，start/stop0，3,987,734,528字节，SHA256 `A91893BC0CC027472804BCBCD8B9E79157CBD8E54A517669D2C90093594D62C3`；工作区副本hash一致。实际ETL头时间00:30:30.099–00:32:01.709 UTC覆盖后台全部wheel，存储loss0，仅4096字节头部读取、未遍历事件。QA63真模型已结束，所属进程/API/录制均正常清理。详见 `qa63-rich-summary.json` 与 `qa63-wheel-checkpoint.json`。

当前evaluation已切换为产品来源7a2f244并保留旧来源报告；完整内容/预览/锚点通过，全文p95、完整滚动/堆/重复停顿、完整原生矩阵、P03/P04与新安装产物仍未通过。771项及六阶段回归不能替代这些门槛。目标保持active，未push/merge/release。

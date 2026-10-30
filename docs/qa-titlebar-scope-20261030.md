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

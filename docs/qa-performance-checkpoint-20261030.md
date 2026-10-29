# 性能验收检查点：安装回归、冷展开与驱动更新后的捕获故障

2026-10-30 CST。产品来源仍为 `b86d61922dd8c183f9097928f43cfd0560924624`；此前 Git HEAD `e37121b4cbf12d845b9ce97df287b60034868e44` 与它仅有验收文档差异。本次没有修改产品、恢复封存 stash、推送、合并或发布。

当前整体评估仍未通过。实际安装回归和五进程全文保真已有新增证据；200KB 全文展开观测 p95 为 254ms，超过 150ms 预算。用户确认驱动安装已经结束后，刷新 Computer Use 会话仍不能恢复截图，原生窗口矩阵继续待测。已正常退出本轮全部 Viva 测试进程并关闭测试 API。

## 当前来源的实际安装回归

独立 QA 包复用正式构建的全部 payload，仅隔离注册身份和 exe 文件名，保护用户原安装。正式 app.asar 与当前构建的 294 个 out 文件全部匹配；实际安装后的 144 个 payload 文件也全部匹配。不能把独立安装包装视为正式升级、快捷方式或所有安装路径行为的验证。

- QA 名称：`VivaPerformanceQA20261029b86d619`；GUID：`acd3104f-7cb3-4b34-a56e-0724310a4626`。
- QA 安装器 SHA256：`6aef765130ac242b2756948272a73c06d3ff4ba2f9c0ff011980f6b7dd34fb0a`。
- 独立临时安装根：`C:/Users/Administrator/AppData/Local/Temp/viva-performance-install-egReXV`。安装及测试从仓库外实际目录运行。

| 安装目录内的阶段 | exit | 耗时 |
| --- | ---: | ---: |
| setup | 0 | 10.901s |
| walkthrough | 0 | 33.715s |
| relaunch | 0 | 48.241s |
| memory | 0 | 55.493s |
| resume | 0 | 4.715s |
| timeline | 0 | 14.250s |

六阶段 15:35:20–15:38:08Z 完成。使用既有合成 fixture 和本地模型替身，memory/resume 使用包内 DSH；这组回归不是新增真模型场景。relaunch 的展开回归确实在已安装程序中执行：`offsetShift=0`、`anchorShift=0`，`preparationKept/stillExpanded/settledKept/jumpStillWorks` 均为 true。不能只因源码测试通过而继承该结论。

另一次包内 perf exit0、16.292s，但只测预览，且与离线 ETL 分析并行，仅作诊断。两张窄窗/任务浮层截图样本中核心按钮与输入可见，不代替完整原生矩阵。工具拒绝后的回答仍可能保留英文技术错误，记录为可读性弱点，未据此修改模型回答。

15:46:32–15:46:34Z 独立卸载 exit0，目标 app 目录及 exe 消失，QA 安装/卸载注册项从存在变为不存在。原有两个 Viva 启动快捷方式哈希保持一致。证据根：`E:/viva/qa-20261029-performance/package-validation-b86d619`，包含 manifest、安装/卸载回执、逐阶段日志及前后快照。

## 五个独立进程的 200KB 冷展开

`desktop/qa53-current-cold-series.json` 保存五个独立 PID 的结果；各次均开启无障碍支持。PID 依次为 53100、39252、39512、14120、10420。

| 样本 | 预览 | 全文展开 | 锚点漂移 |
| --- | ---: | ---: | ---: |
| 1 | 75ms | 254ms | 0px |
| 2 | 77ms | 233ms | 0px |
| 3 | 71ms | 93ms | 0px |
| 4 | 69ms | 254ms | 0px |
| 5 | 70ms | 90ms | 0px |

各次完整选择文本哈希均为 `9966d570777e5f79e2e6d6bd9174b88fc4789c80474a2c3fc8f2d148778cbd59`。507 个标题、代码段和表格，以及各 1521 个 listitem/cell/columnheader 均保留；全文高度 193215px，无全页横向溢出。DOM 最大 13060，仅作诊断；当前/旧话题绘制上限分别为 200/100。

第二个进程在首次打开文档前遇到 HTTP 连接中断。核实原 PID 仍在后，改为每次请求关闭连接，续测同一进程；未重测已完成样本，也未删原失败。记录 `qa53-cold-series-transport-interruption.json`。

预览观测 p95=77ms，全文 p95=254ms。之后才观察到 NVIDIA 安装器；用户确认的是“现已结束”，无法反推这五次与更新的时间关系。原时间保留为诊断，正式时间数组仍为空，需在确认稳定环境后复核，不能把本组写成性能通过。五次语义/布局/选择/锚点保真可独立核对。

## 已有快滚 ETL 的 CPU/栈分析

继续分析此前真实 60KB 富内容回答、后台任务快滚时的最长 110ms 位置更新间隔。目标窗口为 14:17:39.286–14:17:39.597Z，共 311ms；没有重新制造负载或把它外推为整段会话。

- 旧 4MiB/s 分析 PID32868 已消失，没有最终结果。原状态文件中的 running 是陈旧状态；独立终态审计没有匹配 WER 记录，但无法解释其退出原因。
- 改为独立隐藏进程、直接 stdout 落盘的扫描 PID40284 已完成 exit0：全文件 24,699,680 事件，目标窗口 117151 事件，CPU profile 1252，目标线程 183 样本。最初 Image v2 解码不适用于实际 v3，保留失败，不作模块归因。
- 新 Image v3/StackWalk v2 解析 PID9952 到达 EOF，ProcessTrace/CloseTrace 均为 0；但保留栈达到 2000 条上限，丢 329 条，另有 2 条图像解码错误，工具 exit10，完整分析仍未通过。
- 183 个目标 CPU 采样中，electron.exe 82、未映射 46、ntdll.dll 22、UIAutomationCore.dll 14、COM 10。约 68.943ms WM_USER 消息内部去掉首尾各 1ms 后共 67 样本，其中 electron 28、ntdll 11、未映射 10、UIAutomationCore 9、COM 3。采样数不是 CPU 毫秒。
- 保留的前 2000 个目标栈中，124 条包含 UIAutomationCore；它们混合采样/上下文切换且截断有偏，不能计算 CPU 百分比。原始栈时间戳未假定为 FILETIME，也未精确配对到采样事件。

这进一步支持无障碍/COM 参与消息处理的可能性，但没有函数符号或本轮外部请求者 PID 证据。已录 WPR 配置启用采样/上下文切换栈，没有 UIAutomationCore provider。此前 QA48 识别过 Computer Use 辅助进程，只能解释其对应条件，不能覆盖本轮全部消息。报告和原始回执：`desktop/qa52-rich-gap-profile-analysis.json`、`qa52-rich-gap-profile-state.json`、`qa52-recorded-builtins.wprp`。

## 驱动更新后：GPU 仍活动，捕获设备仍失效

用户明确允许恢复全部方法测试，并确认 NVIDIA 更新已结束。RTX5080 当前 NVIDIA 驱动 621.01，显示为 3840×2160/120Hz；应用/系统缩放分别为 100%/175%。

Computer Use 原生截图报错：

> Direct3D11CaptureFramePool.CreateFreeThreaded failed: GPU 设备实例已经暂停。使用 GetDeviceRemovedReason 以确定相应的措施。 (0x887A0005)

原窗口文字树仍可读取，但点击最大化报 `coordinate input geometry is unavailable`。此前 Alt+Space、X 没有改变 1363×863 的窗口尺寸；不能算成功原生动作。刷新窗口选择后仍失败；本次另 reset JavaScript kernel，重新初始化受支持的 sky API、list_windows/get_window，并重试一次截图，仍为同一错误。没有使用旧截图坐标、操作用户驱动/系统设置、终止 Codex/辅助进程或用程序设尺寸冒充原生动作。

`qa53-native-full100` 记录 10553 帧，p95=8.4ms/max=16.6ms，`resizes=[]`。这是失败操作后的空闲样本，不能用于 P02 通过。对应 WPR 实例 `5d737a3096cc` 已停止，start/stop0，3,774,873,600 字节，SHA256 `563BDE4449D69BC0FBAD3C21A50B765A1066E513B0E8244FABAA8224B8C19EB3`。因没有成功原生动作，明确标记 unused/capture failure；没有再开空录制。

用户观察独显仍工作后，先作只读采样，再正常退出 QA53，复查如下：

| 指标 | 退出前 | 退出后 |
| --- | ---: | ---: |
| NVIDIA 整卡瞬时利用率 | 约 10–11% | 约 11% |
| 整卡功耗 | 约 47W | 约 48W |
| 显存 | 约 2064MiB | 约 1947MiB |
| Windows 桌面合成 3D 引擎样本 | 9.44–9.55% | 9.54–9.64% |
| ToDesk 两个编码引擎样本 | 各约 4.7–5.1% | 各约 3.1–3.2% |

每组 Windows 引擎采样为 5 次、间隔 1 秒，保留大于 0.1% 的值。退出前 Viva 没有超过该阈值的引擎样本，这不等于精确零占用。不同引擎百分比不能相加为整卡利用率；GPU 上下文列表也不等于持续计算负载。这份短观察不能作为一般空闲功耗基线。

退出后主要活动仍由 dwm.exe、ToDesk.exe 记录，Codex 界面有少量 3D 活动。显卡继续工作与截图句柄失效不矛盾；“更新后旧捕获设备失效”仍是待核实的解释，不能说显卡停止工作，也不能把截图错误归为 Viva 产品缺陷。

正常退出回执 `qa53-final-cleanup.json` 核对 main/GPU/renderer/utility 及本轮所属子进程全部消失、API 无法访问、无本轮 WPR/ETL 读取进程。未改动 ToDesk 等用户程序。GPU 前后快照和恢复错误保存在 `desktop/gpu-activity-20261030-{before,after}-cleanup.json`、`qa53-driver-capture-recovery.json`。

## 评估与下一步

`record-resumed-checkpoint.ts` 核对 16 个回执并保存哈希至 `desktop/resumed-driver-checkpoint.json`。更新前 evaluation 已归档，当前仅把本轮 processCleanup 更新为 true，并加入原始证据和限制；没有把空闲帧当作窗口性能、也没有把缺失时间变成通过。

QA strict noEmit 通过。重新执行 `evaluate.ts current-evaluation.json` 返回 exit1：来源、保真、DOM 已报告、绘制上限、锚点及回归通过；时间预算、完整帧/堆、重复停顿、原生矩阵、输入/导航与资源稳定性仍开放。goal 保持 active。

下一步先恢复可用的原生捕获/操作路径，再验证成功动作后启动录制；稳定环境下复核五进程冷展开，继续 P02 完整矩阵、P03 至少 20 次真实反馈及前后台/新话题、P04 阅读/尺寸变化资源趋势。不会通过丢失复制、搜索或读屏能力换取时间预算。

# 性能录制文件头的独立核验

2026-10-29，继续核验已有 QA52 快滚录制，产品来源 `b86d61922dd8c183f9097928f43cfd0560924624`。本轮不操作窗口、不启动应用或模型任务、不产生新录制。没有新产品代码。

## 新证据

先前只用 WPR 启停回执与监督器时间确认覆盖。本轮使用本机 Windows SDK 10.0.26100.0 的结构定义，编译一个仅调用 OpenTraceW/CloseTrace 的只读元数据工具；不调用 ProcessTrace、不遍历录制事件。每个文件的进程 I/O 计数均为一次读取、4096 字节，工具低优先级运行，耗时 0.6–7.6ms。

| 文件 | 记录头的实际 UTC 区间 | EventsLost / BuffersLost | 缓冲区数 × 字节 |
| --- | --- | ---: | ---: |
| QA52 后台快滚 WPR | 14:16:31.8681153–14:18:19.3677593Z | 0 / 0 | 2904 × 1048576 |
| QA48 UIA 独立取证 | 09:43:59.4508879–09:44:29.5846775Z | 0 / 0 | 6287 × 1048576 |

QA52 实际会话长度为 **107.499644 秒**。全部原生 wheel 的 14:17:36.446–14:17:41.476Z 区间均在该记录头范围内。监督器的 14:18:53.198Z 是完成停止、合并及保存后的时间，不能当作事件实际停止时间。原始 WPR 回执保持不变。

QA48 记录头覆盖已经读回的全部 486903 条目标请求事件。此前 EventLogReader 未提供首个头事件的可解码结构，曾把丢失计数记为未核实；本轮直接使用 SDK 原生结构补齐了文件头计数，不从先前的空结果推导 0。

## 工具与独立对照

另读两份早先已由 tracerpt 完整处理的历史/全文 ETL，得到 1418 和 1777 个缓冲区、EventsLost/BuffersLost 均为 0；缓冲区合计 3195，与原 `wpr-report.xml` 一致。四份记录的缓冲区数乘 BufferSize 均与实际文件字节数一致。时间以 64 位 FILETIME 字符串保存，再用 BigInt 转换，避免 JavaScript 数值精度损失。

原生工具以本机 SDK 编译，避免手写 P/Invoke 的结构偏移。首次编译缺少宽字符标准头而失败，补齐后 `/W4 /WX` 编译通过，两个日志均保留。TypeScript 负责路径边界、字段、时间覆盖和校验记录，QA strict noEmit 检查通过。

文件位于 `E:/viva/qa-20261029-performance`：`native/etl-header.cpp` / `etl-header.exe`、逐文件头部 JSON、`record-etl-header-checkpoint.ts`，以及包含工具哈希、原始字段、对照与限制的 `desktop/qa52-rich-etl-header-summary.json`。

Microsoft 的 [OpenTraceW](https://learn.microsoft.com/en-us/windows/win32/api/evntrace/nf-evntrace-opentracew) 和 [EVENT_TRACE_LOGFILEW](https://learn.microsoft.com/en-us/windows/win32/api/evntrace/ns-evntrace-event_trace_logfilew) 文档说明打开成功会填充来源信息。本工具使用其中的 LogfileHeader；外层 EVENT_TRACE_LOGFILE.EventsLost 被标为未使用，未取它作为计数。[TRACE_LOGFILE_HEADER](https://learn.microsoft.com/en-us/windows/win32/api/evntrace/ns-evntrace-trace_logfile_header) 定义了会话记录的 EventsLost/BuffersLost 和起止时间。

## 验收范围

上述 0 是已保存会话记录头的申报计数。对 WPR 合并后的 ETL，它不独立证明每个上游 logger 都无丢失，不证明全部 CPU/GPU/调用来源事件都已覆盖。尚未逐事件处理、解析栈或符号，不能把记录头有效当作完成根因分析。

[离线输入分析](qa-rich-input-analysis-20261029.md) 中的残余 91.4/110ms 停顿继续保留。当前仍需定位 QA52 浏览器长消息调用来源，并完成新来源的 200KB 重复展开、原生窗口矩阵、P03/P04 与实际安装回归。总评估仍 FAIL，goal 保持 active；用户游戏期间不执行前台实测。封存 stash 未应用，没有推送、合并或发布。

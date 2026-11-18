# 日志 L2 实施记录（2026-11-18）

工作区为 `/private/tmp/viva-local-diagnostics`，分支为 `codex/local-diagnostics`。原工作区 `/Users/victorlin/code/viva-main`、另一个 agent 的测试工程和 ReMe 对照分支未修改。本文是实施记录，不代替发布验收。

## 实现范围

| 主线 | 记录与关联 | 边界 |
| --- | --- | --- |
| 主对话与插话 | 准备、上下文完成、发送、一次首响应、取消及真实迟到结算；会话与请求身份 | 强制结束 UI 不等于原生 prompt 已结算；没有逐 token 事件 |
| SessionTiming | 在原生异步操作开始前记录 span，与已有测量入口共用阶段 | 自定义测量回调失败不覆盖原业务结果或异常 |
| 后台任务与路由 | 开始、等待、恢复、结束、任务 run、决策及 action 回执 | 状态日志在事务提交后发布；计划和任务正文不入日志 |
| 定时任务与报告 | 到期领取、派发、等待、提交、重试、持久化 generation、报告读回执 | 重试/读回执保存失败不报已完成；报告秘密令牌不入日志 |
| daily 与写入 | 摄取数量、日期归属、待处理数、计算、检查点、管理编辑、撤销和幂等 | 只保留不透明身份和计数，无笔记正文或模型输出副本 |
| 遗忘与清理 | 排空、业务提交、host ACK、真实副本清理完成 | 原始 ACK 与清理完成分开，未完成状态不提前释放屏障 |
| 检索与索引 | 全文/向量/融合/关系数量，节点检索、读取、重建与模型加载 | 词、正文、路径均不记录；失败仍按原规则回退 |
| 基础设施 | HTTP/SSE 连接及终态、SQLite 事务与真实 busy、Worker 阶段、MCP、窗口及岛生命周期 | 诊断消息不参与业务 ready/向量身份验证，不记录拖拽逐帧 |

Core 使用可移植、非抛出的诊断端口及观察函数，不引入 Node、Electron、DSH 或 Pino。Node 适配负责 ALS、存储和进程。日志基础设施不反向依赖业务模块，独立插件使用相同端口。

## 本轮复现与修复

1. daily 无条件 `mutate(notes.recover)` 与此前 dream 的问题相同。新增 timeout、非法输出、模型不可用三种回归，旧代码均失败于前台许可被 abort。现在只有 `needsRecovery()` 为真才进入恢复屏障。连续重试和 runner 重启保留同一待办；真实 prepared journal 恢复、普通更新和空重建删除仍等待实际 transport settlement。证据为 `/private/tmp/viva-l2-daily-before.log` 与后续通过记录。
2. 开始给 owner 加异步观察时，额外 Promise adoption 改变了原生副本回执的微任务顺序。已改为诊断关闭时直接返回原 Promise，owner 的未观察 host 方法也保留原跳数。没有通过放宽清理断言处理。
3. effect 重试事件原来在持久化前发出，数据库拒绝或旧 generation 会误报“已安排”。现在在实际更新提交且 `changes` 非零后记录；daily runner 只记录本次返回 retry，由队列负责实际重试回执。真实数据库与 generation 替换回归均通过。
4. Worker 诊断 reply 使用独立版本、阶段白名单及每请求去重上限。无效诊断不使有效模型结果失效，不改变 ready/fingerprint/dimensions 的业务校验。Worker 原文与非法诊断秘密哨兵不出现在事件中。

## 验证进展

- 最终 `npm test`：2198 项，2196 通过、2 跳过、0 失败，158.0 秒，记录为 `/private/tmp/viva-l2-verified-tests.log`。第一轮为 2197 项、零失败，随后新增 effect 持久化语义回归并重新执行全量。
- 当前定向回归：111 项全部通过，覆盖 dream/daily 重试、真实恢复屏障、effect、任务事务和定时任务；另外 owner、检索、Worker、主对话、报告、HTTP/SSE 等定向集均通过。
- `npm run typecheck` 与 `npm run check:i18n` 通过。`npm run smoke` 先重新构建，再完成全部 15 项 macOS 桌面冒烟（4.7 分钟），记录为 `/private/tmp/viva-l2-smoke.log`。
- 独立插件打包测试 4/4 通过；`npm run smoke:memory-plugin` 验证普通 Node、独立安装、写入/检索/摄取/注入/遗忘、重启、dream 四阶段和 DSH Web 澄清，47 个本地 mock 模型请求，页面错误为空。记录为 `/private/tmp/viva-l2-plugin-package.log` 与 `/private/tmp/viva-l2-plugin-web.log`。
- `node scripts/smoke-memory-availability.ts` 暂停真实 owner：两次读取约 10005.6ms / 10004.3ms 超时，第三次约 2.7ms 返回 busy；恢复实际进程后原执行结算，新请求与页面手动重试成功，草稿和附件保留。记录为 `/private/tmp/viva-l2-availability.log`。
- 一次定向测试在受限环境因 `listen EPERM 127.0.0.1` 失败；允许测试自己的 loopback 后全部通过，未修改业务或测试断言。

## 未完成验收

L1 性能门槛仍为主流程 P95 增幅不超过 5% 且增加不超过 10ms；上一阶段的对照未达标，不能据本轮功能测试标记通过。Windows 原生故障、安装包、构建提交注入及设置页诊断入口仍待 L3。macOS 本地结果不代表 Windows 实测。

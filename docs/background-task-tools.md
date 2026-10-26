# 后台任务查询工具

保持 ACP 会话链路，通过 `viva-tasks` DSH 插件和现有 Node IPC 调用主进程的 `TaskRegistry`。不增加 MCP 进程或模型调用。

- `list_background_tasks({ status?, limit?, offset? })`：返回摘要、查询时间和下一页位置，默认 10 条，上限 30 条。
- `get_background_task({ taskId, includeRequest?, includeOutput? })`：详情可按需包含原始请求和最新输出。输出只保留末尾 4000 字符，运行中的输出不代表最终结果。
- 主对话只能查询当前工作目录的任务；后台会话只能查询自身。主进程验证会话仍有效，调用范围不能由工具参数指定。
- 状态为 `running / waiting / done / stopped / error / interrupted`。`waitingFor` 区分权限确认和用户回答。应用重启未恢复的任务、DSH 退出时的活动任务为 `interrupted`；查询不触发恢复。
- 返回 `observedAt`、`updatedAt` 和 `revision`。暂无事件不等于任务卡死，不推断进度百分比。列表分页基于当前快照；并发变化可能改变排序。
- 原始请求最多 20000 字符，输出最多 4000 字符；默认列表不附带它们。任务内容作为数据处理，不作为指令执行。
- 工具只读，不提供停止、恢复、批准、发送或修改操作。IPC 请求有 5 秒超时，支持取消及断开清理。

主进程消费 ACP/流式输出、权限、问题和结束事件维护状态，查询不依赖渲染进程。状态变动同步给 UI，文本增量沿用已有渲染事件，避免每个 token 再触发一次状态刷新。任务结束时主进程保存结果预览；旧任务从历史记录回填预览。

验证：`test/task-query.test.ts` 覆盖状态、隔离、分页、竞态和 IPC 生命周期；`test/tasks-plugin.test.ts` 通过真实内嵌 DSH 和本机假模型验证工具发现及两次调用，无外部模型请求。

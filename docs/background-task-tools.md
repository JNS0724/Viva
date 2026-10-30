# Background task query tools

[English](background-task-tools.md) · [简体中文](background-task-tools.zh-CN.md)

The ACP session remains intact. The `viva-tasks` dsh plugin uses existing Node IPC to query the main process’s `TaskRegistry`, without adding an MCP process or model call.

- `list_background_tasks({ status?, limit?, offset? })` returns summaries, observation time, and next-page offset. Default limit: 10; maximum: 30.
- `get_background_task({ taskId, includeRequest?, includeOutput? })` optionally includes the original request and latest output. Output is limited to its final 4,000 characters; running output is not a final result.
- The main conversation queries tasks in its current working directory. A background session queries only itself. The main process validates session liveness; tool arguments cannot choose scope.
- States are `running / waiting / done / stopped / error / interrupted`. `waitingFor` distinguishes approval from an answer. Unresumed tasks after restart, and active tasks when dsh exits, become `interrupted`. Queries do not resume them.
- Results include `observedAt`, `updatedAt`, and `revision`. No new event does not mean a task is stuck; no percentage is inferred. Pagination uses the current snapshot; concurrent changes can reorder results.
- Requests are limited to 20,000 characters and output to 4,000. Neither appears in lists by default. Task content is data, not instructions.
- Tools are read-only: no stop, resume, approve, send, or modify operations. IPC has a five-second timeout and supports cancellation and disconnect cleanup.

The main process consumes ACP/streaming output, permission, question, and completion events to maintain state. Queries do not depend on the renderer. State changes reach the UI; text deltas reuse existing rendering events, avoiding a second state refresh for every token. Completion saves an output preview; older tasks recover previews from history.

Verification: `test/task-query.test.ts` covers states, isolation, pagination, races, and IPC lifecycle. `test/tasks-plugin.test.ts` verifies discovery and both calls using real embedded dsh and a local fake model, with no external model request.

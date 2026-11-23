# 记忆 owner 隔离

[English](memory-owner-isolation.md)

Viva 和独立 DSH 都在受监管的 worker 中运行记忆。worker 独占 SQLite、受管 Markdown 文件和搜索索引。Viva 在自己的数据库中保存聊天、后台任务、汇报和定时安排。记忆连接中或不可用时，对话和任务仍可启动。[Owner worker](../src/memory/node/owner-worker.ts) · [Viva 后端](../src/backend/compose.ts)

## 摄取与检索

适配器从已保存的游标扫描持久化会话事件。新库以库创建时间为起点。worker 记录回合结果时推进游标，扫描中断重试通过原消息 ID 复用来源。Viva 为能够核实的真人原话注册映射，由映射指出原话在发给 DSH 的文字中的位置。没有可信映射时对话仍可继续，该消息不作为原话证据。独立 DSH 的纯文本用户消息可直接摄取。工具结果、自动注入、无人值守输入和后台汇报均不属于原话证据。[适配器](../plugins/memory/lib/adapter.ts) · [会话摄取](../plugins/memory/lib/ingestion.ts)

已核实的项目会话读取个人和项目记忆，写入项目记忆。个人会话读写个人记忆。工作区身份未知时可以查询个人记忆，摄取跳过该会话的消息。自动注入有短时预算，并排除当前会话自己生成的日记。显式工具使用独立预算，owner 无法响应时返回记忆不可用。[项目身份](../src/memory/node/project-scope.ts) · [文件读取规则](../src/memory/core/memory-document-read-policy.ts)

## 文件操作

日记与摘要都用整篇文件的启用开关和使用版本。停用后文件退出模型检索与 Dream，仍可在「关于你」查看内容。Dream 提交时校验内容与使用版本，停用后再启用也会让此前计算的结果作废。删除记忆文件会移除该文件及其索引。删聊天和回退编辑只修改本地历史。[日记存储](../src/memory/node/memory-note-store.ts) · [Dream 作业](../src/memory/core/memory-dream-jobs.ts) · [时间线回退](../src/backend/rewind-ipc.ts)

## 存储与重连

监管进程在旧 worker 退出后启动替代进程。新进程持独占锁打开记忆目录，并恢复已经提交的状态。管理页直接查询 owner，请求有并发上限。DSH 继续负责自己的会话持久化。[监管进程](../src/memory/node/owner-supervisor.ts) · [根目录锁](../src/memory/node/owner-lock.ts) · [管理通道](../src/backend/remote-memory-channel.ts)

记忆契约和数据库版本为 v12。空目录会创建新库。不兼容的库保留在磁盘上，记忆进入不可用状态。Viva 用户切换到全新 v12 时自行清理旧数据目录。独立 DSH 已有的文件保留在它自己的数据目录中。[数据库版本检查](../src/memory/node/memory-store.ts)

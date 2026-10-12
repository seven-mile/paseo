# Daemon / Paseo MCP 原语冷审

审计范围：`plugins/paseo-swarm/shared/swarm.ts`、`plugins/paseo-swarm/server/operations.ts`、`packages/server/src/server/agent/tools/paseo-tools.ts`、`packages/server/src/server/session.ts`、`packages/server/src/server/authorization/operation-permissions.ts`，并对照 `reports/swarm-orchestration-survey.md`。以下区分 MCP 工具层与 plugin RPC handler 层；两层的权限和返回范围不同。

## 身份和入口总览

1. Agent 的 MCP 会话在 `bootstrap.ts:1438-1450` 以 `runtime.callerAgentId` 创建 Paseo tool catalog。`paseo-tools.ts:647-664` 先调用 `swarm.board.read`，按 `callerAgentId` 找未退休 Agent；找不到时不注册任何 `swarm_*` 工具。对已注册 caller，`readSwarm()` 再次校验 caller，并把其 `qualifiedName` 注入后续 plugin 输入的 `actorName`（`paseo-tools.ts:669-680`）。这是 MCP agent 的实际身份链。
2. 原生 WebSocket 的 `plugin.rpc.invoke.request` 在 `session.ts:2452-2463` 直接调用 `pluginRuntime.invokePluginRpc(pluginId, method, input)`，没有向 handler 传入 session principal 或 caller agent。该 WebSocket 操作的通用权限是 `daemon.manage`（`authorization/operation-permissions.ts:127-138`）；因此 board/Task/Activity/message 等 plugin RPC 不是 `workspace.read/write` 级别的语义授权。handler 自己只看输入字段。
3. 所以“未注册 agent 无 Swarm MCP tools”事实成立，但不能推导为“直接 RPC 也有相同身份校验”。直接 RPC 调用者可在可用的 `daemon.manage` 会话里伪造 `actorName`、`createdBy` 或其他名称字段。

## 逐个原语

### board

- 合约是 `swarm.board.read({projectId?}) -> {version:1, agents, tasks, activities, statuses?}`（`shared/swarm.ts:12-24`）。handler 为 `operations.ts:282-304`：读取持久化 `store.read()`，调用 daemon `agents.list(includeArchived:false)`，只按当前仍存在的 `paseoAgentId` 过滤 Agent；不按调用者层级过滤，也不裁剪 Tasks/Activities。
- MCP 的 `swarm_board_read`（`paseo-tools.ts:687-701`）才调用 `summarizeSwarmBoard(board, actor, input)` 做 team/workset 层级、分页和 status 过滤，返回摘要。`swarm_task_read`/`swarm_activity_read` 也只是拿同一份 board 后在工具层筛选（`paseo-tools.ts:714-753`）。
- 因此原报告第 1 条“已有 board roster、MCP 按层级过滤”只适用于 agent MCP 工具；底层 board RPC 是全量快照，且直接 RPC 的输出包含 Activity 全文。原报告遗漏了这个数据暴露边界和 `daemon.manage` 而非 `workspace.read` 的权限分类。
- `projectId` 只验证项目存在并读取 PWA statuses；普通无项目读取不会验证 PWA source。返回 `statuses: []` 表示 project 有效但无 source（`operations.ts:292-303`）。

### agent（register/create/prepare/bind）

- `swarm.agent.register` 合约输入包含 `paseoAgentId,name,roleClass,role,reportsTo,workspaceId`，输出 `AgentRecord`（`shared/swarm.ts:53-71`）。handler `operations.ts:313-372` 用 `paseo.agents.ref(...).refresh()` 验证 Paseo agent 和 workspace，校验 PWA roleClass；同一 Paseo ID 已有记录时 name/roleClass/role/qualifiedName/hierarchy 不可变，随后会把 `retired` 重置为 `false`（`operations.ts:335-369`）。没有 actor/调用者权限字段。
- `swarm.agent.create`/`prepare` 通过 `actorPaseoAgentId` 找记录。`assertCanCreateAgent` 限制 planner 只能 supervisor、supervisor 只能 worker、worker 禁止创建（`operations.ts:176-213`）；`assertCreationWorkspace` 限制 caller 自己及直接 roster workspace（`operations.ts:215-245`）。但 `actorPaseoAgentId:null` 是合法输入，表示无 actor；直接 RPC 可绕过 Swarm agent 身份，创建任意层级 Agent。MCP 工具层才强制 `callerAgentId` 非空并按 caller role 选 roleClass（`paseo-tools.ts:791-804`）。
- `prepare` 先持久化一个 `workspaceId:null` 的 AgentRecord，`bind_workspace` 只按 `agentId`、workspace 快照和项目/PWA 约束绑定（`operations.ts:464-523`），没有独立调用者授权。
- 原报告第 6 条关于 provider harness 子 agent 不进入 roster基本正确，但遗漏：原生 RPC 的 `register/create/prepare/bind` 没有 principal 绑定，授权依赖输入字段和 `daemon.manage` 入口。

### task

- `swarm.task.create` 输入显式 `managerName`、`createdBy`，输出完整 `Task`（`shared/swarm.ts:101-123`）。handler `operations.ts:526-555` 用 `findAgent(input.createdBy)` 找 actor；worker 禁止创建，非 planner 只能为自己创建，workerNames 必须是 manager 的 worker。写入时规范化 `managerName/workerNames/createdBy` 为 qualified names。
- `swarm.task.update` 输入 `actorName`，输出完整更新后的 Task（`shared/swarm.ts:125-141`）。handler `operations.ts:558-587` 禁止 worker；planner 或当前 manager/createdBy 可更新 status/title/brief/workerNames/data。`workerNames` 替换整个参与者列表并重新做 role 校验。
- 这些检查对 MCP agent 调用有效，因为 `invokeSwarm` 覆盖了输入 actorName（`paseo-tools.ts:678-680`），但对直接 RPC 可由调用者自填 `createdBy`/`actorName` 冒充任意 active Agent。原报告第 3 条关于“manager ownership、worker 无 update/activity”事实成立，证据只覆盖工具路径，未说明底层 RPC 的可伪造身份边界。
- Task status 是任意非空字符串；PWA 的 status 列表仅由 UI/项目读取，handler 不验证 status 属于 PWA（`PWA.md` 声明 statuses；`operations.ts:558-587` 无状态枚举检查）。这支持原报告“runtime notification 不改变 Task status”，但也意味着任何有 Task 写权的 actor 可写非法状态。

### activity

- `swarm.activity.append` 输入 `taskId,actorName,kind,body,...`，输出完整 `Activity`（`shared/swarm.ts:143-168`）。handler `operations.ts:589-605` 查 Task、查 actor；worker 永远禁止，非 planner 必须是 Task manager；Activity 由 `makeActivity` 生成 id、时间和 `resolveActivityRefs` 引用。
- `swarm.activity.append_human` 是单独 handler（`operations.ts:607-642`），输入默认 `actorName:"human"`，不做 human principal 校验；写入后向 Task manager `send(...,{activeTurnBehavior:"steer"})`。写入成功而通知失败时返回 Activity 加 `notificationWarning`，不会回滚（`operations.ts:616-641`）。
- 原报告第 5 条关于只有 manager/planner 写 agent Activity、需要粒度提示成立；遗漏了 human 原语是任意 caller 可写、并且返回成功可带通知警告的部分，也遗漏 `append` 的身份来自可伪造输入。

### message

- `swarm.message.send` 输入 `recipientPaseoAgentId,recipientName,senderName,actorName?,taskId?`，输出 `{delivered:true,receipt}`（`shared/swarm.ts:171-184`）。handler `operations.ts:645-683` 只检查 actorName（若提供）等于 senderName；Task-scoped 时要求 actor 存在，允许 planner、Task manager 或 Task worker 给 Task manager/worker 发消息；随后按**输入的 Paseo ID**发送，并用 receipt 表示 Paseo 接受投递。
- MCP `swarm_message_send` 会从 board 解析 recipient 名称到 Paseo ID，并把 caller qualified name 同时作为 sender/actor（`paseo-tools.ts:875-918`）。这使工具路径的名称解析合理。
- handler 没有验证 `recipientPaseoAgentId` 对应的已注册 Agent 的 `recipientName`，也没有检查该 ID 是否 retired/仍属于该 Task；直接 RPC 可用合法 Task actor 身份搭配任意 Paseo ID，向不匹配的 Agent 发信。无 taskId 的消息甚至允许 `actorName:null` 和任意 senderName。原报告第 7、8 条关于 steer 通知和 receipt 非 durable 的描述成立，但遗漏了 recipient binding 和无 Task 消息的身份边界。

### notification

- 插件事件入口是 `index.server.ts:5-20` 的 `agent.turn_ended`。它只处理 outcome `completed|canceled|failed`，从末尾 assistant_message 拼接 report，再调用 `notifyManager`。
- `notifyManager`（`operations.ts:715-735`）按事件 Agent 的 Paseo ID 查已注册记录和 `reportsTo`，用 `findAgent` 找 manager，然后向 manager Paseo ID `send(runtimeNotification(...), {activeTurnBehavior:"steer"})`。没有 Activity 写入，也没有 Task status 更新。manager 不存在/无 reportsTo 时静默返回。
- `runtimeNotification` 对 completed/canceled/failed 明确声明运行结果不等于业务 Task 结果，并要求 manager 决策（`prompts.ts:116-145`）；idle/inactive 文本也存在（`prompts.ts:123-130`），但 `notifyManager` 的类型和 `agent.turn_ended` 分支不会发送 idle/inactive。这一点需要与原报告第 2、7 条区分：完成/取消/失败自动通知证据明确；idle 通知来自其他 daemon finish-notification 路径时不能归因于此插件 handler，且该路径需要单独覆盖测试。
- 通知没有可重试队列或 durable receipt；`send` 成功只代表 Paseo 接受当前 steer。发送失败向事件 hook 抛错，插件没有将通知失败持久化。

## 对原报告八条结论的修正

1. **Roster 原语**：MCP 视图已有 `swarm_board_read`，但底层 `swarm.board.read` 返回全量状态；“已有 roster”不能等同于所有调用者都受层级裁剪。
2. **自动通知**：完成/取消/失败由 `agent.turn_ended -> notifyManager -> agents.ref.send(steer)` 覆盖；idle 文本存在但插件 handler 不触发 idle。无需轮询的 prompt 结论只对接收到通知的 manager 成立。
3. **Task ownership**：MCP 会覆盖 actorName，manager/planner/worker规则有效；直接 plugin RPC 以 `createdBy`/`actorName` 为身份，daemon.manage caller 可冒充记录中的 actor。
4. **Roster retirement**：确实没有 retire RPC。`findAgent` 和 board 对 `retired` 有过滤，但 `registerAgent` 可对同一 Paseo ID 再注册并将 retired 重置为 false（`operations.ts:335-369`），所以“退休后永久拒绝/重新启用”尚未定义。
5. **Activity 粒度**：agent append 权限为 manager/planner；human append 单独绕过 actor 校验并可能返回 `notificationWarning`。粒度仍由 prompt 约束。
6. **Harness 子 agent**：MCP 无 caller 时不注册 Swarm tools；但 direct register/create/prepare 没有 principal，不能把该结论扩展到原生 plugin RPC。
7. **Idle 自恢复**：`runtimeNotification` 要 manager 后续决策，插件不自动续跑 worker；`send` 的 steer 可唤醒。但 idle 不是本插件 `turn_ended` 通知的 outcome。
8. **sleep 阻塞**：通知发送不依赖 manager 轮询或 sleep；receipt 仅接受投递。该结论是运行行为提示，不是 daemon 原语保证。

## 审计结论与建议验证

- 重点风险是权限层次错位：通用 `plugin.rpc.invoke.request` 只要求 `daemon.manage`，而 plugin handler 不知道 session principal；MCP agent tool 依赖 callerAgentId 的身份注入不能保护直接 RPC。
- 消息接收者应在 handler 中把 `recipientPaseoAgentId` 解析为当前 active Agent，并要求其 qualified name 等于 `recipientName`，Task-scoped 时还应验证 recipient 属于 manager/worker 集合。
- 任何需要“调用者身份”的 RPC 应从受信任调用上下文取得 actor，而不是把 `actorName`/`createdBy` 当作认证字段；至少应为 direct plugin RPC 明确权限契约和审计测试。
- 建议针对以下证据补测试：直接 `plugin.rpc.invoke` 伪造 actor；board 全量返回与 MCP 摘要差异；message 名称/ID 不匹配；retired ID 经 register 重新启用；completed 与 idle 通知触发矩阵；human Activity 通知失败时的返回值。

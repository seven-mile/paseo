# Swarm 后端编排故障调查与改进提案

调查范围：本 checkout 的 daemon、`paseo-swarm` plugin、Swarm MCP 工具和 prompt 组装。结论只基于静态代码与现有设计文档；没有启动 daemon、创建运行 agent 或拆 worker。

## 先给结论

当前实现已经有 roster、层级过滤、Task/Activity 权限、Paseo agent 创建、运行通知和 manager 唤醒；八类问题混合了旧认知、调用顺序错误、职责 prompt 不足和确实缺少的 roster 变更原语。最小修复优先级是：补强可见 roster 的工具输出与 prompt 规则、把“先由 manager 创建 Task”写成强制流程、给 Activity 粒度和 idle 后协调写入 role-class system settings；只有 roster 生命周期（退休/撤销）才需要新增 daemon/PWA 原语。

## 逐问题事实链路

### 1. “后端没有列 roster 方法，lead 只能 list agents”

事实：`plugins/paseo-swarm/shared/swarm.ts` 定义 `swarm.board.read`，返回持久化 agents/tasks/activities；`packages/server/src/server/agent/tools/paseo-tools.ts` 注册 `swarm_board_read`，调用 plugin 后由 `summarizeSwarmBoard`（`tools/swarm-context.ts`）按当前 agent 的层级筛选并分页，输出 `name/qualifiedName/roleClass/role/reportsTo/workspaceId`。因此“没有 roster 原语”不成立；真实问题是工具只给团队视图且要求调用者已是注册 Swarm agent，未注册 agent 被明确不给 Swarm tools（`paseo-tools.ts:666-675`）。若 lead 使用普通 `agents.list`，拿到的是 Paseo 运行 agent 总表，不是 Swarm roster。

根因分类：已有能力但 agent 不知道/工具语义容易误导；当前证据不足以证明 daemon 缺能力。最小改动：在 planner/supervisor prompt 明确先调用 `swarm_board_read`，说明它是 roster 入口、分页游标含义和 `qualifiedName` 的引用规则；若确需项目全量 roster，再新增 `swarm_roster_read` 只作为 board 的显式全量视图。

### 2. “lead 轮询组员，不知道会自动通知”

事实：`plugins/paseo-swarm/server/operations.ts:notifyManager` 在下属运行结果为 completed/canceled/failed 时，通过 `context.paseo.agents.ref(manager).send(runtimeNotification(...), {activeTurnBehavior:"steer"})` 发送 manager 通知；`runtimeNotification` 明确声明这是框架 roster notification，不是 Activity。空闲通知也由同一 prompt 说明 idle 仅表示没有 turn，manager 必须评估下一步。另有 `setupFinishNotification`（`agent-prompt.ts:433-580`）监听 child 的 running→idle/error/closed，并 steer caller。

根因：已有自动通知，但职责 prompt 没把“不要轮询、收到通知后读证据并协调”写成 manager 的首要动作；轮询是 agent 行为错误。最小改动：在 supervisor/planner system settings 加入通知已自动发送、无需 `agents.list` 轮询、收到通知后读取 board/task/report 再决定动作。

### 3. “lead 自己创建 Task，组员碰不了”

事实：MCP `swarm_task_create` 总是以调用者 `name` 作为 `managerName/createdBy`；plugin `createTaskRpc` 要求 actor 不是 worker，supervisor 只能为自己创建，planner 可创建项目范围 Task。`updateTaskRpc` 只允许 manager、planner 或创建者；`appendActivityRpc` 禁止 worker；worker 只能发 Task-scoped message。`swarm_agent_create` 另有 roleClass 和 `reportsTo` 约束，并将 supervisor 放独立 workspace、worker 放 supervisor workspace。

根因：Task ownership 是 manager 权限模型，lead 代替 supervisor 创建必然导致 supervisor 无写权；这是 placement/职责调用顺序错误，不是 Task API 缺失。最小改动：PWA/system settings 明确“创建 worker 后先让实际 supervisor 创建 Task，或由 planner 指定 managerName；创建后立即 `swarm_task_update(workerNames)`”；工具描述已经提示 participant list，但缺少强制工作流示例。验收：非 manager 的 update/activity 明确失败，manager 创建后成功。

### 4. “roster 创建后不能改，无法移除角色”

事实：`AgentRecord` 的 name/roleClass/role/reportsTo 在 `registerAgentRpc` 中被视为 immutable；`swarm.agent.create` 只创建；状态模型有 `retired` 字段，`boardReadRpc` 过滤实际不存在于 Paseo 的 agent，但代码中没有 `retire_agent` RPC/handler。`design/01-pwa-roster-and-context.md` 也明确 `retire_agent` 只有软删除语义且目前未实现通知、鉴权、运行中处理和重新启用。

根因：确实缺 roster 生命周期写原语。最小新增原语应是 `swarm.agent.retire({agentName, actorName, reason?}) -> AgentRecord`：调用方 planner 管项目、supervisor 管直接 worker；校验运行 agent/Task 引用策略，原子写 `retired=true`，后续 board、findAgent、消息鉴权拒绝 retired；运行中 agent 的停止/归档和 Task 重分配必须定义，不能只改 UI。验收覆盖误创建退休、退休 agent 不出现在可用 roster、旧 Task 历史仍可读、运行中处理有明确结果。重命名/改层级应另立迁移原语，不能偷偷放进 update。

### 5. “Activity 当流水账或完全不记”

事实：只有 manager/planner 能 `swarm_activity_append`；Activity 字段有 kind/body/replyTo/responseProfile/data/refs，`swarm_task_read` 默认只给 5 条预览，完整内容需 `swarm_activity_read`。权限与结构已存在，但 `roleClassGuidance` 仅说“maintain Task Activities and progress”，PWA 只规定 Activity 是 durable record，没有按事件粒度给 manager 决策规则。

根因：角色职责/prompt 粒度不足，非 daemon 缺陷。最小改动：在 supervisor guidance 注入三类粒度：阶段/决策/阻塞写 Activity；普通工具输出和每次轮询不写；正文包含证据、结论、下一步，使用 `responseProfile` 区分 decision/steering/discussion。验收用同一 Task 的多轮报告检查只产生决策级记录且可从 preview 定位详情。

### 6. “lead 用 Codex/Claude harness subagent，不是 Paseo agent”

事实：Swarm agent 创建只在 `swarm_agent_create` 中调用 `context.paseo.workspaces.create`/`workspace.agents.create` 或 `context.paseo.agents.create`，并注入 systemPrompt、PWA role、Paseo agentId 和首条 brief；注册工具还按 caller agent ID 判断是否授予 Swarm tools。普通 provider harness 的内部 subagent 没有这次 `swarm.agent.create` 注册、roster identity 或 Task 权限。

根因：agent 选择边界/prompt 教育问题；代码有意拒绝未注册 caller，不应把 harness 子 agent 猜成 Swarm 成员。最小改动：在 planner/supervisor settings 明确“需要协作成员必须调用 `swarm_agent_create`；provider-managed/harness subagent 只属于 provider，不进入 roster/Task ownership”。若产品要接管已有 Paseo agent，使用 `registerAgentRpc`/未来 bind 流程并验证 hierarchy，不新增隐式发现。

### 7. “组员 idle 已反馈，但 lead 不协调，组员不会自恢复”

事实：`runtimeNotification` 对 idle 明确写“no turn is executing… agent will do no further work unless it receives a next instruction; Manager must evaluate next step”；非 idle 结束通知同样要求 manager 决策。`sendMessageRpc` 使用 Paseo `agents.ref(...).send(..., activeTurnBehavior:"steer")`，消息可唤醒 manager；没有任何代码让 worker 自主恢复。supervisor system settings 只说“continue workflow”，没有把 idle→读报告→发下一条 assignment 写成动作链。

根因：职责 prompt/协调动作缺失，现有通知链路正常。最小改动：补 manager guidance：收到 idle/runtime notification 后读取 Task/Activity/最终响应，决定追加 message、更新 Task、退休/升级或结束；worker guidance 明确等待下一条指令。验收：模拟 worker idle 后 manager 未发送新 message 时不应期待自动继续；发送 `swarm_message_send` 后新 turn 被 steer。

### 8. “lead 用 sleep 阻塞通知”

事实：通知发送路径是 Paseo `agents.ref(...).send` 的 steer 调用，不依赖 lead 自己轮询；manager 的 agent runtime 只有在可执行 turn 中才能处理新 prompt。仓库中与该调查相关的 system settings 没有任何“sleep 等待通知”建议；`runtimeNotification` 反而要求 manager 持续决策。长时间在 harness 内调用 sleep 会让当前 turn 不读取新输入，这是 agent 行为/提示误用，不是新增 JS promise、event bus 或 sleep API 的证据。

根因：prompt 没有禁止阻塞式等待并教会“让当前 turn 结束/处理通知”，加上 agent 对自动通知机制的误解。最小改动：在 manager guidance 写明不要用 sleep/轮询等待组员；通知会以新输入 steer/wake manager，收到后立即处理。验收：worker 很快结束时 manager 不应因人为 sleep 120 延迟协调；日志应能看到 runtime notification 到达后 manager 的下一次动作。

## 改进分层与验收

只需 prompt/context：问题 1、2、3 的调用顺序、5 的 Activity 粒度、6 的 Paseo/harness 边界、7、8 的通知与协调动作。修改 `plugins/paseo-swarm/server/prompts.ts` 的 role-class system settings，并在 PWA role guidance 写可执行动作链；不添加虚构的订阅、恢复游标或独立控制通道。

需要 daemon/PWA 原语：问题 4 的 `retire_agent`（以及若需要的显式 rename/reparent migration）。原语必须定义调用方、输入输出、权限、运行中 agent、Task 引用、通知和重新启用生命周期；在这些未定义前不应声称“支持移除”。可选的全量 `swarm_roster_read` 只在现有层级裁剪不足以满足产品需求时新增。

建议验收矩阵：未注册 Paseo agent 无 Swarm tools；`swarm_board_read` 返回真实 qualified names/层级和分页；supervisor 创建 Task 后 worker 可 message 但不能 update/activity；manager 创建 Task 的越权调用失败；runtime completed/idle 自动发送 manager prompt 且 manager 可 steer；Activity 只由 manager/planner 写入并可读详情；harness 子 agent 不出现在 roster；退休后 agent 被鉴权拒绝且历史可审计。

## 未决问题

1. `notifyManager` 的 completed/canceled/failed 触发点及 idle 触发点是否覆盖所有 provider/daemon 退出路径，需要运行级测试确认。
2. retire 期间若 agent 有 running turn、Task manager 或 worker 引用，产品要选择停止、转移还是拒绝；代码目前没有约定。
3. 项目是否真正需要跨 supervisor 的全量 roster；若需要，应定义 planner-only 权限和分页契约，而不是放宽现有团队视图。

## 冷审复核与结论修订

两名独立 researcher 完成了互相质疑：[daemon/Paseo 原语冷审](worker-daemon.md)、[prompt/PWA 冷审](worker-prompt.md)、[prompt 对 daemon 的反审](worker-prompt-critique.md) 和 [daemon 对 prompt 的反审](worker-daemon-critique.md)。交叉审查改变了以下结论：

1. “已有 roster 与权限”必须限定为 MCP tool 路径。`swarm_board_read` 才做层级裁剪和分页；底层 `swarm.board.read` 经 `daemon.manage` 可返回全量 agents/tasks/activities。`plugin.rpc.invoke.request` 没有把 session principal 传给 handler，handler 依赖输入的 `actorName/createdBy`；这构成静态身份伪造风险，但尚未证明某部署存在可被不可信主体利用的远程越权。
2. “自动通知”只能写成 `agent.turn_ended` 对 `completed/canceled/failed` 的明确路径：`index.server.ts -> notifyManager -> agents.ref.send(..., steer)`。`runtimeNotification` 中的 idle/inactive 文本不证明插件会为 idle 发送通知；`setupFinishNotification` 是另一条 daemon 路径，provider 覆盖仍需运行测试。
3. Task/Activity 的 manager/worker 业务权限仍成立，但仅在 MCP caller 注入可信 actor 的调用路径成立。直接 RPC 的 principal、`recipientPaseoAgentId` 与 `recipientName`、active roster 和 Task membership 尚未绑定。message handler 也允许无 Task 消息使用任意 senderName；这是权限审计候选，不可用 prompt 修复。
4. Activity 结论增加 human 路径：`swarm.activity.append_human` 不校验 human principal，通知 manager 失败仍返回 Activity 与 `notificationWarning`。这不是普通 agent Activity 粒度问题，应单独测试。
5. `retired` 只是过滤字段而非完整生命周期；同一 Paseo ID 的 `register` 可将 retired 重置为 false。运行中 agent、Task 引用、历史可读性和重新启用语义仍未定义，不能把“过滤 retired”描述成永久拒绝。

交叉审查保留的主结论是：问题 1、2、3、5、6、7、8 仍需要 prompt/context 与调用顺序改进，但 direct RPC principal、recipient 绑定和通知失败矩阵是 daemon/PWA 测试与权限设计问题；问题 4 仍需要显式 roster lifecycle 原语。下一轮验收应先覆盖 direct RPC 身份、board 全量与 MCP 摘要差异、recipient 绑定、human Activity 失败返回、completed 与 idle 通知矩阵，再改 manager prompt。所有“可伪造”表述保持静态风险级别。

# Prompt / PWA / Runtime 冷审

审查范围：`plugins/paseo-swarm/server/prompts.ts`、PWA 读取与 agent 创建、runtime
notification、团队消息投递，以及它们在 daemon 中的接收路径。证据来自静态代码、测试和
现有 PWA 设计文档；没有把模型实际回复当作代码事实。每一项都区分代码已经保证的能力、
只能靠 prompt 改善的行为，以及当前证据不足之处。

## 总结

`roleClassSystemSettings()` 和 `initialPrompt()` 生成的是模型上下文，不是权限层。真正的
创建、Task/Activity 修改和 Task 消息范围由 `operations.ts` 的 handler 鉴权；消息和 runtime
通知都通过 Paseo `agent.ref(...).send(..., { activeTurnBehavior: "steer" })` 投递。因而
“模型没有按流程做”“lead 轮询/睡眠”“Activity 粒度错误”等只能先归因于 prompt、上下文
和 agent 行为，不能据此声称 daemon 缺少能力。反过来，roster 退休/重命名等没有 handler，
不是提示词可以补上的能力。

## 八个问题

### 1. lead 是否没有 roster 读取方法

**代码事实。** `swarm.board.read` 在 `plugins/paseo-swarm/shared/swarm.ts` 定义；
`registerOperations()` 的 `boardReadRpc`（`server/operations.ts`）读取 plugin state，
`paseo-tools.ts` 的 `swarm_board_read` 再以当前 Paseo agent 身份调用并由
`summarizeSwarmBoard` 按层级裁剪。返回数据源是持久化 `agents/tasks/activities`，而不是
Paseo 的普通 `agents.list` 总表。未注册 agent 不会获得 Swarm 工具。

**冷审结论。** “没有 roster 原语”与代码不符；“lead 不知道应调用哪个工具”属于 prompt
和工具描述不足。当前 prompt 没有在 planner/supervisor 的首要动作中明确先读
`swarm_board_read`、使用 `qualifiedName` 和处理分页。若需要跨 supervisor 的全量 roster，
现有层级裁剪并不能证明已有该能力，需另定义原语和权限。

### 2. lead 是否必须轮询组员状态

**代码事实。** `index.server.ts` 监听 `agent.turn_ended`，组装最后连续的
`assistant_message` 作为 `report`，调用 `notifyManager()`。后者在
`operations.ts` 通过 manager 的 Paseo ref 发送 `runtimeNotification()`，并使用 `steer`。
另有 daemon `setupFinishNotification()` 为 agent-prompt 路径监听 child 状态并唤醒 caller。

**冷审结论。** 自动通知链路存在；“lead 只会轮询”是 prompt 没有明确通知优先级、读证据
和继续协调导致的行为问题。不能由静态代码确认所有 provider 的 idle/error 退出都触发同一
插件事件；这属于未决运行级覆盖测试，不应写成“通知永远完整”。

### 3. lead 创建 Task 后 supervisor/worker 是否被锁死

**代码事实。** `createTaskRpc` 以调用者为 `createdBy`，并把 manager 解析为
`managerName`；worker 创建 Task 被拒绝，supervisor 只能为自己管理的 Task 操作。`updateTaskRpc`
只允许 manager/planner/创建者，`appendActivityRpc` 明确拒绝 worker。Task-scoped
`sendMessageRpc` 要求已认证 actor，且只允许 manager、Task worker 或 planner 按目标发送。

**冷审结论。** 这是有意的 ownership 模型和调用顺序问题：lead 代 supervisor 创建会让
supervisor 没有写权，不能归因于消息投递故障。prompt 应说明“实际 manager 创建 Task 或
planner 明确指定 manager，再登记 worker”；代码权限无需为迎合错误流程放宽。

### 4. roster 角色能否退休、重命名或改层级

**代码事实。** `AgentRecord` 保存 `retired`，查找函数会过滤 retired，但
`registerAgentRpc`/创建流程之外没有对应的 `retire_agent`、rename 或 reparent handler。
`boardReadRpc` 只过滤已不在 Paseo 的 agent；它不是 roster 生命周期 API。PWA charter 也说明
PWA 不能授予能力或覆盖 framework authorization。

**冷审结论。** 这是实际缺少的原语，不是 prompt 缺口。不能通过告诉 agent “退休某角色”来
制造权限、停止运行 turn、处理 Task 引用或保留审计。新增原语前必须定义 actor 范围、运行中
agent、Task 重分配/拒绝、历史可读性和重新启用语义。重命名与重挂载应另做迁移操作。

### 5. Activity 是否会变成流水账

**代码事实。** `appendActivityRpc` 仅允许 manager/planner，Activity 有 `kind/body/replyTo/
responseProfile/data/refs`；完整正文可由 activity read 获取，Task 预览有数量限制。代码没有
根据“每次工具调用/每次轮询”自动写 Activity，也没有决定报告粒度的状态机。

**冷审结论。** “不记 Activity”或“把所有输出都记成 Activity”只能归因于 supervisor prompt
缺少可执行粒度规则。建议在 role-class/PWA 中规定阶段、决策、阻塞才写，正文必须有证据、
结论、下一步，并用 `responseProfile` 区分决策/引导/讨论；不要把它描述成 daemon 已经有或
缺失的自动聚合能力。

### 6. provider harness subagent 是否自动属于 Swarm roster

**代码事实。** Swarm 创建路径在 `operations.ts` 调用 Paseo workspace/agent create，注入
`systemPrompt`，登记 plugin `AgentRecord`，然后发送首条 brief。工具授权依据注册的
Paseo agent ID；provider 自己创建的 harness subagent 没有该登记、层级和 capability token。

**冷审结论。** “组员没进入 roster”通常是选择了错误的 agent 创建边界，属于 prompt/使用
教育问题；不能要求代码隐式猜测 provider 子 agent 身份。若要接管已有 Paseo agent，应走
显式 register/bind 并验证 hierarchy，不能靠 prompt 宣称它已拥有 Task 权限。

### 7. worker idle 后是否会自恢复

**代码事实。** `runtimeNotification()` 对 `idle/inactive` 明确写出“没有 turn 执行”、不会
代表完成，并要求 manager 评估下一步；`sendMessageRpc` 的 `steer` 会向目标 agent 发送新
输入。没有代码会因 idle 自动创建下一轮 Task 或自动给 worker 发 assignment。

**冷审结论。** worker 不自恢复是当前设计事实；manager 是否读取报告、更新 Task、再发消息
取决于 prompt 行为。应在 supervisor guidance 写成动作链：收到 runtime 通知后读 Task/
Activity/最终回复，再选择追加 assignment、更新、升级、退休或结束。不要把“通知到达”误写
成“业务工作已完成”。

### 8. lead 是否需要用 sleep 阻塞等待通知

**代码事实。** runtime 和团队消息都通过 Paseo `send` 投递，runtime 路径使用 `steer`；
`runtimeNotification()` 本身不是 Activity，也不是 agent-authored team message。manager
只有在自己的 turn 能处理新输入；代码没有提供 sleep 等待协议，也没有要求调用者轮询。

**冷审结论。** 用 `sleep` 等待属于 agent 行为和 prompt 误导，不能推导出缺少 event bus 或
额外 promise。manager guidance 应明确不要 sleep/轮询等待；让当前 turn 结束，通知作为新输入
到达后立即读证据并协调。静态证据不足以保证某个 provider 的 harness 在长 sleep 中如何调度，
这需要运行测试而非 prompt 结论。

## Prompt 与代码边界

- `rolePrompt()` 读取 `PWA.md` 与选定 role 文件，校验 role class 后调用 `initialPrompt()`。
  `creationConfig()` 将结果放入 Paseo agent `config.systemPrompt`；创建完成后另由
  `created.send(input.brief)` 发送首条工作输入。因此 role-class block、PWA body、role body
  和 orientation 的顺序是可证的，但模型是否遵循是 prompt 层行为。
- `messagePrompt()` 只标记 sender/recipient/task/message，并明确 delivery 不等于 read、
  understood 或 completed；`sendMessageRpc()` 先做 Task 鉴权，再调用 Paseo send。返回的
  `messageReceipt()` 是“accepted by Paseo for delivery”，不是阅读回执。
- daemon `MessageReceipts.send()` 以 agent/message ID 建立磁盘 receipt，pending 状态在 provider
  已接受但 receipt 未提交时返回 outcome unknown；它保证幂等/冲突检测，不保证模型阅读或完成。
  这与 prompt 中“not a durable queue”的行为提示是同一边界，不能互相扩大语义。
- `notifyManager()` 只处理插件收到的 `completed/canceled/failed` turn-ended 事件；idle 文本
  分支存在于纯函数 `runtimeNotification()`，不表示 `notifyManager()` 会自动为每个 idle
  snapshot 发送通知。把 idle 分支当作覆盖证明属于证据越界。

## 建议给 supervisor 的下一步

1. 把 1、2、3、5、6、7、8 作为 prompt/PWA 行为修订项，补充具体工具调用顺序、通知后的动作
   链和禁止 sleep/轮询的规则；不要修改权限以迁就错误调用顺序。
2. 把 4 单独作为 roster lifecycle 设计任务，先决定退休时运行中 agent 与 Task 引用的语义，
   再评估 RPC 和测试；PWA 文字不能替代该能力。
3. 对 `agent.turn_ended`、idle/error、steer delivery 做运行级测试，确认 provider 覆盖范围；
   在测试完成前，对“所有退出路径都会通知”保持未决。

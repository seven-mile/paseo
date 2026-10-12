# Prompt 冷审对 daemon 冷审的互相质疑

基准材料：`reports/worker-daemon.md` 与 `reports/worker-prompt.md`。以下不是重新设计，
而是逐条标出 daemon 视角对 prompt 报告的补充、证据越界和两者必须共同保留的限定。

## 总结结论

daemon 报告纠正了 prompt 报告中一句过宽的概括：Task、Activity 和消息规则是 handler
硬约束，但这只在 MCP 工具把受信任 `callerAgentId` 注入 `actorName` 的路径成立。原生
`plugin.rpc.invoke.request` 的调用上下文若确实只提供 `daemon.manage`，而 handler 只信任
输入字段，则 actor spoofing 是更高优先级的权限审计项；不能把 MCP 的身份链推广到所有
plugin RPC。

同时，daemon 报告中“可直接伪造”应保持为静态风险，而非已证实的远程越权：现有证据证明
操作权限映射和 handler 参数来源，尚未证明每种部署都允许不可信调用者获得该 daemon.manage
会话，或该入口绕过了其他 session principal 检查。

## 逐条质疑

### 1. roster / board

daemon 报告正确补充了两层输出：`swarm.board.read` handler 返回全量持久化快照，而
`swarm_board_read` 经 `summarizeSwarmBoard` 才做当前 agent 的层级裁剪和分页。prompt 报告
把“已有 roster”写得过于笼统，应该明确只对 MCP workset 视图成立；直接 RPC 的全量
`activities` 也改变了数据暴露面。

但 daemon 报告若据此断言“直接 RPC 一定暴露全量给攻击者”仍越过证据：已知的是 handler
合约和 `daemon.manage` 操作权限，不是实际网络/会话持有者分布。下一步应做权限集成测试，
而不是把 prompt 修订当作访问控制修复。

### 2. 自动通知与轮询

两份报告需要合并限定：`index.server.ts` 的 `agent.turn_ended` 只覆盖
`completed/canceled/failed`，`runtimeNotification()` 的 idle/inactive 分支本身不证明
插件会发送 idle 通知。prompt 报告先前把“存在 idle 文本”与“已有 idle 通知链”放得太近；
daemon 报告的区分是正确的。

另一方面，daemon 报告提到其它 `setupFinishNotification` 路径，但该路径不等于 Swarm
`notifyManager`，也不能自动证明每个 provider、每个退出原因都覆盖。manager “无需轮询”
只能在已建立的通知路径和运行测试覆盖范围内作为行为建议。

### 3. Task ownership 与 actor 身份

prompt 报告关于“worker 无法 update/activity、manager ownership 有意设计”的事实仍成立，
但应追加作用域：`paseo-tools.ts` 的 `invokeSwarm` 覆盖 actor 字段，才把这些规则绑定到
当前 MCP caller；底层 `createTaskRpc/updateTaskRpc` 通过输入的 `createdBy/actorName` 查找
记录。daemon 报告指出的 spoofing 风险是 prompt 报告遗漏，不能靠补充 role guidance 解决。

daemon 报告也不应把 handler 的名称检查称作完整认证；它只能证明业务规则对“已解析 actor”
的限制。是否存在可利用的 direct RPC 越权，要由 session principal 和授权集成测试确认。

### 4. roster retirement

两份报告一致：没有 retire handler，prompt 不能创造生命周期能力。daemon 报告新增的事实很
关键：同一 Paseo ID 的 register 路径可把 `retired` 重置为 `false`，因此此前“过滤 retired”
不能描述为永久拒绝或不可重新启用。报告应将这件事归为未定义的 re-register 语义，而不是
暗示已有安全的恢复流程。

### 5. Activity 粒度与 human append

prompt 报告正确把粒度归为 prompt/PWA 行为，但遗漏了 `append_human_activity` 的不同权限
边界：它不验证 human principal，写入成功后 manager 通知失败只返回
`notificationWarning`。daemon 报告补充完整；不过“任意 caller 可写”仍应标成 direct RPC
静态风险，需先确认 RPC 的实际 caller 权限。

### 6. harness 子 agent 与 register/create

prompt 报告“provider harness 子 agent 不自动进入 roster”只对经过 MCP/Swarm 注册的路径
成立。daemon 报告正确指出 direct `register/create/prepare/bind` 缺少 principal 绑定，
因此不能用该 prompt 结论推导所有原生 RPC 都拒绝未注册调用者。

反向限制也要保留：没有证据表明 provider harness 子 agent 会自动获得 Paseo plugin RPC
入口；不能把“存在 direct RPC spoofing 风险”写成 harness 已经成为 roster 成员。

### 7. idle 自恢复与消息接收者

两份报告一致认为 idle 不会自动续跑，`send(..., steer)` 只是可发送新输入。daemon 报告
新增的 recipient binding 缺口很重要：`sendMessageRpc` 按输入的 Paseo ID 投递，却没有在
handler 验证该 ID 与 `recipientName`、active roster 或 Task participant 集合一致。prompt
报告只讨论了 sender/Task actor 权限，未覆盖接收者身份与 Task 成员校验。

这不是通过 communicationRules 能修复的问题；即使 prompt 要求只给合法 worker 发信，handler
仍需验证 ID/name 绑定。

### 8. sleep、receipt 与失败处理

prompt 报告关于 sleep 是行为/提示误用、receipt 不代表阅读或完成的结论仍成立。daemon 报告
进一步限定：通知没有 durable retry queue；`send` 成功只代表 Paseo 接受 steer，通知失败
由 event hook 抛出且没有 plugin 持久化。

这里也要避免证据越界：`MessageReceipts` 是 daemon 用户消息路径的幂等 receipt，不等于
Swarm `notifyManager` 的通知队列；不能用前者证明 runtime notification 可重试，也不能用
“not durable queue”推导所有消息必丢失。两者应分别测试。

## 必须修正的共同表述

1. 将“handler 鉴权是硬约束”改为“在 MCP caller 注入路径，handler 对已解析 actor 执行业务鉴权”；direct plugin RPC 的 principal 绑定另行审计。
2. 将“自动通知已存在”改为“插件对 turn-ended completed/canceled/failed 有明确通知路径；idle/inactive 及其它 finish-notification 路径需单独验证”。
3. 将“delivery receipt”限定为接受投递/幂等证据，不表示读取、执行、Task 完成或 runtime 通知持久化。
4. 将 `retired` 描述为过滤字段而非完整生命周期；register re-enable、运行中 agent 和历史 Task 引用均未定义。

## 结论与验证顺序

daemon 报告没有推翻 prompt 冷审的主要分层结论，反而把其适用范围收窄到具体调用路径。
最高优先级不是改 role wording，而是补 direct RPC principal、recipient ID/name/Task 绑定和
通知失败矩阵的集成测试；随后再补 supervisor prompt 的 roster 入口、通知动作链、Activity
粒度与禁止 sleep 规则。没有这些测试前，双方报告都不应把静态风险写成已发生的越权或“所有
退出路径都会通知”。

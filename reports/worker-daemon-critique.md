# 对 `worker-prompt.md` 的 daemon 视角复核

复核对象：`reports/worker-prompt.md`。结论与 `reports/worker-daemon.md` 对照，重点检查 prompt 层结论是否越过 handler 证据，或遗漏 daemon 身份、权限和返回值。

## 总体判断

`worker-prompt.md` 正确地区分了 PWA/prompt 行为和 handler 权限，也正确指出 idle 文本不能证明插件会发送 idle 通知。主要遗漏是把 MCP 工具层的 caller 绑定当成了整体权限事实：原生 `plugin.rpc.invoke.request` 只要求 `daemon.manage`，plugin handler 不接收 session principal，输入里的 `actorName`、`createdBy` 和 recipient 字段仍可由 direct RPC 调用者提供。该缺口影响第 1、3、6、7 项的安全边界。

## 逐条质疑

### 1. roster 读取

报告说 `swarm_board_read` 按层级裁剪，这对 MCP tool 路径成立（`paseo-tools.ts:687-701`）。遗漏是底层 `swarm.board.read` handler（`operations.ts:282-304`）返回持久化的完整 `agents/tasks/activities` 快照；层级裁剪、分页和摘要都发生在 MCP 工具层。`session.ts:2452-2463` 的直接 plugin RPC 没有 caller agent 注入。因此“已有 roster 方法”不能写成所有 RPC 调用者都只看到自己团队；直接 `daemon.manage` caller 可读到跨团队 Activity 全文。

### 2. 轮询和通知

报告已保留“不能证明所有 provider 路径都通知”的谨慎表述，这与 daemon 冷审一致。还应补充：插件 `index.server.ts:5-20` 的 `agent.turn_ended` 只处理 `completed|canceled|failed`；`runtimeNotification()` 的 idle/inactive 分支是纯字符串分支，不由 `notifyManager()` 触发（`operations.ts:715-735`）。因此 prompt 中“收到 runtime 通知后的动作链”不能暗示每个 idle snapshot 都会经过该插件。

### 3. Task ownership

报告说 `createTaskRpc` 以调用者为 `createdBy`，容易让读者以为调用者身份由 daemon 认证。实际 `createdBy`、`actorName` 都是 RPC 输入；只有 MCP 的 `invokeSwarm()` 才把受 `callerAgentId` 校验过的 qualified name 注入（`paseo-tools.ts:669-680`）。直接 plugin RPC 可以填写另一个 active Agent 名称，绕过“lead 代 supervisor 创建会导致 supervisor 无写权”的行为前提。原报告的 ownership 结论适用于 MCP tool 调用，不足以描述 plugin handler 的信任边界。

另外，`updateTaskRpc` 接受任意非空 `status`，不验证 PWA `statuses`（`operations.ts:558-587`）；prompt 可以规定合法状态，但不能声称 handler 已保证状态枚举。

### 4. retirement / rename

报告结论基本准确：没有 retire、rename、reparent handler。遗漏一个生命周期事实：`registerAgentRpc` 对已存在 Paseo ID 的记录会把 `retired` 重置为 `false`（`operations.ts:335-369`）。因此“retired 过滤”不是永久拒绝或不可逆退休；重新注册语义尚未定义，prompt 不应把 retired 当作终态。

### 5. Activity

报告正确指出 agent Activity 只有 manager/planner 可写，粒度靠 prompt。遗漏 `appendHumanActivityRpc`（`operations.ts:607-642`）：`actorName` 默认 `human`，handler 不校验 human principal，任意可调用该 RPC 的 daemon.manage session 都能写 human Activity；通知 manager 失败时仍返回 Activity，并附 `notificationWarning`。因此“消息/通知都先鉴权再投递”的概括不能套到 human Activity。

### 6. provider harness subagent

报告正确说明 provider 子 agent 不自动进入 MCP roster。证据边界仍需收紧：MCP 工具无 caller 时不注册 Swarm tools，但 `swarm.agent.create/prepare/register/bind` 的 plugin handler 没有独立 principal；`actorPaseoAgentId:null` 是合法输入，direct RPC 可绕开 MCP 的 caller 必填约束。不能把“provider 子 agent 没有 capability token”扩展成“所有原生 RPC 都拒绝无 caller 的创建/注册”。

### 7. idle 自恢复

报告正确说没有 idle 自动续跑，也正确要求 manager 后续协调。遗漏消息权限的实际边界：`sendMessageRpc` 的 Task-scoped actor 校验依赖输入 `actorName`；handler 没有把 recipient Paseo ID 与 recipientName 绑定，也不检查目标 ID 是否 active/属于 Task（`operations.ts:645-683`）。MCP 工具会先从 board 解析名称，所以工具路径看起来安全；prompt 动作链不能替 direct RPC 补这个校验。

### 8. sleep 阻塞

报告与 daemon 证据一致：没有 sleep 协议，steer 投递不依赖轮询。补充限制：`messageReceipt()` 只表示 Paseo 接受投递，`sendMessageRpc` 返回 `{delivered:true, receipt}`，不证明阅读、动作或 durable queue；prompt 的“delivery 不等于完成”描述正确，但不能把它理解成收件人身份已验证，因为 handler 对 recipient ID/name 未做绑定。

## 需要从 prompt 报告修正的表述

1. 在所有“已认证 actor”“Task ownership 有效”的句子后注明“对 MCP agent tool 路径”；plugin RPC 的 actor 是输入字段，通用入口权限是 `daemon.manage`。
2. 将 board 的“按层级读取”限定为 `swarm_board_read` 工具输出；`swarm.board.read` 原语本身是全量快照。
3. 将“Task-scoped message 已鉴权”改为“对 MCP 注入 actor 的 Task-scoped message 有角色检查；handler 尚未绑定 recipient ID/name”。
4. 在 Activity 部分加入 human Activity handler 的无 principal 校验和 `notificationWarning` 返回语义。
5. 在 retirement 部分注明重新 `register` 可清除 retired，当前没有终态语义。
6. 将 idle 通知测试目标明确为两条链：插件 `agent.turn_ended` 的 completed/canceled/failed，以及 daemon `setupFinishNotification` 的其他状态；不要用 `runtimeNotification` idle 文本作为触发覆盖证明。

## 结论

`worker-prompt.md` 对“哪些问题需要 prompt、哪些需要新原语”的大方向没有被 daemon 冷审推翻；但它把 MCP 工具层的身份安全带到了 plugin RPC 层。提交给 supervisor 的最终综合报告必须同时呈现两条调用链，并把 direct RPC 的 `daemon.manage` 权限、actor 可伪造、全量 board 返回和消息 recipient 未绑定列为权限边界，而不是 prompt 行为问题。

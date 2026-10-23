# Plugin 协作模型

## Task 与 Activity

Task 是项目共享的持久工作对象。它可以先进入 backlog，由 supervisor 管理；没有运行中的 agent 或 Workspace 时仍然存在。

Task 保存稳定的可读 slug、标题、brief、当前展示状态、创建者、管理 supervisor、worker names 和可配置业务字段。Task 不绑定单一 Workspace；Workspace 仍从 agent 的 Paseo affiliation 读取。supervisor 通过 Task 和 A2A 消息派发具体工作，worker 的 transcript 和运行状态留在 Paseo。

Activity 是面向用户的时间线记录，保存写入者、Task、Markdown 正文、结构化扩展数据、canonical refs 和时间。只有有权限的 agent 或人类可以追加 Activity；worker 只发送报告，由 supervisor 理解后记录。普通 Paseo turn/status 变化留在 Paseo 运行视图，只有被 supervisor 或人类提炼的进展才进入 Activity。正文中的 `paseo-swarm://` Markdown link 是 ref 的作者入口，plugin 在写入时解析并校验；UI 再把它们连接到 agent、Workspace 或 Task。

PR、报告、文件和截图先作为带标签的引用挂在 Task 或 Activity 上，不为它们建立独立生命周期。

## Kanban 与权限

Kanban 是 Tasks 的项目级视图。第一版支持项目配置列和扩展 JSON 字段，不建设通用表单或状态迁移引擎。

Planner 或人类维护项目 schema。Supervisor 维护自己管理的 Tasks 和 Activities；worker 报告结果但不会修改 Task 或追加 Activity。Supervisor 选择管理范围内的 worker，Workspace 从该 worker 的 Paseo affiliation 得到。

跨管理范围修改先由 A2A 联系对应 supervisor，由 planner 或人类明确转交。UI 与 agent tools 调用同一套权限检查，调用者身份由 Paseo agent 关联解析，不能由请求正文自报。

## A2A 与向上通知

A2A 消息使用发送者 name、接收者 name、正文和可选 Task 引用。消息正文保持自然语言，不要求 transcript 遵循可机械提取的格式。

同一套上下级关系用于两层通知：worker 的运行状态变化和明确报告发给 supervisor；supervisor 的状态变化和项目级报告发给 planner。通知只描述运行事实或报告，不自动改变 Task 状态，也不把消息送达解释为工作完成。

Team message、人工 Activity 通知和向上的 runtime 通知都先写入接收者的 durable mailbox（`server/mailbox.ts`），再通过 Paseo send message 以 steer 投递。Mailbox 行按 roster member（`AgentRecord.id`）寻址，投递时才解析当前的 Paseo agent，所以 member 换了底层 agent 后，未投递的消息跟着 member 走。Paseo send 使用 mailbox 行 id 作为 `messageId`，daemon 的 message receipt 让重试幂等。

状态按顺序推进：queued（尚未投递）→ delivered（Paseo 已接受，记录 `deliveredToPaseoAgentId`）→ consumed（该 Paseo agent 之后有一个 turn 以 completed 结束）。连续失败到上限或接收者已 retired 时记为 failed，不再重试。同一接收者的消息按创建顺序投递，前一条失败时后面的保持 queued。Plugin 拿不到常驻的 Paseo API，所以重试发生在下一次发送、任意 agent 的 turn 结束和 `swarm.mailbox.read` 时；daemon 重启后遗留的 queued 消息也在这些时机补投。Daemon 只记下 send 已开始而不知结果（`agent_request_outcome_unknown`）时，消息按 delivered 记录并写明原因，不换 id 重发，避免重复投递。

向上的 runtime 通知按 manager 合并成 turn digest。每个 child turn 结束写一行 mailbox 记录（agent、最近一条 Task-scoped 消息的 Task、outcome、失败或取消的 detail、改动文件数、最终回复的前 1,500 个字符；截断时附 Paseo agent id，manager 用 `get_agent_activity` 读全文）。Manager 空闲时立即投递；manager 正在跑 turn 时这些行先留在 mailbox，等它的 turn 结束后作为一个 `<paseo-swarm-turn-digest>` 一次投递，所以一次 burst 只唤醒 manager 一次。投递前先给这批行写同一个 `batchId`，它也是 daemon `messageId`，重试时原样重发；之后到达的行进入下一个 digest。Manager 是否在跑 turn 来自 `agent.turn_started`/`agent.turn_ended` hook 和 Swarm 自己的 send，只存在内存里：daemon 重启后视为空闲。没有 timer，所以如果一直没看到 manager 的 turn 结束，被扣住的行超过 2 分钟就在下一次 flush 时 steer 进去；排在它们后面的 team message 也会先把它们带出去，保证顺序。

所有信封只携带数据：`<paseo-swarm-team-message id from to task …>` 和 `<paseo-swarm-turn-digest manager turns>`，字段放在属性里，正文就是发送者原文或 child 的最终回复。信封的含义（送达不代表已读、turn outcome 不代表 Task 完成、不要回执、manager 必须决定下一步）只在 system settings 里写一次，不再在每条消息里重复。App 的 `packages/app/src/swarm/system-envelope.ts` 把属性还原成可读的字段行，旧格式的无属性信封仍按原样显示。

Paseo hook 是 live wakeup。Plugin 启动和重连时重新读取 roster、Tasks、Paseo agents 和 Workspaces，补齐当前事实；不能把漏掉某次 hook 当作永久状态。

## Activity 与人类交互

Activity 可以保存写入者、问题、材料、Task、后续接收 agent 和 action。它是 plugin 的持久记录，UI 从带交互数据的 Activity 查询待处理列表和详情，不额外引入一套新的工作实体。

项目级 Activity 的接收者由 PWA 或创建操作指定，可以是 planner、人类或相关 supervisor；接收者负责把回复转成后续操作。Supervisor 可以在自己 Task 上添加需要人处理的 action。人类回复追加新的 Activity 并通知 Task manager；回复不会自动完成 Task。

PWA 修改、研究方向和一般业务提案共用这条 Activity action/reply 路径。proposal 专用状态机、逐段评论、revision diff 和 discussion room 后续实现。

## 状态、恢复与 UI

| 信息                                                                 | 权威与维护                     | 用途                                |
| -------------------------------------------------------------------- | ------------------------------ | ----------------------------------- |
| Agent name、aliases、role class、role、上下级关系                    | plugin roster                  | prompt、路由、权限和导航            |
| agent 的 Paseo Workspace affiliation 与 supervisor 的 Workspace 视图 | Paseo + hierarchy query        | 执行隔离、上下文和状态通知          |
| Task、Activity 和项目 schema                                         | plugin 持久化记录              | 项目视图、工作上下文和进展          |
| agent/workspace 运行状态与 affiliation                               | Paseo                          | 运行状态和 Workspace 视图的事实来源 |
| PWA source location 与当前 revision                                  | plugin 配置 + 人类可读文件/Git | 协作约定和 prompt 来源              |

恢复时读取 plugin 记录，重新取得 Paseo 当前 agent 和 workspace facts，再组装 agent prompt context。Supervisor 的 Workspace 视图在读取时沿 hierarchy 重新计算。Plugin 不从历史 transcript 猜测 Task 状态。

第一版使用 Paseo 原生 surface、workspace panel、主题和导航，提供：项目 Task 总览、Paseo Workspace 视图、Task 详情、Activity、PWA 编辑和人类交互。Task 详情中的 roster agent 与 Activity 中的 agent/workspace ref 通过 Paseo client navigation 打开对应目标；没有导航能力的旧 host 隐藏或降级这些动作。所有入口共享同一服务和记录；Agent 生成的 HTML 展示是后续增强，不能成为初始 Activity content contract。

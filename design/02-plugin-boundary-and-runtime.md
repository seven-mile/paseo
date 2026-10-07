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

A2A 消息通过 Paseo 原生 send message 传递，使用发送者 name、接收者 name、正文和可选 Task 引用。消息正文保持自然语言，不要求 transcript 遵循可机械提取的格式；第一版不在 plugin 中复制一套消息持久化模型。

同一套上下级关系用于两层通知：worker 的运行状态变化和明确报告发给 supervisor；supervisor 的状态变化和项目级报告发给 planner。通知只描述运行事实或报告，不自动改变 Task 状态，也不把消息送达解释为工作完成。

Paseo 的 queue、steer 和 interrupt 能力由 adapter 统一使用。完整的 durable async 投递和接收回执是后续增强；第一版保留 plugin 的消息记录，按 Paseo 实际返回值报告投递结果。

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

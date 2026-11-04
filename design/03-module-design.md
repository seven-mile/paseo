# 模块设计 v0

这一层把架构翻译成传统软件工程中的数据、存储、用例、外部接缝、调用路径和权限。模块先保持在一个 Paseo plugin 内；不提前拆成多个 package 或 workflow engine。

## 分层

```text
client UI / agent MCP tools
            │
            ▼
       use cases
   ┌────────┼─────────┐
   ▼        ▼         ▼
 roster   work     communication
   │        │         │
   └────────┴─────────┘
            │
            ▼
          stores
            │
   ┌────────┴─────────┐
   ▼                  ▼
prompt assembly   Paseo integration
                       │
                       ▼
          Paseo SDK / hooks
```

`stores` 是数据访问边界，不是对外的业务 API；use case 才是跨记录、鉴权和 Paseo 调用的业务入口。Roster、work 和 communication 是按用例分组的内部模块，不要求各自都成为独立 service。

### Persistence and domain modules

Plugin v0 使用一个版本化的 `state store` 保存 plugin-owned 数据：roster、Task、Activity、项目 schema 和 PWA source configuration。它负责完整文档的读取、校验、revision、原子写入、迁移和恢复，不调用 Paseo，也不决定谁能做什么。Paseo 的 host-scoped settings 已经提供了这组小型 JSON 文档需要的持久化语义，因此第一条切片优先用 `defineSettings`；数据量真的超过配置文档适合的范围时，再把同一接口换成 server-side 文件或 SQLite。

`roster`、`work` 和 `activity` 是在 state store 之上的领域模块：前者提供上下级和权限范围查询，`work` 处理 Task 与 agent 关系，后者处理 Activity 追加、回复关联和时间线查询。它们不是各自的持久服务。A2A 也不建立 communication store；发送直接走 Paseo，通知路由只复用 roster 查询。

### Use cases

Use case 负责一次完整操作：解析调用者、检查 role class 和范围、读写多个 store、调用 Paseo integration，并在需要时追加 Activity 或发送消息。

第一版对外操作分成查询、plugin 记录操作和 Paseo 原生能力。查询不改变事实，记录操作才写 plugin store：

```text
查询：
list_agents
get_agent
list_tasks
get_task
list_activities
read_pwa

plugin 记录操作：
create_agent
update_agent
retire_agent
create_task
update_task
append_activity
append_human_activity
```

最小输入输出约定如下：

| 操作                    | 必要输入                                                                                    | 结果                                |
| ----------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------- |
| `create_agent`          | Paseo 默认创建参数，`name`、`roleClass`、`role`；可选 aliases、上级 name、existing agent ID | roster agent 和 Paseo agent 引用    |
| `update_agent`          | name；aliases 或展示字段 patch                                                              | 更新后的 roster agent               |
| `retire_agent`          | name                                                                                        | 标记为 retired 的 roster agent      |
| `create_task`           | slug id、title、brief，可选 owner、requester、assign                                        | 新 Task；owner 不是调用者时即为分派 |
| `update_task`           | Task；title、brief、status、owner、resolution 或 data patch，可选 briefBasedOn              | 更新后的 Task 和 change Activity    |
| `deliver_task`          | Task、result、taskState（done 或 open），可选 status、revises、to、cc                       | delivery Activity 和交付后的 Task   |
| `append_activity`       | Task、正文、结构化 data，可选 to、cc                                                        | 新 Activity；worker 不允许调用      |
| `append_human_activity` | Task、正文、结构化 data，可选 cc                                                            | 新 Activity，通知 owner 和 cc       |

`Task.id` 和 agent name 都是可读 slug。`Task.status` 是字符串，PWA 声明其有效值和业务转移，plugin 保存和索引它们但不执行状态机。Activity 必须属于一个 Task，并记录 `actorName` 与 `actorKind`。正文以 Markdown 为主；其中的 `paseo-swarm://` link 在写入时派生为 canonical ref，指向具名 agent、Task、Workspace 或 Workspace-relative file。这样项目级的 PWA proposal、审阅意见或人类决定也有稳定的 Task 时间线归属，不需要另建全局 mailbox。

`create_agent` 的 Paseo 参数在“创建新 agent”和“绑定 existing agent ID”两种路径中保持同一套编排字段；两者是二选一。`reportsTo` 默认调用者，只有调用者的层级范围允许时才可指定其它上级。具体工作沿负责 agent 的 Paseo affiliation 得到执行环境。

Paseo-backed capabilities 是：

```text
create_workspace
send_message
```

这些是 UI 或 agent tools 可能调用的边界，不是必须对应同名类。Paseo-backed capabilities 由薄 integration 暴露；`send_message` 例外，它先把消息写入 plugin 的 durable mailbox。Activity 回复是 `append_human_activity` 携带 reply metadata 的便利入口。`assemble_prompt` 是内部纯函数；Paseo runtime event 的接收、启动同步和向上通知也是内部协调流程，不是 agent 要调用的 `report_runtime_status`。相关操作可以共享一个小的 `work` 或 `coordination` 模块。

## 数据关系

```text
Project
├── PWA source ── current revision
├── Agents
│   ├── name / aliases
│   ├── roleClass / role
│   ├── reportsTo name
│   └── Paseo agent reference
├── Paseo Workspace view
│   └── derived from agent affiliation and hierarchy
└── Tasks
    ├── supervisor reference
    ├── configurable state and data
    ├── manager + worker names
    └── Activities
```

Task 的 workset 是动态查询：`managerName = current agent name`。Supervisor 的 Workspace 视图也是动态查询：读取自己和直接 workers 的 Paseo Workspace affiliation 并求并。一个 supervisor 可以管理多个 Task、使用多个 Workspace；Task 直接保存可读的 worker names。

Agent 的局部 `name` 在直属 manager 下唯一；跨作用域使用 `qualifiedName`，例如 `supervisor-a.worker`。`reportsTo`、Task、Activity 和消息路由保存 qualified name；局部 name 只在当前 manager 的子树中解析。Paseo ID 仍是 runtime 关联和未来真实 identity binding 的稳定键。

## Roster 与 Paseo integration

Plugin 的 `create_agent` 用例接受 Paseo 默认 `create_agent` 的参数，再增加最小的编排字段：canonical name、aliases、role class、role 和上级 name。新 agent 的 Paseo Workspace affiliation 由 Paseo 创建参数和运行事实决定，不复制成 roster access 列表。

`roleClass` 和 `role` 在创建时确定且不可通过 register/update 改变。普通调用沿固定层级创建：planner 创建 supervisor，supervisor 创建 worker；`reportsTo` 默认是调用者。worker 不能创建下级 agent。局部 name 的冲突检查发生在同一个 parent 下，qualified name 冲突检查发生在整个 project roster 内。

调用顺序是：

```mermaid
sequenceDiagram
    participant S as Supervisor agent
    participant T as Agent tool
    participant U as create_agent use case
    participant A as Authorization
    participant R as Roster store
    participant P as Paseo integration
    participant C as prompt assembly

    S->>T: create_agent(Paseo options + orchestration fields)
    T->>U: authenticated call
    U->>A: check role class and parent scope
    A-->>U: allowed
    U->>P: Paseo create_agent(options)
    P-->>U: Paseo agent reference
    U->>R: save name, role and hierarchy
    U->>C: assemble initial prompt
    U->>P: send initial prompt and expose tools
    P-->>T: named agent ready
```

Paseo integration 的作用是隔离 Paseo SDK 类型、创建/发送/订阅语义和生命周期 hook。Agent-facing tools 通过 plugin 管理的 Streamable HTTP MCP endpoint 暴露；每个 agent 获得带不透明 capability token 的 endpoint URL，gateway 从 token 映射到 Paseo agent，再进入 use case 做 authorization。token credential 独立持久化，不进入 Task 或 roster 记录。这个路径不要求修改 Paseo provider，也不把请求正文或 agent 自报身份当作调用者身份；它只约束 plugin-owned operations，不等于限制了 Paseo 原生 agent tools，后者仍是 Paseo 的 provider/tool policy 问题。Integration 不负责 role class 权限，不写 Task 状态，也不发明另一套 agent 配置。它应保持很薄；如果一个调用点直接使用 SDK 更清楚，可以暂时直接使用，重复出现后再收拢。

创建时的静态职责说明可以进入 agent system prompt；运行中的 Task 和 Activity context 通过 Paseo message 注入。不要假设 `agent.session_open` 能替换已有 system prompt。

UI 侧直接使用 Paseo 提供的 client hooks 和 navigation；server 侧才需要这层 integration。

## Task 与 agent

`create_task` 写入一个使用可读 slug 的 Task。Task 是看板上的一项项目级承诺：`managerName` 是它的 owner，`requester` 是提出这项工作的人或 seat（缺省为 `createdBy`），brief 记录 requester 与 owner 的当前约定，Activities 是正式履历。拥有工作和让它上看板是两回事：seat 不需要 Task 就能开始、委派和答复；哪些承诺上看板由 planner 决定。给另一个 seat 创建 Task 就是分派，owner 收到带 brief 的 `task-assigned` 邮件；`assign: false` 记录 owner 已经在做的工作，owner 收到 `task-recorded` 通知而不是新的分派。别的 seat 写的 brief 在 owner 写过 brief 或交付之前标记为 `briefUnconfirmedBy`。非 owner 改写 brief 时须带上读到的 `briefUpdatedAt`（`briefBasedOn`），此后被改过的 brief 不会被覆盖。owner 及其上级链（“line”）可以修改、交付、改派、关闭 Task 和追加 Activity；所有人都能读，worker 不修改 Task。`workerNames` 只是信息，不授予任何权限。supervisor 通过带 taskId 的消息向 worker 派发具体工作，taskId 不限制谁能给谁发消息。Paseo runtime status 与 transcript 是运行事实，不复制为第二个工作对象。

结果只通过 `deliver_task` 记录：一次调用写 delivery Activity、设置 Task 交付后的状态（`taskState`），并发给受众。修正已交付的结论时再交付一次并用 `revises` 指向被修正的 delivery；修正意味着还要继续工作时用 `taskState: open`，同一次调用即重新打开 Task。只有 Task 最新的 Activity 是同一 seat 在 5 分钟内的相同 delivery 时，调用才被当作重试。`resolution`（done、wont-do、duplicate、superseded）是 plugin 唯一读取的关闭语义；done 来自交付，或来自人类的 Close as done（`swarm.tasks.close`：不经交付按现状关闭，记录理由；单个关闭通知 owner，清理旧看板的整列关闭不通知，关闭也不会中断正在运行的回合）；其余三种通过 `update_task` 并附理由。`taskState: done` 表示约定的结果连同其中仍未满足的条件都已完成；记录 Task 或改写 brief 不会缩小约定，阶段性结果用 `taskState: open` 交付，约定与 requester 达成，requester、owner 的上级或人类都可以改变它；更小的结果要先得到这样的同意，再改写 brief 并在 reason 中写明谁同意。改写 brief 会抄送 requester 和 owner 的 manager，让他们知情而不是审批。`assign: false` 的记录在 planner 了解不足时可以不写 brief，由 owner 下次更新或交付时补上。PWA status 只是项目词汇。retire 一个 seat 时，它未关闭的 Task 交给最近的未退休上级。

写入的受众（`server/audience.ts`）由工作中的角色决定；planner 不会因为是协调者而成为缺省接收者：

| 写入                                   | 缺省 To         | 缺省 Cc                     |
| -------------------------------------- | --------------- | --------------------------- |
| `deliver_task`                         | requester       | owner 的 manager            |
| `append_activity`                      | 无              | 无                          |
| 以 wont-do、duplicate、superseded 关闭 | 无              | requester                   |
| 改写 brief                             | 无              | requester、owner 的 manager |
| 人在 Task 或 seat 对话中发的消息       | owner 或该 seat | app 缺省 manager，可移除    |

给出 `to` 或 `cc` 任一个，两个列表就是全部受众，所以 `to: []` 只记录不通知。两种接收者总会被加上：别的 seat 写某个 Task 时的 owner，以及回复所指 Activity 的作者。名字是 seat 或 `human`；human 没有邮箱，它的 seat 对话列出该 seat 发给它的交付。交付、Activity 和 `update_task` 的返回都用 `audience` 列出实际受众；信封的 `addressed` 在有多个读者时说明本份是 to 还是 cc。Cc 只提供上下文：不是新分派，也不要求确认，但仍按今天的方式唤醒接收者。

看板的当前视图由 resolution 和时间算出，不另存“是否在看板上”的标记：未关闭的 Task 按 status 分列，三天内完成的进入 Delivered 列，仍有人类选择未回答的 Task 不论多旧、是否关闭都留在当前视图；其余关闭的 Task 进入可搜索的 History。planner 整理看板的方式就是关闭：用 duplicate（`duplicateOf`）或 superseded（`supersededBy`）把工作合并到保留的 Task，被保留的 Task 列出并入它的 Task。整理从不改写 brief、结果，也不重新交付；交付立即生效，planner 不做审批。

```mermaid
sequenceDiagram
    participant S as Supervisor agent
    participant T as Agent tool
    participant W as work use case
    participant A as Authorization
    participant D as Task store
    participant P as Paseo integration

    S->>T: create_task(id, workers, brief)
    T->>W: authenticated call
    W->>A: check task scope and worker hierarchy
    A-->>W: allowed
    W->>D: save Task
    S->>P: send Task-scoped assignment
    P-->>S: accepted
    P-->>S: worker report or runtime notification
    S->>D: deliver result (taskState done or open)
```

并行工作和重试都由 supervisor 通过消息表达，不产生新的 plugin 工作实体。

## Activity 与人工交互

Activity 是追加记录，可以带 Markdown 正文、派生 ref、结构化 `data`、展示信息和一个需要人操作的 action。UI 将它渲染成进度条目、可导航引用、决策卡片或带输入的交互条目；人的回复追加新的 Activity，并通知 Task owner 和 cc 中的 seat。plugin 自己写两种 kind：`delivery`（只来自 `deliver_task`）和 `change`（owner、status、title、brief、resolution 的变化，`data.previousBrief` 保留旧 brief）；`append_activity` 不接受这两种 kind。未来 custom card 只扩展 renderer 和 typed view data，不改变 Markdown/ref 的基础内容语义。

待处理列表是对带有未完成 action 的 Activity 的查询投影。只有当未来需要跨 Task 的独立分派、期限或复杂履历时，才重新考虑独立记录。

## 通信与运行状态

Roster store 提供上下级查询；消息发送用例使用这个查询决定默认收件人，再调用 Paseo integration 投递。通信不解释正文，也不从消息送达推导 Task 完成。

Paseo 状态通知使用一条窄路径：

```mermaid
flowchart LR
    P[Paseo event or startup sync]
    R[Read current agent name and parent from roster]
    N[Send status notification]
    U[Supervisor or planner agent]

    P --> R --> N --> U
```

Paseo 已经拥有 runtime status；plugin 第一版不建立重复的 runtime projection。启动和重连时重新读取 Paseo 当前快照，事件处理只负责通知，supervisor 或 planner 再决定是否追加 Activity 或更新 Task。

## Role class permissions

权限只覆盖 plugin 自己的记录和 tools。它不是外部 provider、Git 或 CI 的 gate。

权限检查使用调用者的 roster 身份。role class 和 hierarchy 只给出粗粒度的 authorization allow；use case 还要检查 Task、Activity 等具体上下文。Agent-facing MCP 通过每个 agent 独立的 capability URL 识别调用者，再映射到 roster；请求正文和 agent 自报身份都不能替代这个身份。当前实现仍不限制 Paseo 原生 agent tools，原生工具权限由 Paseo 的 provider/tool policy 决定。

| 操作                            | planner             | supervisor           | worker                     |
| ------------------------------- | ------------------- | -------------------- | -------------------------- |
| 读取项目 roster、PWA、Task 总览 | 项目范围            | 项目范围内可见内容   | 自己相关内容               |
| 创建 supervisor agent           | 可以                | 不可以               | 不可以                     |
| 创建 worker agent               | 项目范围内可以      | 自己管理范围内可以   | 不可以                     |
| 创建 Workspace                  | 可以                | 可以                 | 不可以                     |
| 创建 Task                       | owner 为自己或下级  | owner 为自己或下级   | 不可以                     |
| 修改、交付、关闭 Task           | 在 owner 的 line 上 | 在 owner 的 line 上  | 不可以                     |
| 追加 Activity                   | 在 owner 的 line 上 | 在 owner 的 line 上  | 不允许                     |
| 发送 Task 报告                  | 可联系项目参与者    | 可联系上下级及协作者 | 带 taskId 发给 manager     |
| 发送 A2A 消息                   | 可联系项目参与者    | 可联系上下级及协作者 | 默认联系上级及 Task 相关者 |
| 启用 PWA 版本                   | 由人类授权后执行    | 不可以               | 不可以                     |

人类 UI 作为项目管理员可以执行项目级操作。具体调用仍通过同一套 use case，避免 UI 绕过记录和权限检查。role 只影响上下文和业务说明，不改变 role class 的基础权限。

## 初始代码形状

遵循 Paseo plugin 的 `shared / server / client` 边界：

```text
shared/
  models.ts          记录和 RPC/MCP schema
  operations.ts      tool/RPC contracts

server/
  state.ts
  roster.ts
  work.ts
  activity.ts
  use-cases/
    create-agent.ts
    work.ts
    communication.ts
  prompt.ts
  pwa-source.ts
  notifications.ts
  paseo.ts
  index.ts

client/
  project-screen.tsx
  workspace-panel.tsx
  task-screen.tsx
  pwa-screen.tsx
  navigation.ts
  index.tsx
```

`prompt.ts` 是纯 prompt 拼装函数，不是状态服务。`pwa-source.ts` 负责固定 source location 的读取和当前 revision 解析，不保存 PWA 正文。`paseo.ts` 是很薄的 SDK integration，不是权限层。`state.ts` 是唯一的 plugin-owned persistence adapter；v0 用 Paseo settings，后续更换存储后不改变领域模块和 use case。

Paseo timeline 的 plugin rows 只做 UI 投影，不是 Task 或 Activity 的权威存储；持久记录由 server-side store 保存，client 通过 RPC 查询。后续若加入 custom renderer，也只改变展示，不改变记录模型。

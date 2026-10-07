# Agent Orchestration：架构 v0

系统帮助人类和 agent 分工、沟通、决策、执行并追踪工作。第一版以正向协作为公理：PWA 把职责和流程讲清楚，agent 依据这些约定使用工具推进工作。

## 系统结构

```text
Project
  PWA：共同约定、role class、role、人工交互和局部工作方式
  Roster：具名 agents、role class、role、上下级关系和 Paseo 关联
  Workspaces：Paseo workspace affiliation 的派生视图
  Tasks：项目共享的持久工作对象
  Activities：工作时间线与人类交互记录

Human <-> Planner <-> Supervisors <-> Workers
                         A2A communication

PWA + roster + task + message + Paseo facts
  -> agent prompt context
  -> agent 使用工具工作、沟通和维护 Task
  -> plugin 持久化记录、发送通知并提供 Paseo 内 UI
```

`Task` 是工作模型的本位实体。它可以尚未分派，也可以由一个 supervisor 交给一个或多个具名 worker。Task 使用可读的 slug 作为身份；worker 的 Paseo runtime 状态和 transcript 是执行细节，不另建一层工作实体。`Activity` 记录 supervisor 理解后的变化、报告、决定和结果引用；Paseo 的原始运行事件仍由 Paseo 保管。

## 角色与关系

`role class` 是框架固定的三类角色：`planner`、`supervisor`、`worker`。它决定层级位置、基础工具和 plugin 内记录的权限。

`role` 在 agent 加入 roster 时确定，例如数据库迁移负责人、调查协调人或需要人工升级的范围。它描述职责、scope 和 escalation 方式，主要作为 prompt assembly 选择 PWA 职责段落的 hint；role class 和 role 都不能通过普通 agent 更新操作修改。

每个 agent 都是具名实体。`name` 是短 slug，也是系统内引用 agent 的唯一写法；`aliases` 只用于人类可读展示和搜索。Paseo 的 agent ID 可以由 adapter 保存，但不进入 agent-facing 数据模型。

Planner 管理 supervisors，supervisor 管理扁平的 workers；worker 不再继续管理 agent。相同的上下级关系同时用于 prompt 选择、A2A 默认路由、运行状态通知、Task 管理范围和 agent 导航。Workspace 是 Paseo agent 所属的运行资源；supervisor 能管理的 Workspace 是自己和直接 workers 所属 Workspace 的派生视图。

Supervisor 像 agent team 的 lead：拥有自己的 Task 工作集，创建和管理 workers，向它们派发工作，阅读报告并维护 Task Activity。worker 不因为执行 Task 自动获得修改 Task 看板或 Activity 的权限。Planner 处理跨 Workspace 协调和需要人决定的事项。

Agent hierarchy 和 work graph 是两套关系：前者回答“谁管理谁”，由 roster 的上下级关系表达；后者回答“谁负责什么”，由 `Task → agent name` 表达。`create_agent` 只改变前者，`create_task` 创建可读的工作对象，supervisor 通过 Task 的 worker names 和 A2A 消息派发工作。

## 责任分工

**Human** 负责项目方向、PWA 的生效，以及 PWA 明确保留给人的决定。

**Planner** 负责项目级协调：管理 supervisors，消费全局 Task 与显式路由给它的 Activity，处理跨 Workspace 协调，并把后续工作委派给合适的 supervisor。人类也可以直接进入 Task 或 supervisor，默认路径由 PWA 和具体 UI 操作决定。

**Supervisor** 接近业务上下文，依据 PWA 组织 workers、维护自己的 Task 工作集、通过 worker 的 Workspace affiliation 获得隔离、整理报告并向上汇报。

**Worker** 承担实现、研究、review 等具体工作，使用 A2A 报告发现、阻塞和结果。

**Plugin** 保存 roster、Tasks 和 Activities；提供 agent tools、A2A、运行状态通知、prompt context 拼装和 Paseo 原生 UI。Workspace 视图和相关检查沿 agent hierarchy 读取 Paseo affiliation，不复制成 plugin 状态。

**Paseo / harness** 提供 agent、Paseo workspace、运行状态、生命周期事件和 prompt 投递能力。Plugin 关联这些事实，不把 Workspace affiliation 复制成另一套权限状态，也不从 transcript 推断完整项目状态。Git、CI 和 forge 继续拥有自己的事实。

## 软硬边界

PWA 用自然语言表达项目流程，Task schema 提供可追踪的工作记录。Plugin 不把“何时成熟、何时 review、何时 merge”编译成固定状态机；supervisor 依据 PWA 做业务判断。

Plugin 可以机械检查调用者是否属于项目、其 role class 是否允许调用该操作，以及该 Task 是否在其管理范围内。层级只提供粗粒度 authorization allow；具体命令还要自行检查所需上下文，不自动代行、不切换 agent prompt，也不制造额外 agent 身份。外部工具权限、PR gate 和全面越权防护不进入当前核心设计。

## 文档范围

- [PWA、roster 与 agent prompt](01-pwa-roster-and-context.md)：约定如何组织参与者，以及 prompt 从何处组装。
- [Plugin 协作模型](02-plugin-boundary-and-runtime.md)：Task、Activity、通信、人类交互和运行时边界。
- [模块设计](03-module-design.md)：数据关系、调用图、工具边界和 role class 权限。
- [PR/MR PWA 样本](04-pr-workflow-pwa.md)：用一个具体流程检验通用模型的表达力。
- [第一版范围与实现顺序](99-first-slice-and-open-questions.md)：纵向切片、验证目标和延期内容。

这是架构约定，尚未实现。下一步以模块设计和初版 PWA 驱动一条可运行的纵向切片。

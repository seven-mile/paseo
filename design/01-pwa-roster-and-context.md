# PWA、Roster 与 Agent Prompt

## PWA

PWA（Project Working Agreement）是项目协作约定。它按共同说明、planner、supervisor、worker、role 和人工交互分段，也可以附加 repository、target 或工作范围的局部说明。

PWA 保留自然语言表达力；半结构化标题和 audience 标记只用于选择适用内容。PWA 不直接成为可执行状态机。Plugin 提供一个固定、可见、可由人类直接编辑的 source location；内容以普通文件保存，并优先放在 Git 管理的目录中。这个目录是否单 repo、多 worktree 或其它布局暂不决定。

人类可以阅读和编辑 PWA source。Plugin 在组装上下文时读取当前 source，并在可用时记录对应的 Git revision；v0 不另设一套“启用版本”状态。PWA Charter 是 plugin skill 与项目 PWA 之间稳定的元协议，规定 PWA source package、frontmatter、role sections、revision/activation 和 proposal 的体裁与生命周期；项目 PWA 只描述具体 workflow 和约束。

当前读取到的 source revision 是上下文的事实来源：

- 新建 agent、恢复 agent 或重新派发 Task 时使用当前 source revision；
- 编辑 source 不会回写正在工作的 agent；需要重新说明时由新的 Task message、Activity 或显式上下文刷新触发；
- UI 显示每个 agent 最近使用的 PWA 版本和重新注入结果。

发送成功只表示 Paseo 接受了输入，不表示 agent 已理解或已经依据新版本行动。

## Roster

Roster 保存项目中的具名 agents、role class、role、上下级关系和 Paseo 关联。Agent 所属 Workspace 由 Paseo 提供；supervisor 的可管理 Workspace 是根据 hierarchy 对这些事实求并得到的视图。

Agent 的 `name` 是短 slug，系统引用始终使用它；一个 agent 可以拥有多个 `aliases`，但 aliases 不是引用键。Paseo agent ID 只在 plugin adapter 内部使用。

Role class 只有三类：

- `planner`：项目级协调和 supervisor 管理；
- `supervisor`：自己的 Task 工作集、直接 worker 管理、报告理解和 Activity 维护；
- `worker`：具体 Task 工作和结果报告。

Role 是固定在 roster agent 上的 PWA-defined 工作身份。它主要作为 prompt assembly 选择 PWA 职责段落的 hint，也可以说明工作 scope、输出要求和何时向人 escalation；它不能创造新的 role class，也不能替代 role class 权限或指导 agent 的每一步行为。普通 `update_agent` 只能修改 aliases 和展示信息，不能修改 role class 或 role。

Workspace 是 Paseo 管理的运行资源。Supervisor 的工作范围由它管理的 Task 决定；它能管理的 Workspace 从自己及其直接 workers 的 Paseo affiliation 计算得到。复杂 Task 可以通过创建新的 Workspace 和 worker agent 获得隔离；具体工作使用负责 agent 所属的 Workspace。

创建受管理 agent 是一个组合操作：使用与 Paseo 默认 `create_agent` 对齐的参数创建 Paseo agent，或通过可选的 existing agent ID 绑定已有 Paseo agent；再登记 name、role class、role 和上下级关系等编排元数据；为它提供 agent prompt context 和 plugin tools；最后发送首条工作输入。Plugin 只额外增加编排字段，不重新发明 Paseo 的创建参数。

`retire_agent` 目前只有软删除语义：保留 roster 历史记录并标记为 retired。通知、鉴权拒绝、运行中 agent 处理和后续重新启用都暂不定义。

## Agent Prompt Context

Plugin 在 agent 创建、恢复、收到 Task message、人工回复或需要重新说明职责时组装 prompt context：

```text
当前启用的 PWA 内容
+ agent 的 name、role class、role、Workspace 和上下级关系
+ 当前 Task 和必要的 Activities
+ 相关消息、带 action 的 Activity 或运行状态变化
+ 可用 tools、输出对象和接收者
```

Planner 获得项目总览和 supervisor 反馈；supervisor 获得自己管理的 Tasks、派生出的 Workspace 视图和 worker 报告；worker 获得当前 Task、所属 Workspace、相关 PWA 和上报路径。

上下文按理解工作所需的范围裁剪，不能为了隔离 role 而删除理解任务所需的背景。工具说明和身份关系由 plugin 生成；具体如何推进 Task、何时并行派发、何时请人决定，由 PWA 表达。

Plugin 还按 role class 注入一段 skill-shaped system settings，放在 system prompt 开头显著的 `<paseo-swarm-system-settings>` block 中；它不是由 harness 安装和加载的 skill，而是说明该 role class 如何使用 plugin 能力，并要求 context compaction 后在下一次可控的 context assembly 中重新注入，不依赖模型摘要恢复。Paseo 的 per-agent `config.systemPrompt` 和 `agent.create` hook 支持这条路径，但外部创建且未经过 plugin 组合流程的 planner 不享有可变 system prompt 的保证。

## 触发与权限

需要接入的时机包括：

- agent 创建、接管和恢复；
- Paseo Workspace 创建和 agent affiliation 变化；
- Task 创建和重新分派 worker；
- agent 运行状态改变；
- A2A 消息或人工回复送达；
- PWA 版本启用。

Plugin 根据调用 agent 的 role class、上下级关系和 Task 管理关系检查自己的写接口。上级可以在下级范围内获得某些操作的 authorization allow，但每个命令仍自行检查调用者是否具备所需上下文，不自动代行。Worker 能读取当前上下文、发送 Task-scoped 消息，但不能写 Task 或 Activity；supervisor 能管理自己的 workers、Tasks 和 Activities，并使用自己及直接 workers 所属的 Workspaces；planner 能协调项目范围并管理 supervisors。业务上的阶段判断仍由 PWA 和相应 agent 负责。

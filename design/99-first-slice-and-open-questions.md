# 第一版范围与实现顺序

## 第一版目标

交付一个在 Paseo 内可持续使用的协作产品：人类配置 PWA，planner 管理 supervisors，supervisor 管理 workers；Tasks、Activities 和人工交互有持久归属，参与者能相互定位和沟通。Workspace 作为 Paseo agent affiliation 的运行资源，通过 hierarchy 形成可见视图。

第一版必须覆盖：

- 具名 agent roster、role class、role、上下级关系和 Paseo affiliation；
- planner / supervisor / worker 共用的 agent 创建、查询、消息和状态通知路径；
- Task、Activity 的持久 CRUD 与权限检查；
- agent prompt context 的组装、配置 PWA 文件的读取和显式重新说明；
- Activity action、回复和后续处理者；
- Paseo 原生项目入口、Workspace 视图、Task 详情和 Agent 导航。

Kanban 列和业务字段可配置；proposal 专用流程、custom HTML、完整 durable async 投递和外部 gate 延后。

## 第一条纵向切片

```text
人类在配置的文件系统/Git 路径中维护 PWA
→ planner 登记 supervisor agent，Paseo 提供它的 Workspace affiliation
→ supervisor 使用 Paseo 默认 create_agent 参数加入 roster，创建 Task 和具名 worker
→ supervisor 必要时创建新的 Paseo Workspace，并在其中创建或迁移 worker
→ supervisor 选择 worker 并发送 Task-scoped assignment；Workspace 从 worker 的 Paseo affiliation 得到
→ worker 获得 PWA、role、Task、所属 Workspace 和可用 tools
→ worker 执行并通过 A2A 报告；运行状态沿上下级关系向上通知
→ supervisor 维护 Task 和 Activity
→ 问题形成带 action 的 Activity，按指定接收者呈现给人类或 planner
→ 人类回复追加 Activity，接收者将后续操作交给合适的 supervisor
→ supervisor 继续原 Task，必要时重新分派或并行派发工作
```

随后加入第二个 supervisor，检验两层是否复用同一套代码；再让一个 supervisor 同时维护多个 Task，检验可读 slug 和报告路由。

## 设计前必须冻结的契约

1. Agent name、aliases、role class、role、上下级关系和 Paseo affiliation 的映射。
2. `create_agent`、`create_task`、`append_activity`、`append_human_activity` 以及 Paseo-backed `create_workspace`、`send_message` 工具的输入输出与调用者解析。
3. Paseo agent/workspace facts 如何映射到 roster，创建、existing agent ID 绑定和恢复分别触发什么；Paseo 默认 create_agent 参数如何原样通过。
4. 配置的 PWA 文件如何进入新 agent、恢复 agent 和正在运行 agent 的 prompt。
5. Task schema 修改后，已有 Task 如何继续展示和编辑。
6. Agent-facing HTTP MCP gateway 如何在 endpoint 创建、agent 绑定、plugin reload 和 credential 恢复时保持 capability 与 roster 一致。

这些是模块契约，不是要提前设计通用 workflow engine。它们冻结后即可开始 plugin scaffold 和第一条纵向实现。

## 验收

- Agent 创建完成后已经有 name、role class、role、上级、Paseo affiliation、prompt context 和 tools。
- 两个 supervisor 各自维护自己的 Tasks；worker 能报告但不能因此修改不属于自己的 Task；一个 supervisor 可以从自己和直接 workers 的 affiliation 看到多个 Workspace。
- Worker 和 supervisor 状态分别主动到达上级；状态变化不会自动完成 Task。
- 人类能找到带 action 的 Activity，回复能被 planner 或指定 agent 找到并继续处理。
- 一个 supervisor 能维护多个并行 Task；重启 plugin 后，Task、责任关系和 Activity 仍可查询。
- PWA 的业务流程变化不要求修改通用状态机代码。
- 宽屏和紧凑布局都能完成项目总览、Task 详情、Agent 导航和 Activity 回复。

## 延后

- proposal 专用状态机、逐段评论、revision diff 和 discussion room；
- agent 生成 HTML 的 custom renderer；
- 完整跨 agent 权限申请、审批和申诉；
- Task 编辑向所有相关 workers 的自动广播；
- durable async 投递的完整回执和恢复协议；
- PWA Git proposal、revision activation、自动广播和 Workspace 局部 interpretation。

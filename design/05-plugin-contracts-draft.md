# Plugin Contracts：初稿

这份文档只定义 plugin 与 agent/UI 之间的最小操作面。它不定义 PR/MR workflow，也不把 PWA 中的状态值编译成固定状态机。

## Capability ownership

| 能力                                                    | 归属                         |
| ------------------------------------------------------- | ---------------------------- |
| agent、Workspace、运行状态、生命周期、原生消息          | Paseo / harness              |
| roster、Task、Activity                                  | plugin                       |
| PWA 的固定 source location、文件与 Git history          | plugin bootstrap + Git/Paseo |
| role class authorization 的粗粒度判断                   | plugin                       |
| 当前 workflow 的阶段含义、准入准出和 remote effect 规则 | PWA + agent 判断             |

`create_workspace` 和 `send_message` 直接使用 Paseo 原生能力。plugin 不为它们建立平行 store。

Agent 侧的这些 plugin-owned operations 通过注入到 Paseo agent 配置的、带 per-agent capability URL 的 Streamable HTTP MCP server 暴露；Paseo UI 侧通过同一组 shared Zod contract 调用 plugin RPC。两条入口都进入同一套 use case，不能让 UI 或 MCP 各自实现一套权限和状态逻辑。MCP gateway 用 capability token 将请求绑定到创建它的 Paseo agent，credential 与 roster 分开持久化。

## Plugin-owned operations

### `create_agent`

输入由两部分组成：

```text
Paseo create_agent options
+ local name and derived qualified name
+ aliases
+ roleClass
+ role
+ optional parent agent name
+ optional existing Paseo agent ID
```

普通创建时，Paseo options 原样透传；plugin 登记 roster 记录、组装 prompt、注入 tools，并发送首条输入。`roleClass` 只能是 planner、supervisor 或 worker；role class 和 role 创建后不可通过 `update_agent` 修改。

planner 创建 supervisor，supervisor 创建 worker。局部 name 只要求在同一个 parent 下唯一，跨 manager 的引用使用 qualified name。`create_agent` 检查 parent、role class 和当前调用上下文；worker 不能创建下级 agent。

### `update_agent`

只修改 aliases 和展示信息。它不修改 role class、role，也不改变上下级关系。

### `retire_agent`

对 roster 记录做软删除标记，保留历史引用。第一版不定义通知、运行中 agent 处理、鉴权拒绝和重新启用语义。

### `create_task`

创建一个使用可读 slug 的 Task。最小输入是 id、title、brief、supervisor 和可选的 data/status。`status` 是字符串，plugin 不验证 PWA 定义的有效值。

PWA 声明 status 的有效值、含义和软性转移约定。Supervisor 按 PWA 和工作证据推进或回退 Task；plugin 保存 status，但不编译或执行状态机。

### `update_task`

更新 Task 的项目字段、status 和 data。plugin 检查调用者的 role class、Task 管理范围和请求上下文；它不推导 status 是否符合 PWA，也不自动触发下一个阶段。

### `append_activity`

追加一个 Activity，包含 actor、Markdown 正文、结构化 data、派生引用和 action。agent 的主要写法是正文中的 Markdown link，例如 `[报告](paseo-swarm://agent/supervisor.verifier)`。Plugin 在写入时解析、校验这些 link，并保存 canonical ref；agent 不需要同时维护第二份 ref JSON。worker 不能调用此操作；supervisor、planner 和人类 UI 按各自权限写入。

`paseo-swarm://` 引用可以指向 agent、Task、Workspace 或 Workspace-relative file。UI 将已解析的 ref 渲染为 Paseo 导航或 Task 导航；无法解析的 agent、Task、Workspace 或不安全的文件引用拒绝写入，避免产生看似可点击但实际失效的链接。第一版只校验文件 ref 的 Workspace 和相对路径，不把文件内容复制进 Activity。二进制附件不是第一版 Activity 模型的一部分，文件交付先使用 file ref。

人类回复是带 `inReplyTo` 的新 Activity，不修改旧 Activity。Activity 的 action 可以由 UI 渲染成输入、批准、拒绝或选择，但这些动作的业务含义由 PWA 和接收 agent 解释。

## Read surface

Agent 至少需要读取：

- 自己的 roster 身份、直接上下级和 Workspace 视图；
- 自己管理或参与的 Task；
- Task 的 Activities；
- 按 Task、接收者筛选的 Activity。

读操作可以先按资源提供 `get/list`，不引入通用 query language。写操作使用上面的 use case，UI 和 agent tools 共享同一实现。

## Prompt assembly

Prompt assembly 是纯函数，不是 agent tool。它组合：当前 PWA source 内容、agent 的 role class/role、上下级关系、Workspace 视图、相关 Task/Activity 和可用 tools。

Role 只帮助选择 PWA 中适用的职责段落；PWA 具体决定 agent 如何循环工作、何时升级、是否允许 remote effect，以及项目状态值如何解释。

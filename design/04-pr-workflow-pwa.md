# PR Workflow PWA：样本草稿

这是一份用来检验框架表达力的 Project Working Agreement。它描述一个项目如何从调查推进到可供人类审阅的 PR/MR，不要求 plugin 认识这些阶段名称，也不把它们变成固定状态机。

## 总体约定

每个具体交付方向建立一个 Task。Task 的 `status` 使用本项目定义的字符串值：

```text
survey
development
review
mr-preparation
human-review
ready-to-merge
completed
abandoned
```

这些值是项目看板和协作语言。plugin 只保存和查询它们；supervisor 根据本 PWA 判断何时可以更新它们，planner 发现不符合约定的 Task 时负责提醒或纠正。

Task 由 supervisor 负责，worker 通过具名 agent 接收具体工作并以团队消息报告。Activity 记录 supervisor 理解后的报告、证据、问题和人类决定。

## Role class 与职责

### Planner

Planner 维护项目级方向和 supervisors。它可以看到项目范围的 Task 与 Activity，处理跨 supervisor 的依赖，选择适合的 supervisor，并检查 Task 是否遵循本 PWA。

Planner 不替 supervisor 做业务判断。它发现流程偏离时，先通过 Activity 或 A2A 提醒对应 supervisor；需要改变项目约定时，提交 PWA proposal，等待人类决定。

### Supervisor

Supervisor 维护自己管理的 Task 工作集，选择 worker、组织并行工作，并把需要人类决定的事项整理成带 action 的 Activity。

Supervisor 负责让 Task 持续推进。每次 worker 报告后，它必须阅读并理解结果、追加 Activity、更新 Task status 或 data，并决定下一步是继续工作、重新分派、请求人类输入，还是结束 Task。

### Worker

Worker 负责被分派的具体工作。它可以研究、编辑本地代码、运行测试和生成报告，但必须依据本 PWA 和当前 Task 判断自己的 scope；它不更新 Task，也不追加 Activity。

Worker 默认不得产生 remote effect，包括 push、创建或修改远程 PR/MR、undraft、approve、merge 和发布。需要这些动作时，Worker 追加 Activity 说明目标、证据和风险，交给 supervisor 或人类处理。

## 工作循环

### Survey

Supervisor 为问题建立 Task，按需要派出多个只读 Survey worker。Survey worker 只收集现有实践、约束和证据，不替项目做最终设计决定；报告必须引用来源并区分事实、推测和未解决问题。

Survey 完成后，supervisor 汇总结果，更新 Task status 和 Activity，再决定是否进入 development。没有足够证据时，Task 保持在 survey 或产生带 action 的 Activity。

### Development

Supervisor 为实现方向派出一个或多个 Development worker。Worker 可以在所属 Workspace 中修改本地文件、运行测试和形成候选变更。它应向 supervisor 报告变更范围、验证结果、未决风险和建议的下一步。

开发阶段默认不产生 remote effect。是否允许 push、创建 draft PR/MR 或更新已有 PR/MR，由当前 Task 适用的 PWA 约定和人类决定解释。

### Review

Supervisor 可以并行派出多个 Review worker。Review 可以使用不同视角，例如：

- diff correctness：实现是否符合目标，是否有明显错误；
- design review：抽象、边界和长期维护性；
- blast-radius review：回归风险、兼容性和失败影响；
- repository review：项目特定规范、测试和发布约束。

Review worker 不直接改变 Task 的最终状态，也不追加 Activity。它发送带证据的报告，由 supervisor 汇总后决定回到 development、继续 review 或进入 mr-preparation。

### MR preparation

Supervisor 或指定 worker 整理候选变更、测试证据、风险、标题和 description 草稿。description 必须从 Task 和 Activities 中提炼，不凭空补齐未验证的事实。

是否创建或更新 PR/MR、是否 undraft，以及是否需要特殊 GitLab gate，由 PWA 和人类授权路径决定。plugin 只提供 Task/Activity 记录和 Paseo/Git 工具接线，不预设 PR/MR 状态机。

### Human review

需要人类决定时，supervisor 追加带 action 的 Activity。Activity 必须包含：背景、候选动作、证据引用、风险、建议和回复后由谁继续处理。

人类回复追加新的 Activity。supervisor 阅读回复后更新 Task，并继续执行、重新 review、修订 MR preparation 或结束 Task。人类没有回复时，agent 不应假设下一步会自动到来；它应依据 PWA 继续能独立推进的工作，或明确留下待决 Activity。

### Completion

Task 只有在交付物和必要证据齐全、PWA 要求的人类决定已经完成、且没有未处理的阻塞 Activity 时，才进入 completed。abandoned 必须记录原因和后续建议。

## 项目级操作约束

模型 provider 暂不可用、特殊 GitLab 部署要求额外 gate、某类 remote effect 必须由人类执行等运行约束，应作为 PWA 的项目 operating notes。需要改变这些约束时，建立 PWA proposal Task，并通过 Activity 请求人类批准；批准后的内容进入 PWA 的 Git 历史和后续 prompt context。

PWA 可以包含有限的工作记忆，例如当前 provider routing、仓库特殊规则和最近一次人类决定。它必须写成显式、可审阅的项目约定，不把 agent transcript 当作长期记忆。

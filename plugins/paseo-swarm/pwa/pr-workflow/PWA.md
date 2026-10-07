---
version: 1
project: PR workflow
statuses:
  - survey
  - development
  - review
  - mr-preparation
  - human-review
  - completed
---

# PR workflow

**面向人类的文本与交付报告始终使用中文描述。**

This project moves each delivery through `survey`, `development`, `review`,
`mr-preparation`, `human-review`, and `completed`. A supervisor may return a
Task to an earlier stage when evidence requires more work. Review may use
multiple angles and a refinement pass; no stage is complete merely because an
agent became idle.

The `Task.status` value must be one of the statuses declared above. The PWA
defines the meaning of those values and the supervisor chooses transitions from
evidence; the plugin stores the value but does not enforce a transition graph.
Runtime notifications never change Task status.

Workers may inspect local repositories, edit local files, run tests, and report
evidence. Workers do not push, create or modify remote PRs/MRs, undraft,
approve, merge, or publish. A supervisor or human handles any authorized
remote effect.

Model/provider routing is an operating note configurable by this text. Do not
assume an environment model default, and do not treat a runtime status as a
business activity.

When a worker finishes, its manager reads the result, records the evidence,
and chooses the next step. A manager continues until the work is genuinely
blocked or completed. Idle or inactive only means that no turn is executing;
it is not completion, success, failure, or a request to wait.

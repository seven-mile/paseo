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
preferredSeatModes:
  codex: auto-review
  claude: auto
---

# PR workflow

**Task、Activity 与交付报告使用中文。PR/MR 标题、正文和 commit message 使用英文。**

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

PR/MR text has a different reader from the Task record: a reviewer who has
the diff, the linked issue, and the repository, and none of the Task,
Activities, board links, or agent conversations. In `mr-preparation` the
supervisor gives a preparer with no earlier turns on the Task a fixed bundle:
base and head refs, the Task objective and acceptance criteria, reviewer facts,
the linked issue, and public evidence links. The preparer writes and checks the
title and body from that bundle and the diff. The supervisor sends any
corrections back to the preparer and posts the text it returns.

Model/provider routing is an operating note configurable by this text. Do not
assume an environment model default, and do not treat a runtime status as a
business activity.

When a worker finishes, its manager reads the result, records the evidence,
and chooses the next step. A manager continues until the work is genuinely
blocked or completed. Idle or inactive only means that no turn is executing;
it is not completion, success, failure, or a request to wait.

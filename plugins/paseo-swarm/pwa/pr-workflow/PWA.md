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

Model/provider routing is an operating note configurable by this text. Do not
assume an environment model default, and do not treat a runtime status as a
business activity.

When a worker finishes, its manager reads the result, records the evidence,
and chooses the next step. A manager continues until the work is genuinely
blocked or completed. Idle or inactive only means that no turn is executing;
it is not completion, success, failure, or a request to wait.

## PR/MR text

The reader of a PR/MR knows the domain and reads code well, and has the diff
and the repository. They don't know the solution this change carries, and
they never see the Task, its Activities, or any agent conversation. From the
text alone, before opening the diff, they should be able to answer:

1. **Why:** what callers or users couldn't do before, and what they can do now.
2. **Parts:** the few responsibilities the change adds or alters.
3. **Collaboration:** how those parts work together.
4. **Placement:** why each part sits where it does, including any alternative
   that was rejected for a reason a reviewer would weigh.
5. **Confidence:** what the evidence shows, what nobody verified, and how to
   roll back.

If answering means tracing internal functions or looking up a term, the text
needs rewriting. A detail earns its place only by helping answer one of these
questions; the rest stays in the diff or the Task record. Small changes have
short answers.

In `mr-preparation` the supervisor writes reference answers, a preparer with no
earlier turns on the Task writes the title and body, and a reviewer who has
seen neither answers the questions from that text alone. The text is accepted
when those answers match the reference answers.

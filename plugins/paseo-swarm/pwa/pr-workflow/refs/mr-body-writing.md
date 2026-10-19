# Writing a PR/MR title and body

## What the body is for

A PR/MR asks an upstream reviewer to accept a change. The reviewer is a busy
engineer who reads code well and knows the project's common concepts, but
wasn't there while the work happened. The body makes the case for the change:
why it's needed, why it's worth having, and why the code looks the way it
does, especially where an obvious approach exists and the change doesn't take
it. The diff already shows what changed. The reasons behind it are decisions
that leave no trace in code, so the body is the only place a reviewer can find
them.

Reviewers decide within half a minute whether they understand a change. Keep
the body short enough to skim. A reviewer who has to trace internal functions
or decode unfamiliar terms before learning what the change does will review it
less carefully, or not at all.

## How to write it

- Open with the problem as a user or caller meets it, and what they can do
  after the change. The reviewer judges every later sentence against that
  opening.
- Then describe the approach. Name the function or file where the reviewer
  should look, so the text and the diff can be read side by side. When the
  change has several parts, give each a bullet that names it and states its
  job, and say in one sentence how the parts work together. Organize by part,
  never by file.
- Say why the code takes this shape when a reviewer would expect another, and
  what that costs. Take these reasons from the decisions recorded during the
  work. When nothing was weighed, say nothing: an invented rationale misleads
  a reviewer more than a missing one.
- For evidence, say what ran and what it showed, before and after where you
  have both. Add what nobody verified and how to roll back, in a line each,
  when they matter.
- Assume the project's common concepts. When the change touches a corner most
  reviewers haven't worked in, or introduces a concept of its own, add a short
  Background paragraph at the end instead of explaining inline. The main text
  stays skimmable, and the reviewer who needs the background knows where it is.
- Leave out anything the reviewer can't open or use: board and workspace
  links, local paths, intermediate commits, and the history of attempts.
- Write plain declarative sentences and state each point once. Skip words that
  only assert importance or quality, such as "critical", "robust", or
  "seamless"; the reviewer judges that from the evidence.
- When the body can't be made short without losing the reasons, the change is
  probably several changes. Raise a split with the human before compressing.

## Format

A rule in the repository's PR/MR template or contributing guide wins over
these defaults. With a template, fill its sections in order, delete its HTML
comments, and tick only the checklist items the evidence supports. Without
one, follow the shape of the examples below.

The title is one line of at most 72 characters, in the imperative, describing
the behavior change. Match the style of the base branch's recent subjects
(`git log --no-merges --format=%s -20 <base>`). When they show no clear
style, use Conventional Commits: `type(scope): summary`.

## Examples

These four changes are fictional and differ in shape on purpose. Take the
reasoning from them; the layout and domain of your change will differ.

### A bug fix whose fix sits in an unexpected place

```markdown
fix(scheduler): stop retrying jobs whose lease was revoked

When a worker loses its lease on a job, for example during a network
partition, the scheduler gives the job to another worker. The first worker's
retry loop never checks the lease, so after the partition heals both workers
run the job, and non-idempotent jobs such as invoice export run twice.

Check the lease before each retry in `RetryLoop.next()` and stop when it is
gone. The job runner looks like the natural place for this check, but it only
sees one attempt; the retry loop is the only code that decides to start
another.

- `retry_stops_after_lease_revoked` fails before the change (the job runs
  twice) and passes after.
- Existing scheduler tests pass.

Not verified: clock skew larger than the 5 s lease margin.
Rollback: revert; no data or API change.
```

Shows: the user-visible consequence, the mechanism in two sentences, why the
fix isn't where a reviewer would look first, and evidence before and after.

### A feature with several parts

```markdown
feat(export): let users cancel a running export

Large exports take up to 20 minutes and can't be stopped. A user who starts
the wrong one waits, or asks an admin to kill the worker, which also kills
other users' exports. Add a Cancel action that stops one export within a few
seconds and removes its partial file.

A cancel request travels from the API to the worker through the export's
database row:

- **API:** `POST /exports/{id}/cancel` sets `cancel_requested_at` and
  returns; the UI polls the existing status endpoint.
- **Worker:** the export loop checks the flag between batches of 1,000 rows.
  Checking every row cost 8% throughput; every batch costs under 1%.
- **Cleanup:** a stopped export reuses the failure path to delete its partial
  file and ends as `cancelled`.

The flag lives in the row because workers already read it every batch;
sending workers a message would need a new channel to each of them.

Evidence: new API and worker tests pass; a manual 2M-row export stopped 3 s
after Cancel. Not verified: cancelling during the final upload, which
completes instead of stopping. Rollback: revert; the new nullable column can
stay, and old code ignores it.
```

Shows: one sentence on how the parts connect, a bullet per part, a measured
trade-off, the alternative that was rejected, and rollback when the schema
changes.

### A build change

```markdown
build: make the PDF renderer optional

The PDF renderer pulls in a 300 MB headless browser, and every build installs
it, including the CLI package that never renders PDFs. Add
`BUILD_PDF_RENDERER`, on by default so existing builds don't change. With it
off, the build skips the renderer and `export --pdf` reports that the
renderer isn't installed.

The default build produces the same artifact list as before. With the option
off, the CLI package drops from 340 MB to 41 MB.
```

Shows: proportion. A small change gets a short body, and sections with
nothing to say are left out.

### A refactor with background

```markdown
refactor(auth): check tokens through the policy engine

Four API services each carry their own copy of the token check, and the
copies have drifted: billing accepts tokens up to a minute past expiry.
Replace the copies with the policy engine's token check, which the admin
service already uses.

Billing now rejects expired tokens like the other services. Its clients
refresh before expiry, and its logs for the last 30 days show no requests
inside that minute.

The shared token test suite now runs against all four services; billing fails
it before the change and passes after.

Background: the policy engine evaluates access rules stored as data (see
`docs/policy.md`). This change uses only its token check.
```

Shows: why the change is needed, the one behavior change stated up front with
the evidence that it's safe, and background placed at the end for the
reviewers who need it.

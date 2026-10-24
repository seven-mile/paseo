# Seats: roles that outlive their agents

A Swarm role is bound to a Paseo agent, and a Paseo agent is fragile. Its context degrades after long work, its provider can slow down, reject requests, or disappear, and some agents need a clean start. A seat separates the two, so you can put a different agent behind a role without losing the role's work or relationships.

## Model

A seat is an agent record (`AgentRecord`, keyed by its roster `id`). Its name, role class, role, reporting line, Tasks, Activities, and mailbox belong to the seat. The Paseo agent in `paseoAgentId` is the seat's current **occupant**.

Creating a seat only reserves it: `swarm_seat_create` writes the record with `paseoAgentId: null` and resolves its workspace. The first message to the seat starts its agent, through the same delivery path that replaces a stale one. Until then the seat is listed for its team but left out of `swarm.board.read`, so an app from before seats sees only seats with agents.

The seat is the spec and the occupant is a cache of it, the way a compose file relates to its containers. The seat holds desired state:

- `agentConfig`: the provider (`provider` or `provider/model`), mode, thinking option, and feature values the seat wants its agent to run. A field left out is not compared, so a seat can pin only its provider, and its agent keeps whatever model it runs.
- `generation`: bumped by a reset. A reset asks for a clean context, so no agent from before it is reused.

Each occupant carries a stamp: its number in the seat, the generation it was created for, and the config Swarm last gave it, at creation or through an in-place change. Earlier occupants keep their stamps in `pastOccupants`.

Changes made in an agent's own chat, such as picking another mode, are drift the seat tolerates. Swarm never reads them back and never reverts them on its own. A later in-place change sends only the fields the seat changed, so the chat's choice survives it; a new agent is built from the seat, so the chat's choice is gone there.

## Reconcile at delivery

When mail wakes a seat, Swarm brings the occupant in line with the seat before delivering. `planSeat` in `plugins/paseo-swarm/server/seat-policy.ts` compares the seat with the occupant's stamp and picks one of five plans:

| Plan    | When                                                                       | What happens                                      |
| ------- | -------------------------------------------------------------------------- | ------------------------------------------------- |
| start   | The seat has no agent yet                                                  | Its first agent starts                            |
| keep    | The stamp fits the seat                                                    | Mail is delivered                                 |
| adjust  | Every difference can change on the live agent without touching its context | The agent's config changes in place; same session |
| revive  | An earlier occupant of the same generation runs the seat's spec exactly    | That agent comes back with its context            |
| replace | Anything else, including a reset                                           | A new agent starts                                |

Mode, thinking, and feature values change in place. Feature values are managed per key: keys the seat names are compared and applied, and keys it leaves out, or an empty map, change nothing. A model switch changes in place only on providers known to keep a session working across models (`claude` and `codex`). A provider that routes to several vendors, such as Copilot or OpenCode, can hold content another vendor refuses, like encrypted reasoning, so a model switch there gets a new agent. Another provider always gets a new agent: a Claude Code session cannot continue in Codex.

An earlier occupant comes back only on an exact fit. Its return brief starts a turn, and a turn that ran before an in-place change would run under the old settings, such as a more permissive mode. A candidate that would need a change gets a new agent instead.

The policy is conservative: a difference it does not know to be safe gets a new agent, which costs context but never breaks a session. Rules about what a seat change costs belong in `seat-policy.ts` and nowhere else; teaching it more only turns replacements into in-place changes. `seat ls` and the app's roster show the pending plan for each seat.

Reconciling lives in mailbox delivery (`syncSeat` in `plugins/paseo-swarm/server/mailbox.ts`), which carries team messages, human Activities, and turn digests. Typing into the agent's own conversation addresses that Paseo agent directly and changes nothing about the seat. Before delivering to a seat whose plan is not keep:

1. If the occupant is mid-turn, the seat's mail is held. The occupant finishes its turn, and the turn end flushes the mailbox again. If Paseo cannot report the occupant's status, the mail is held too, since replacing an agent that may be mid-turn would cut that turn off.
2. The plan runs. A seat's first agent starts in its workspace with the standing prompt assembled from the current PWA. A replacement gets the same prompt plus a takeover brief. Swarm picks the new agent's id and holds it as arriving in the seat until the seat binds it, since Paseo builds an agent's tool catalog while its session opens; a revived agent arrives the same way while its session resumes. A revived agent gets a return brief, which also probes whether its session can resume; if the send fails, the seat gets a new agent instead. A session that accepts the brief and fails later in that turn is not caught; reset the seat.
3. Rows the old occupant was handed but never finished a turn on go back to the queue, ahead of newer mail.
4. Children whose Paseo parent is the old occupant are detached, then the old occupant is archived. Archiving cascades to Paseo children, which would take a supervisor's workers with it.
5. If the seat's `prompt.revision` differs from the standing prompt assembled now, the current one is sent first, so a PWA edit or a daemon upgrade reaches running agents without a reset. A failed refresh is logged and does not hold the mail.
6. The held mail is delivered.

If a plan fails, the head message records the error in `lastError` and stays queued without spending its send attempts, so a provider that is down for an hour does not fail the mail. Every later flush tries again. The old occupant stays bound but gets no mail.

A seat with no mail keeps its plan pending until mail arrives. A seat edit flushes the mailbox, so seats with queued mail change right away. Editing a seat back before it wakes leaves nothing pending, since config edits never move the generation.

## Config across providers

A new agent boots with the seat's `agentConfig` and nothing else (`bootConfig` in `seat-policy.ts`). A field the seat leaves out or clears gets the provider's default, never a value carried over from the previous agent. The one exception is the model: a seat that names a bare provider (`claude` for `claude/opus`) keeps the model its agent runs, since Paseo creates agents from `provider/model`. A seat made before seats existed takes what its agent runs as its spec on its first edit.

Moving a seat to another provider requires `provider/model` and a mode for the new one, since there is no predecessor on that provider to inherit them from and Paseo creates agents from `provider/model`. The edit drops the old provider's mode, thinking option, and feature values, so the new agent gets its provider's defaults for those unless the edit sets them. A model switch the policy does not know to be safe, such as another vendor behind OpenCode, drops the thinking option and feature values the same way, since those are defined per model. The check compares against the provider the occupant runs, so editing a seat back to that provider needs nothing extra. Mode names do not transfer: Claude's `auto` approves through a classifier, while Codex's `auto` asks and its classifier mode is `auto-review`; Copilot and OpenCode use other names again. Copying a name across could stall an agent or let it act without asking. The provider rejects an unsupported value when the agent is created, which shows up as the mail's `lastError`.

## Recovery

A new occupant recovers from three sources:

- **Tasks and Activities**: the shared record of what the team owns, decided, and delivered.
- **The mailbox**: the message that woke the seat, and any rows its predecessor never finished.
- **Predecessor timelines**: `swarm_transcript_list` pages an occupant's transcript, newest first, from Paseo's provider-agnostic timeline. Archived agents load for history only, so reading does not resume their sessions.

Workspace facts such as git status are not fed to the new agent. They live in the workspace, which the new agent shares, and the business record lives in Tasks and Activities.

The takeover brief tells the occupant its number, why its predecessor was replaced, that the record is the source of truth, that transcripts are claims to check, and that its first turn ends with a takeover report to its manager (or an Activity, for a planner). The return brief tells a revived occupant who held the seat meanwhile and to read its seat and Tasks before acting. Activities record `actorOccupant`, so the work of a degraded occupant can be found after the fact.

A new occupant starts a new provider session, so no conversation state carries over. A provider that encrypts reasoning content cannot poison its successor on another provider.

## Interfaces

People and operators manage seats through plugin RPCs; agents work through daemon tools that call the same plugin:

| RPC                       | CLI                              | Agent tool                           |
| ------------------------- | -------------------------------- | ------------------------------------ |
| `swarm.seat.create`       |                                  | `swarm_seat_create`                  |
| `swarm.seat.list`         | `paseo-swarm swarm seat ls`      | `swarm_seat_list`, `swarm_seat_read` |
| `swarm.seat.update`       | `paseo-swarm swarm seat set`     |                                      |
| `swarm.seat.reset`        | `paseo-swarm swarm seat reset`   |                                      |
| `swarm.seat.history.read` | `paseo-swarm swarm seat history` | `swarm_transcript_list`              |

`create` requires both `provider` (`provider/model`) and a provider-native `modeId`; `update` rejects a `provider` without a `modeId` in the same request. Neither reinterprets `default` or `auto`.

`update` and `reset` take several seats and a `dryRun` flag, and return each seat with its pending plan as `pending: { kind, reason } | null`, so `--json` and `--dry-run` show whether the next mail starts, adjusts, revives, or replaces. A field set to `null` in `update` stops being compared. `reset --cancel` withdraws a reset that has not taken effect. In-place changes go through the agent handle's `applyConfig` in the Paseo client SDK.

Agents read transcripts for their own seat and the seats under them; planners read any seat. Agents cannot edit seats in this version.

### Agent tools

The agent tools live in `packages/server/src/server/agent/tools/paseo-tools.ts` and share one shape, so an agent that learns one can guess the rest:

- Names are `swarm_<noun>_<verb>`. `list` returns a page and `read` returns one item. Nouns: `seat`, `role`, `task`, `activity`, `transcript`, `message`, `prompt`.
- Tools take and return seat names, Task ids, and Activity ids. A local name reaches only your manager, reports, and teammates; any other seat takes its qualified name, so a name never resolves to an unrelated seat that happens to be unique. Omitting the seat means your own. No Swarm tool takes or returns a Paseo agent id, so an agent cannot address an occupant past its seat.
- Every list takes `limit` (default 20, at most 50) and `cursor`, and returns `{ items, total, nextCursor }`. `total` is null where it is unknown, as for transcripts. Lists run newest first, except seats, which run in roster order.
- Activity lists carry a body preview; `swarm_activity_read` has the full body.

Every occupant can read seats, Tasks, Activities, and transcripts, send messages, and refresh its prompt. Planners and supervisors also list roles, create seats and Tasks, update Tasks, and append Activities. Occupants get native Paseo tools from an allowlist (`seatToolAllowed` in `packages/server/src/server/agent/tools/swarm-context.ts`), applied after the provider's tool policy: terminals, workspace scripts, and browser tools for everyone, and workspace placement and provider listing for managers. Tools that create or drive agents, heartbeats, and schedules stay out, since an agent they create has no seat, and an agent they drive or a prompt they schedule skips the mailbox. A native tool added later stays out until it is listed. If the daemon cannot look up an agent's seat and the agent carries the `paseo-swarm.seat` label Swarm puts on every agent it starts, the agent gets a worker's native tools and no Swarm tools. The standing prompt names harness subagent tools as outside Swarm, since the daemon cannot hide them.

## Example: moving a swarm from provider A to provider B

1. `paseo-swarm swarm seat ls` shows every seat with what it wants, what Swarm last gave its agent, and the pending plan.
2. `paseo-swarm swarm seat set <seats...> --provider b/<model> --mode <b-mode> --dry-run` shows what each seat would do and why. Add `--thinking` to pick B's thinking option. Drop `--dry-run` to apply.
3. Seats with queued mail switch at once. Each other seat switches at its next mailbox delivery, after its current turn. Supervisors and workers switch independently, and a manager learns of a worker's takeover from the worker's takeover report.
4. If provider B misbehaves, `seat set` back to `a/<model> --mode <a-mode>`. Seats that have not woken yet were never touched and keep their A agent. Seats that already switched bring their A agent back, with its context, at their next delivery, when the A spec matches what that agent ran. Otherwise, or if the A agent cannot resume, they get a new one.

## Decisions

- **The seat is the spec.** The seat's config does not depend on any agent existing; the occupant is a cache of it. Reading the live agent back into the seat would make the agent the store of the seat's state.
- **Chat changes are drift.** Like a compose file, the seat does not chase changes made inside its container. Changing the seat is how a change persists across agents.
- **Lazy, at delivery.** Changing an agent at the moment of edit would interrupt running turns or race them. At delivery, the occupant is idle by construction, and the edit stays reversible until then.
- **One conservative policy.** What a change costs is decided in one file, defaulting to a new agent. A wrong "in place" breaks a session; a wrong "new agent" only loses context, which the transcript and the board recover.
- **Mailbox only.** Native sends to an agent stay as they are; routing them through seats is a larger change to how the app addresses agents.
- **No batch, rollback, or freeze.** A bulk edit is many seat edits. Reverting is another edit, and the revive plan makes it cheap. Holding mail while an occupant is mid-turn is the only pause the model needs.
- **Per-seat config, not a swarm-wide policy.** A swarm-wide runtime policy hardwires which settings exist. Desired state per seat lets a person or an operator agent express any policy as seat edits.
- **Workers are not special.** A worker seat keeps its name, Task membership, and mailbox the same way a supervisor does.
- **No Paseo fork.** Forking copies the degraded context. The new occupant starts clean and reads the old transcript when it needs to.
- **Seat first.** A seat exists before any agent and its first message starts one, so creating a seat and replacing its agent are one path. The manager's first message is the assignment; there is no separate start step to teach.
- **No Paseo parents.** The roster is Swarm's hierarchy, so Swarm agents start without a Paseo parent, and archiving a supervisor's agent never cascades to its workers. Agents created before seat-first creation keep their parent until replaced; a replaced supervisor's workers are detached.
- **Prompt refresh at delivery.** A stale standing prompt is replaced at the next delivery instead of by a reset, which would cost the agent its context.

## Later

- A seat view that joins its occupants' timelines.
- Seat editing in the app (set and reset), beside the pending label.
- Showing drift: what the agent runs next to what Swarm gave it, and a way to adopt the agent's config into the seat.
- More policy: reset after repeated failures.
- Reviving an earlier occupant that needs an in-place change, once a change can be applied before its first resumed turn.
- Seat edits (set and reset) as agent tools, so an operator agent can manage seats on a person's behalf.
- Waking a seat with no mail, for people who want a change to happen now.

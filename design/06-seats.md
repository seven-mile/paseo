# Seats: roles that outlive their agents

A Swarm role is bound to a Paseo agent, and a Paseo agent is fragile. Its context degrades after long work, its provider can slow down, reject requests, or disappear, and some agents need a clean start. A seat separates the two, so you can put a different agent behind a role without losing the role's work or relationships.

## Model

A seat is an agent record (`AgentRecord`, keyed by its roster `id`). Its name, role class, role, reporting line, Tasks, Activities, and mailbox belong to the seat. The Paseo agent in `paseoAgentId` is the seat's current **occupant**.

The seat is the spec and the occupant is a cache of it, the way a compose file relates to its containers. The seat holds desired state:

- `agentConfig`: the provider (`provider` or `provider/model`), mode, thinking option, and feature values the seat wants its agent to run. A field left out is not compared, so a seat can pin only its provider, and its agent keeps whatever model it runs.
- `generation`: bumped by a reset. A reset asks for a clean context, so no agent from before it is reused.

Each occupant carries a stamp: its number in the seat, the generation it was created for, and the config Swarm last gave it, at creation or through an in-place change. Earlier occupants keep their stamps in `pastOccupants`.

Changes made in an agent's own chat, such as picking another mode, are drift the seat tolerates. Swarm never reads them back and never reverts them on its own. A later in-place change sends only the fields the seat changed, so the chat's choice survives it; a new agent is built from the seat, so the chat's choice is gone there.

## Reconcile at delivery

When mail wakes a seat, Swarm brings the occupant in line with the seat before delivering. `planSeat` in `plugins/paseo-swarm/server/seat-policy.ts` compares the seat with the occupant's stamp and picks one of four plans:

| Plan    | When                                                                           | What happens                                      |
| ------- | ------------------------------------------------------------------------------ | ------------------------------------------------- |
| keep    | The stamp fits the seat                                                        | Mail is delivered                                 |
| adjust  | Every difference can change on the live agent without touching its context     | The agent's config changes in place; same session |
| revive  | An earlier occupant of the same generation fits, give or take in-place changes | That agent comes back with its context            |
| replace | Anything else, including a reset                                               | A new agent starts                                |

Mode, thinking, and feature values change in place. A model switch changes in place only on providers known to keep a session working across models (`claude` and `codex`). A provider that routes to several vendors, such as Copilot or OpenCode, can hold content another vendor refuses, like encrypted reasoning, so a model switch there gets a new agent. Another provider always gets a new agent: a Claude Code session cannot continue in Codex.

The policy is conservative: a difference it does not know to be safe gets a new agent, which costs context but never breaks a session. Rules about what a seat change costs belong in `seat-policy.ts` and nowhere else; teaching it more only turns replacements into in-place changes. `seat ls` and the app's roster show the pending plan for each seat.

Reconciling lives in mailbox delivery (`syncSeat` in `plugins/paseo-swarm/server/mailbox.ts`), which carries team messages, human Activities, and turn digests. Typing into the agent's own conversation addresses that Paseo agent directly and changes nothing about the seat. Before delivering to a seat whose plan is not keep:

1. If the occupant is mid-turn, the seat's mail is held. The occupant finishes its turn, and the turn end flushes the mailbox again. If Paseo cannot report the occupant's status, the mail is held too, since replacing an agent that may be mid-turn would cut that turn off.
2. The plan runs. A new agent starts in the seat's workspace with the role prompt assembled from the current PWA and a takeover brief. A revived agent gets a return brief, which also probes whether its session can resume; if the send fails, the seat gets a new agent instead.
3. Rows the old occupant was handed but never finished a turn on go back to the queue, ahead of newer mail.
4. Children whose Paseo parent is the old occupant are detached, then the old occupant is archived. Archiving cascades to Paseo children, which would take a supervisor's workers with it.
5. The held mail is delivered. A revived agent that still needs in-place changes gets them after its return turn, then the mail.

If a plan fails, the head message records the error in `lastError` and stays queued without spending its send attempts, so a provider that is down for an hour does not fail the mail. Every later flush tries again. The old occupant stays bound but gets no mail.

A seat with no mail keeps its plan pending until mail arrives. A seat edit flushes the mailbox, so seats with queued mail change right away. Editing a seat back before it wakes leaves nothing pending, since config edits never move the generation.

## Config across providers

A new agent boots with the seat's `agentConfig`. Within one provider (`claude` and `claude/opus` are one provider), fields the seat leaves out come from the previous occupant's stamp, so a reset keeps the mode and thinking option. Across providers nothing is inherited: modes, thinking options, and feature values are defined per provider.

Moving a seat to another provider requires `provider/model` and a mode for the new one, since there is no predecessor on that provider to inherit them from and Paseo creates agents from `provider/model`. The edit drops the old provider's thinking option and feature values, so the new agent gets its provider's defaults for those unless the edit sets them. The check compares against the provider the occupant runs, so editing a seat back to that provider needs nothing extra. Mode names do not transfer: Claude's `auto` approves through a classifier, while Codex's `auto` asks and its classifier mode is `auto-review`; Copilot and OpenCode use other names again. Copying a name across could stall an agent or let it act without asking. The provider rejects an unsupported value when the agent is created, which shows up as the mail's `lastError`.

## Recovery

A new occupant recovers from three sources:

- **Tasks and Activities**: the shared record of what the team owns, decided, and delivered.
- **The mailbox**: the message that woke the seat, and any rows its predecessor never finished.
- **Predecessor timelines**: `swarm_seat_history_read` pages an earlier occupant's transcript, newest first, from Paseo's provider-agnostic timeline. Archived agents load for history only, so reading does not resume their sessions.

Workspace facts such as git status are not fed to the new agent. They live in the workspace, which the new agent shares, and the business record lives in Tasks and Activities.

The takeover brief tells the occupant its number, why its predecessor was replaced, that the board is the source of truth, that transcripts are claims to check, and that its first turn ends with a takeover report to its manager (or an Activity, for a planner). The return brief tells a revived occupant who held the seat meanwhile and to read the board before acting. Activities record `actorOccupant`, so the work of a degraded occupant can be found after the fact.

A new occupant starts a new provider session, so no conversation state carries over. A provider that encrypts reasoning content cannot poison its successor on another provider.

## Interfaces

One set of plugin RPCs serves every front end:

| RPC                       | CLI                              | Agent tool                 |
| ------------------------- | -------------------------------- | -------------------------- |
| `swarm.seat.list`         | `paseo-swarm swarm seat ls`      | (board read shows `stale`) |
| `swarm.seat.update`       | `paseo-swarm swarm seat set`     |                            |
| `swarm.seat.reset`        | `paseo-swarm swarm seat reset`   |                            |
| `swarm.seat.history.read` | `paseo-swarm swarm seat history` | `swarm_seat_history_read`  |

`update` and `reset` take several seats and a `dryRun` flag, and return each seat with its pending plan in `stale`. A field set to `null` in `update` stops being compared. `reset --cancel` withdraws a reset that has not taken effect. In-place changes go through the agent handle's `applyConfig` in the Paseo client SDK.

Agents read history for their own seat and the seats under them; planners read any seat. Agents cannot edit seats in this version.

## Example: moving a swarm from provider A to provider B

1. `paseo-swarm swarm seat ls` shows every seat with what it wants, what Swarm last gave its agent, and the pending plan.
2. `paseo-swarm swarm seat set <seats...> --provider b/<model> --mode <b-mode> --dry-run` shows what each seat would do and why. Add `--thinking` to pick B's thinking option. Drop `--dry-run` to apply.
3. Seats with queued mail switch at once. Each other seat switches at its next mailbox delivery, after its current turn. Supervisors and workers switch independently, and a manager learns of a worker's takeover from the worker's takeover report.
4. If provider B misbehaves, `seat set` back to `a/<model> --mode <a-mode>`. Seats that have not woken yet were never touched and keep their A agent. Seats that already switched bring their A agent back, with its context, at their next delivery. A seat whose A agent cannot resume gets a new one.

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
- **Replacements have no Paseo parent.** Created agents still get one, for the app's subagent track. A replaced supervisor's workers are detached rather than archived with it.

## Later

- Seats before agents: a seat created without an agent, which materializes one on its first mail, and a seat view that joins its occupants' timelines.
- Seat editing in the app (set and reset), beside the pending label.
- Showing drift: what the agent runs next to what Swarm gave it, and a way to adopt the agent's config into the seat.
- More policy: reset when the assembled role prompt changes, and reset after repeated failures.
- Seat RPCs as agent tools, so an operator agent can manage seats on a person's behalf.
- Waking a seat with no mail, for people who want a change to happen now.

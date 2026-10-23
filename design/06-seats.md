# Seats: roles that outlive their agents

A Swarm role is bound to a Paseo agent, and a Paseo agent is fragile. Its context degrades after long work, its provider can slow down, reject requests, or disappear, and some agents need a clean start. A seat separates the two, so you can put a different agent behind a role without losing the role's work or relationships.

## Model

A seat is an agent record (`AgentRecord`, keyed by its roster `id`). Its name, role class, role, reporting line, Tasks, Activities, and mailbox belong to the seat. The Paseo agent in `paseoAgentId` is the seat's current **occupant**.

A seat holds desired state:

- `agentConfig`: the provider (`provider` or `provider/model`), mode, thinking option, and feature values the seat wants its agent to run. A field left out is not compared, so a seat can pin only its provider, and a replacement keeps the model its predecessor ran.
- `generation`: bumped by a reset.

The occupant carries a stamp of what it booted with: its number in the seat, its config, and the generation it was created for. An occupant is **stale** when its stamp no longer matches the seat (`occupantStaleReason` in `plugins/paseo-swarm/shared/models.ts`). Staleness is computed, never stored. Only a reset moves the generation; config edits never do. So editing a seat back before it wakes makes it current again, with nothing replaced and nothing to undo, and the agent keeps its context.

## The rule

Swarm never delivers mail to a stale occupant. The seat's next Swarm mailbox delivery boots a fresh occupant first.

The rule lives in mailbox delivery (`syncSeat` in `plugins/paseo-swarm/server/mailbox.ts`), which carries team messages, human Activities, and turn digests. Someone typing into the stale agent's own conversation addresses that Paseo agent directly: it skips the mailbox, wakes the old agent, and does not replace it. Before delivering to a seat whose occupant is stale:

1. If the occupant is mid-turn, the seat's mail is held. The occupant finishes its turn, and the turn end flushes the mailbox again. If Paseo cannot report the occupant's status, the mail is held too, since replacing an agent that may be mid-turn would cut that turn off.
2. Otherwise Swarm creates a new Paseo agent in the seat's workspace, with the role prompt assembled from the current PWA and a takeover brief, then rebinds the seat to it.
3. Rows the old occupant was handed but never finished a turn on go back to the queue, ahead of newer mail.
4. Children whose Paseo parent is the old occupant are detached, then the old occupant is archived. Archiving cascades to Paseo children, which would take a supervisor's workers with it.
5. The held mail is delivered to the new occupant, which starts its first turn.

If creating the new agent fails, the head message records the error in `lastError` and stays queued without spending its send attempts, so a provider that is down for an hour does not fail the mail. Every later flush tries again. The old occupant stays bound but gets no mail.

A seat with no mail stays stale until mail arrives. A seat edit flushes the mailbox, so seats with queued mail switch right away.

## Config across providers

A replacement boots with the seat's `agentConfig`. Within one provider (`claude` and `claude/opus` are one provider), fields the seat leaves out come from what the previous occupant ran, so a reset keeps the mode and thinking option. Across providers nothing is inherited: modes, thinking options, and feature values are defined per provider.

Moving a seat to another provider requires `provider/model` and a mode for the new one, since there is no predecessor on that provider to inherit them from and Paseo creates agents from `provider/model`. The edit drops the old provider's thinking option and feature values, so the new agent gets its provider's defaults for those unless the edit sets them. The check compares against the provider the occupant runs, so editing a seat back to that provider needs nothing extra. Mode names do not transfer: Claude's `auto` approves through a classifier, while Codex's `auto` asks and its classifier mode is `auto-review`; Copilot and OpenCode use other names again. Copying a name across could stall an agent or let it act without asking. The provider rejects an unsupported value when the agent is created, which shows up as the mail's `lastError`.

## Recovery

A new occupant recovers from three sources:

- **Tasks and Activities**: the shared record of what the team owns, decided, and delivered.
- **The mailbox**: the message that woke the seat, and any rows its predecessor never finished.
- **Predecessor timelines**: `swarm_seat_history_read` pages an earlier occupant's transcript, newest first, from Paseo's provider-agnostic timeline. Archived agents load for history only, so reading does not resume their sessions.

Workspace facts such as git status are not fed to the new agent. They live in the workspace, which the new agent shares, and the business record lives in Tasks and Activities.

The takeover brief tells the occupant its number, why its predecessor was replaced, that the board is the source of truth, that transcripts are claims to check, and that its first turn ends with a takeover report to its manager (or an Activity, for a planner). Activities record `actorOccupant`, so the work of a degraded occupant can be found after the fact.

Because each occupant starts a new provider session, no conversation state carries over. A provider that encrypts reasoning content cannot poison its successor on another provider.

## Interfaces

One set of plugin RPCs serves every front end:

| RPC                       | CLI                              | Agent tool                 |
| ------------------------- | -------------------------------- | -------------------------- |
| `swarm.seat.list`         | `paseo-swarm swarm seat ls`      | (board read shows `stale`) |
| `swarm.seat.update`       | `paseo-swarm swarm seat set`     |                            |
| `swarm.seat.reset`        | `paseo-swarm swarm seat reset`   |                            |
| `swarm.seat.history.read` | `paseo-swarm swarm seat history` | `swarm_seat_history_read`  |

`update` and `reset` take several seats and a `dryRun` flag, and return each seat with its computed staleness. A field set to `null` in `update` stops being compared. `reset --cancel` withdraws a reset that has not taken effect. The app's roster shows a stale seat's reason.

Agents read history for their own seat and the seats under them; planners read any seat. Agents cannot edit seats in this version.

## Example: moving a swarm from provider A to provider B

1. `paseo-swarm swarm seat ls` shows every seat with what it wants and what it runs.
2. `paseo-swarm swarm seat set <seats...> --provider b/<model> --mode <b-mode> --dry-run` shows which seats would be replaced and why. Add `--thinking` to pick B's thinking option. Drop `--dry-run` to apply.
3. Seats with queued mail switch at once. Each other seat switches before its next mailbox delivery, after its current turn. Supervisors and workers switch independently, and a manager learns of a worker's takeover from the worker's takeover report.
4. If provider B misbehaves, `seat set` back to `a/<model> --mode <a-mode>`. Seats that have not woken yet were never touched and keep their A agent and its context. Seats that already switched get a fresh A agent before their next delivery, which is the same operation, not a rollback.

## Decisions

- **Lazy, at delivery.** Replacing at the moment of edit would interrupt running turns or race them. At delivery, the old occupant is idle by construction, and the edit stays reversible until then.
- **Mailbox only.** Native sends to an agent stay as they are; routing them through seats is a larger change to how the app addresses agents.
- **No batch, rollback, or freeze.** A bulk edit is many seat edits. Reverting is another edit. Holding mail while an occupant is mid-turn is the only pause the model needs.
- **Per-seat config, not a swarm-wide policy.** A swarm-wide runtime policy hardwires which settings exist. Desired state per seat lets a person or an operator agent express any policy as seat edits.
- **Workers are not special.** A worker seat keeps its name, Task membership, and mailbox the same way a supervisor does.
- **No Paseo fork.** Forking copies the degraded context. The new occupant starts clean and reads the old transcript when it needs to.
- **Replacements have no Paseo parent.** Created agents still get one, for the app's subagent track. Re-parenting a replacement under the manager's current occupant is a follow-up.

## Later

- Seat editing in the app (set and reset), beside the stale label.
- Seat RPCs as agent tools, so an operator agent can manage seats on a person's behalf; a watchdog that marks seats stale from provider health builds on the same edits.
- Waking a stale seat with no mail, for people who want a switch to happen now.

# Seats: roles that outlive their agents

A Swarm role is bound to a Paseo agent, and a Paseo agent is fragile. Its context degrades after long work, its provider can slow down, reject requests, or disappear, and some agents need a clean start. A seat separates the two, so you can put a different agent behind a role without losing the role's work or relationships.

## Model

A seat is an agent record (`AgentRecord`, keyed by its roster `id`). Its name, role class, role, reporting line, Tasks, Activities, and mailbox belong to the seat. The Paseo agent in `paseoAgentId` is the seat's current **occupant**.

A seat holds desired state:

- `agentConfig`: the provider (`provider` or `provider/model`), mode, thinking option, and feature values the seat wants its agent to run. A field left out is not compared, so a seat can pin only its provider.
- `generation`: bumped by a reset.

The occupant carries a stamp of what it booted with: its number in the seat, its config, and the generation it was created for. An occupant is **stale** when its stamp no longer matches the seat (`occupantStaleReason` in `plugins/paseo-swarm/shared/models.ts`). Staleness is computed, never stored. Editing a seat back before it wakes makes it current again, with nothing replaced and nothing to undo.

## The rule

A stale occupant is never woken again. The seat's next wake boots a fresh occupant.

Mail is what wakes a seat, so the rule lives in mailbox delivery (`syncSeat` in `plugins/paseo-swarm/server/mailbox.ts`). Before delivering to a seat whose occupant is stale:

1. If the occupant is mid-turn, the seat's mail is held. The occupant finishes its turn, and the turn end flushes the mailbox again.
2. Otherwise Swarm creates a new Paseo agent in the seat's workspace, with the role prompt assembled from the current PWA and a takeover brief, then rebinds the seat to it.
3. Rows the old occupant was handed but never finished a turn on go back to the queue, ahead of newer mail.
4. Children whose Paseo parent is the old occupant are detached, then the old occupant is archived. Archiving cascades to Paseo children, which would take a supervisor's workers with it.
5. The held mail is delivered to the new occupant, which starts its first turn.

If creating the new agent fails, the head message records the error and stays queued like any failed send, and the old occupant stays bound but is still not woken.

A seat with no mail stays stale until something wakes it. A seat edit flushes the mailbox, so seats with queued mail switch right away.

## Recovery

A new occupant recovers from three sources:

- **Tasks and Activities**: the shared record of what the team owns, decided, and delivered.
- **The mailbox**: the message that woke the seat, and any rows its predecessor never finished.
- **Predecessor timelines**: `swarm_seat_history_read` pages an earlier occupant's transcript, newest first, from Paseo's provider-agnostic timeline. Archived agents load for history only, so reading does not resume their sessions.

Workspace facts such as git status are not fed to the new agent. They live in the workspace, which the new agent shares, and the business record lives in Tasks and Activities.

The takeover brief tells the occupant its number, why its predecessor was replaced, that the board is the source of truth, that transcripts are claims to check, and that its first turn ends with a takeover report to its manager (or an Activity, for a planner). Activities record `actorOccupant`, so the work of a degraded occupant can be found after the fact.

Because each occupant starts a new provider session, nothing provider-specific carries over. A provider that encrypts reasoning content cannot poison its successor on another provider.

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
2. `paseo-swarm swarm seat set <seats...> --provider b --dry-run` shows which seats would be replaced and why. Drop `--dry-run` to apply.
3. Seats with queued mail switch at once. Each other seat switches on its next message, after its current turn. Supervisors and workers switch independently, and a manager learns of a worker's takeover from the worker's takeover report.
4. If provider B misbehaves, `seat set` back to `a`. Seats that have not woken yet were never touched. Seats that already switched get a fresh A agent on their next wake, which is the same operation, not a rollback.

## Decisions

- **Lazy, at wake.** Replacing at the moment of edit would interrupt running turns or race them. At wake, the old occupant is idle by construction, and the edit stays reversible until then.
- **No batch, rollback, or freeze.** A bulk edit is many seat edits. Reverting is another edit. Holding mail while an occupant is mid-turn is the only pause the model needs.
- **Per-seat config, not a swarm-wide policy.** A swarm-wide runtime policy hardwires which settings exist. Desired state per seat lets a person or an operator agent express any policy as seat edits.
- **Workers are not special.** A worker seat keeps its name, Task membership, and mailbox the same way a supervisor does.
- **No Paseo fork.** Forking copies the degraded context. The new occupant starts clean and reads the old transcript when it needs to.
- **Replacements have no Paseo parent.** Created agents still get one, for the app's subagent track. Re-parenting a replacement under the manager's current occupant is a follow-up.

## Later

- Seat editing in the app (set and reset), beside the stale label.
- Seat RPCs as agent tools, so an operator agent can manage seats on a person's behalf; a watchdog that marks seats stale from provider health builds on the same edits.
- Waking a stale seat with no mail, for people who want a switch to happen now.

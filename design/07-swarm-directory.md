# Swarm directory: the spec a swarm runs

A swarm is a directory that describes a team: `swarm.yaml` for the roster, `PWA.md` for the agreement, and `roles/` for the roles. It attaches to one Paseo project. Its identity is an id the daemon mints (`plugins/paseo-swarm/server/swarms.ts`); the path only locates it. Seat names and Task ids are unique within a swarm, so two swarms can both have a `lead` and a Task `fix-login`.

## Two stages

Editing the directory changes nothing by itself. A swarm runs what it last **accepted**:

1. **Roster reconciliation** is eager and explicit. `paseo-swarm swarm up` validates the whole directory, then commits the seats it describes and the PWA files in one store commit. It never starts, refreshes, replaces, or messages an agent. `paseo-swarm swarm diff` shows the same plan without committing it.
2. **Occupant reconciliation** is lazy. A seat's next mail brings its agent in line with the accepted seat, as after any seat edit; see [seats](06-seats.md#reconcile-at-delivery). A reserved seat gets its first agent on its first mail.

`paseo-swarm swarm status` shows both: changes in the directory that are not accepted yet, and the work each seat's next mail carries out. A daemon restart never accepts the directory.

The accepted PWA files live in the swarm record (`source`), since prompts cannot be rebuilt from seat records. Only `up` advances it, and only the latest accepted copy is kept. Prompts, role lists, and board statuses read that copy, so a half-written role file never reaches an agent.

## swarm.yaml

```yaml
version: 1
seats:
  planner:
    role: planner
    agent: { provider: claude/opus }
    team:
      lead:
        role: supervisor
        agent: { provider: claude/opus, modeId: plan }
        team:
          dev: { role: developer, agent: { provider: codex/gpt-6 } } # lead.dev
```

- Nesting under `team` is the reporting line, so a seat's key path is its qualified name.
- `role` names a file in `roles/`; the role class comes from that file.
- `agent` is the seat's agent config. A field left out is not compared.
- A planner's team holds supervisors, and a supervisor's team holds workers. A worker has no team.
- The file never holds an occupant, a workspace, a Paseo agent id, or a project. Those are local bindings that stay in the daemon.
- Unknown keys are refused. `workspaces` is refused until workspace groups exist.

A directory without `swarm.yaml` gets one written from the accepted seats on the first `diff`, `up`, `status`, or seat change. That is the only time Swarm generates the whole file; accepted state is the whole truth while no file exists. After that, Swarm writes only the sections seat tools change. A template that carries a `swarm.yaml` passes it to new swarms unaccepted, so the first `up` reserves its seats.

## What up does

Seats match by qualified name only. The plan (`planRoster` in `plugins/paseo-swarm/server/roster.ts`) has five parts:

| Part    | When                                      | What happens                                                                                      |
| ------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------- |
| reserve | The file names a seat the swarm never had | A reserved seat; its first mail starts an agent and places it                                     |
| update  | A seat's role or agent differs            | The seat changes; its agent follows at its next mail                                              |
| restore | The file names a retired seat again       | That seat comes back with its Tasks, mailbox, and occupants                                       |
| retire  | An active seat is missing from the file   | The seat retires; its queued mail fails with the reason and stays readable                        |
| source  | A file in `PWA.md` or `roles/` changed    | The new files are accepted; occupants whose standing prompt changes get it before their next mail |

A rename or a move is a retirement plus a new seat. The plan lists the Tasks that name a retiring seat but does not judge them: Swarm gives Task statuses no meaning.

`up` refuses, and changes nothing, when:

- a seat would change role class. An agent's tools come from its role class when its session opens, so a prompt cannot change them. Give the new role a new seat name.
- a retirement would leave an active seat reporting to a retired one.
- the directory cannot run: a missing role, a bad file, a team the rules above forbid, or a new seat without `provider/model`.

Retiring leaves the occupant and its workspace as they are, so a restore can bring the agent back. A retired seat's agent loses its Swarm tools at its next call, since the daemon looks up the caller's seat on each one.

A seat that `up` reserved has no workspace until its first agent starts. A worker then shares its manager's workspace; any other seat gets a new workspace at the project root.

## Seat tools

A seat comes from one of two places: you name it in `swarm.yaml` and run `up`, or a seat's agent hires it with `swarm_seat_create`. Both check the same rules, and both give the seat the `agent` block its first agent starts from. The app creates no seats. It sends your message to a seat through its mailbox (`swarm.message.send`), and that message starts a seat's first agent.

Seat tools change `swarm.yaml` and the accepted seats together, so the next `up` has nothing of theirs to undo. That covers a hire (`swarm_seat_create`), an agent change (`paseo-swarm swarm seat set`), and `paseo-swarm swarm seat retire`. A reset changes local bindings only and leaves the file alone. The steps are in `mutateSpec` in `plugins/paseo-swarm/server/spec.ts`.

A change checks only the section it writes against what the swarm accepted. Edits you have not run `up` on elsewhere in the file do not block it:

| Change | Section                     | Conflicts when the file                                 |
| ------ | --------------------------- | ------------------------------------------------------- |
| hire   | the manager and the new key | no longer names the manager, or already names the seat  |
| agent  | the seat's `agent` block    | has an `agent` block that differs from the accepted one |
| retire | the seat                    | changed its `role` or `agent`, or names seats under it  |

A conflict changes nothing and names the section. Run `up` to accept the file, or undo the edit, then try again. The file is written through the `yaml` Document API, so comments and key order survive.

A retirement is refused while the seat has an active team, as in `up`. An agent retires the seats that report to it; a planner retires any seat.

### Crash recovery

Before writing the file, Swarm commits an intent with the file's hash before and after the change. The accepted change and the cleared intent are one commit. An intent left by a crash is settled at the next start or seat change:

- The file has the new hash: the change is accepted.
- The file has the old hash: the change is dropped, and the tool call that made it failed.
- The file has neither, because it was edited by hand meanwhile: Swarm cannot tell whether the change was saved. `status` shows it, and seat changes and `up` are refused until `paseo-swarm swarm recover --keep-file` drops the change or `--apply-intent` writes it into the file as it now stands and accepts it.

## Migration from before swarms

Records from before swarms get a swarm at plugin start, before any request or hook runs:

- Each project's seats join a swarm instantiated from the PWA directory that project used. The copy goes to `$PASEO_HOME/swarms/<name>-<id>/`, and the chosen directory, which can be a bundled template or one several projects share, is never written.
- Tasks follow their manager's seat, and Activities their Task. Mail is scoped through its recipient seat.
- A record whose reference leads to no swarm, or to several, keeps none and is listed in `plugin-data/paseo-swarm/migration-report.json`.

The copy is byte-identical, so prompt revisions stay valid and no agent is woken. Running it again changes nothing.

## Later

- A `swarm_seat_retire` agent tool. Retirement is CLI-only for now.
- Named workspace groups in `swarm.yaml`.
- Several swarms in one project, `init` from a template, and moving a swarm's directory.

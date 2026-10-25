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

A directory without `swarm.yaml` gets one written from the accepted seats on the first `diff`, `up`, or `status`. That is the only time Swarm writes the file; accepted state is the whole truth while no file exists. A template that carries a `swarm.yaml` passes it to new swarms unaccepted, so the first `up` reserves its seats.

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

## Migration from before swarms

Records from before swarms get a swarm at plugin start, before any request or hook runs:

- Each project's seats join a swarm instantiated from the PWA directory that project used. The copy goes to `$PASEO_HOME/swarms/<name>-<id>/`, and the chosen directory, which can be a bundled template or one several projects share, is never written.
- Tasks follow their manager's seat, and Activities their Task. Mail is scoped through its recipient seat.
- A record whose reference leads to no swarm, or to several, keeps none and is listed in `plugin-data/paseo-swarm/migration-report.json`.

The copy is byte-identical, so prompt revisions stay valid and no agent is woken. Running it again changes nothing.

## Later

- Seat tools (`swarm_seat_create` and the CLI's `seat set`) write `swarm.yaml` as part of their change, with a conflict check and crash recovery. Until then a hire writes only daemon state, and the next `up` plans to retire it.
- Named workspace groups in `swarm.yaml`.
- Several swarms in one project, `init` from a template, and moving a swarm's directory.

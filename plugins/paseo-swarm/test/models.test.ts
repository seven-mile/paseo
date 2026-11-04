import { strict as assert } from "node:assert";
import { test } from "node:test";
import { handoverLog, stateSchema } from "../shared/models";

test("state parsing drops legacy executions, preserves old Activities, and starts an empty mailbox", () => {
  const state = stateSchema.parse({
    version: 1,
    agents: [],
    tasks: [
      {
        id: "survey-auth",
        swarmId: "swarm",
        title: "Survey",
        brief: "Collect evidence",
        status: "survey",
        managerName: "lead",
        workerNames: ["verifier"],
        createdBy: "lead",
        data: {},
        createdAt: "2026-10-05T00:00:00.000Z",
        updatedAt: "2026-10-05T00:00:00.000Z",
      },
    ],
    executions: [
      {
        id: "legacy-run",
        taskId: "survey-auth",
        workerName: "verifier",
        paseoAgentId: "paseo-worker",
        brief: "Old execution",
        status: "completed",
        startedAt: "2026-10-05T00:00:00.000Z",
        endedAt: "2026-10-05T00:01:00.000Z",
        result: "done",
      },
    ],
    activities: [
      {
        id: "activity-1",
        swarmId: "swarm",
        taskId: "survey-auth",
        executionId: "legacy-run",
        actorName: "lead",
        actorKind: null,
        kind: "note",
        body: "The manager understood the report.",
        data: {},
        createdAt: "2026-10-05T00:02:00.000Z",
      },
    ],
  });

  assert.equal("executions" in state, false);
  assert.equal(state.activities[0].actorKind, "agent");
  assert.equal("executionId" in state.activities[0], false);
  assert.deepEqual(state.messages, []);
});

test("a seat from before the handover log gets the handovers its occupants still show", () => {
  const stamp = (number: number, boundAt: string, provider: string) => ({
    number,
    config: { provider },
    generation: 0,
    boundAt,
  });
  const seat = {
    createdAt: "2026-10-01T00:00:00.000Z",
    paseoAgentId: "agent-3",
    occupant: stamp(3, "2026-10-03T00:00:00.000Z", "c"),
    pastOccupants: [
      {
        ...stamp(2, "2026-10-02T00:00:00.000Z", "b"),
        paseoAgentId: "agent-2",
        retiredAt: "2026-10-03T00:00:00.000Z",
        reason: "provider b → c",
      },
      {
        ...stamp(1, "2026-10-01T00:00:00.000Z", "a"),
        paseoAgentId: "agent-1",
        retiredAt: "2026-10-02T00:00:00.000Z",
        reason: "provider a → b",
      },
    ],
  };
  assert.deepEqual(
    handoverLog(seat).map((handover) => [
      handover.at,
      handover.from.number,
      handover.to.number,
      handover.to.config.provider,
      handover.reason,
      handover.returning,
    ]),
    [
      ["2026-10-02T00:00:00.000Z", 1, 2, "b", "provider a → b", false],
      ["2026-10-03T00:00:00.000Z", 2, 3, "c", "provider b → c", false],
    ],
  );
  const logged = { ...seat, handovers: [] };
  assert.deepEqual(handoverLog(logged), [], "a recorded log is read as it is");
});

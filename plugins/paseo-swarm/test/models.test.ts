import { strict as assert } from "node:assert";
import { test } from "node:test";
import { stateSchema } from "../shared/models";

test("state parsing drops legacy executions and preserves old Activities", () => {
  const state = stateSchema.parse({
    version: 1,
    agents: [],
    tasks: [
      {
        id: "survey-auth",
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
});

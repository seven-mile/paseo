import { strict as assert } from "node:assert";
import { test } from "node:test";
import { boardReadRpc, pwaSourceReadRpc, pwaSourceSetRpc, prepareAgentRpc } from "../shared/swarm";
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

test("old agents remain readable and new PWA bindings round-trip without Task status snapshots", () => {
  const agent = {
    id: "agent-1",
    paseoAgentId: "native-1",
    name: "planner",
    aliases: [],
    roleClass: "planner",
    role: "director",
    reportsTo: null,
    workspaceId: null,
    projectId: "project",
    retired: false,
    createdAt: "created",
    updatedAt: "updated",
  };
  const old = stateSchema.parse({ version: 1, agents: [agent], tasks: [], activities: [] });
  assert.equal("pwaBinding" in old.agents[0], false);
  const pwaBinding = {
    projectId: "project",
    contentRoot: "/content",
    directory: "/content/review",
  };
  const next = stateSchema.parse({
    version: 1,
    agents: [{ ...agent, pwaBinding }],
    tasks: [],
    activities: [],
  });
  assert.deepEqual(next.agents[0].pwaBinding, pwaBinding);
  assert.equal("statuses" in next.agents[0], false);
  assert.equal("preparation" in next.agents[0], false);
});

test("source responses from older hosts remain parseable without discovery fields", () => {
  assert.deepEqual(pwaSourceReadRpc.output.parse({ path: "/legacy" }), { path: "/legacy" });
  assert.deepEqual(pwaSourceReadRpc.output.parse({ path: null }), { path: null });
  assert.deepEqual(pwaSourceSetRpc.output.parse({ path: "/legacy" }), { path: "/legacy" });
  const previous = pwaSourceReadRpc.output.parse({
    path: "/content",
    entries: [],
    complete: true,
    errors: [],
  });
  assert.equal(previous.sourcePreview, undefined);
  assert.equal(previous.agentConfigRead, undefined);
  assert.equal(
    pwaSourceReadRpc.output.safeParse({ path: "/content", agentConfigRead: "yes" }).success,
    false,
  );
  assert.equal(
    boardReadRpc.output.parse({ version: 1, agents: [], tasks: [], activities: [] }).teamScopes,
    undefined,
  );
  assert.equal(
    pwaSourceReadRpc.output.safeParse({ path: "/legacy", entries: "invalid" }).success,
    false,
  );
});

test("old prepared UUID and prompt parse without the additive parent identity field", () => {
  const agent = stateSchema.parse({
    version: 1,
    agents: [
      {
        id: "reserved",
        paseoAgentId: "reserved-native",
        name: "planner",
        aliases: [],
        roleClass: "planner",
        role: "planner",
        reportsTo: null,
        workspaceId: null,
        retired: false,
        createdAt: "created",
        updatedAt: "updated",
      },
    ],
    tasks: [],
    activities: [],
  }).agents[0];
  const result = prepareAgentRpc.output.parse({
    agentId: "reserved-native",
    systemPrompt: "Prepared prompt",
    agent,
  });
  assert.equal(result.agentId, agent.paseoAgentId);
  assert.equal(result.systemPrompt, "Prepared prompt");
  assert.equal(result.parentAgentId, undefined);
});

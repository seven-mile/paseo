import { strict as assert } from "node:assert";
import { test } from "node:test";
import { resolveActivityRefs } from "../server/refs";
import { formatSwarmUri, parseSwarmUri, splitMarkdownParts } from "../shared/refs";
import { type SwarmState } from "../shared/models";

const state: SwarmState = {
  version: 1,
  swarms: [],
  agents: [
    {
      id: "agent-1",
      swarmId: "swarm-a",
      paseoAgentId: "paseo-supervisor",
      name: "supervisor",
      qualifiedName: "supervisor",
      aliases: ["lead"],
      roleClass: "supervisor",
      role: "supervisor",
      reportsTo: "planner",
      workspaceId: "workspace-1",
      retired: false,
      createdAt: "2026-10-05T00:00:00.000Z",
      updatedAt: "2026-10-05T00:00:00.000Z",
    },
    {
      id: "agent-2",
      swarmId: "swarm-a",
      paseoAgentId: "paseo-worker",
      name: "verifier",
      qualifiedName: "supervisor.verifier",
      aliases: [],
      roleClass: "worker",
      role: "reviewer",
      reportsTo: "supervisor",
      workspaceId: "workspace-2",
      retired: false,
      createdAt: "2026-10-05T00:00:00.000Z",
      updatedAt: "2026-10-05T00:00:00.000Z",
    },
  ],
  tasks: [
    {
      id: "review-api",
      swarmId: "swarm-a",
      title: "Review API",
      brief: "Review the API.",
      status: "review",
      managerName: "supervisor",
      workerNames: ["supervisor.verifier"],
      createdBy: "supervisor",
      data: {},
      createdAt: "2026-10-05T00:00:00.000Z",
      updatedAt: "2026-10-05T00:00:00.000Z",
    },
  ],
  activities: [],
  messages: [],
};

test("custom Markdown links split into text and ref parts", () => {
  assert.deepEqual(
    splitMarkdownParts("See [the report](paseo-swarm://agent/supervisor.verifier) now."),
    [
      { kind: "text", text: "See " },
      { kind: "ref", label: "the report", uri: "paseo-swarm://agent/supervisor.verifier" },
      { kind: "text", text: " now." },
    ],
  );
});

test("swarm URI formatting and parsing round-trip", () => {
  const target = {
    kind: "file" as const,
    workspaceId: "workspace-2",
    path: "reports/findings v1.md",
  };
  const uri = formatSwarmUri(target);
  assert.equal(uri, "paseo-swarm://file/workspace-2/reports/findings%20v1.md");
  assert.deepEqual(parseSwarmUri(uri), target);
});

test("activity refs resolve names to navigable Paseo identities", () => {
  const refs = resolveActivityRefs(
    "See [verifier](paseo-swarm://agent/supervisor.verifier), [Task](paseo-swarm://task/review-api), and [findings](paseo-swarm://file/workspace-2/reports/findings.md).",
    state,
    "swarm-a",
  );
  assert.deepEqual(refs, [
    {
      kind: "agent",
      uri: "paseo-swarm://agent/supervisor.verifier",
      label: "verifier",
      qualifiedName: "supervisor.verifier",
      paseoAgentId: "paseo-worker",
      workspaceId: "workspace-2",
    },
    {
      kind: "task",
      uri: "paseo-swarm://task/review-api",
      label: "Task",
      taskId: "review-api",
    },
    {
      kind: "file",
      uri: "paseo-swarm://file/workspace-2/reports/findings.md",
      label: "findings",
      workspaceId: "workspace-2",
      path: "reports/findings.md",
    },
  ]);
});

test("unknown refs are rejected instead of becoming dead links", () => {
  assert.throws(
    () => resolveActivityRefs("[nobody](paseo-swarm://agent/missing)", state, "swarm-a"),
    /Unknown agent reference: missing/,
  );
  assert.throws(
    () =>
      resolveActivityRefs("[escape](paseo-swarm://file/workspace-2/..%2Fsecret)", state, "swarm-a"),
    /Invalid paseo-swarm reference/,
  );
});

test("activity refs resolve only within the Activity's swarm", () => {
  for (const body of [
    "[verifier](paseo-swarm://agent/supervisor.verifier)",
    "[Task](paseo-swarm://task/review-api)",
    "[findings](paseo-swarm://file/workspace-2/reports/findings.md)",
  ]) {
    assert.throws(() => resolveActivityRefs(body, state, "swarm-b"), /Unknown/);
  }
});

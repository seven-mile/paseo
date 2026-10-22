import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyChoiceDefaults, buildInbox, normalizeChoiceAction } from "../server/inbox";
import type { PaseoApi } from "../server/runtime";
import { store } from "../server/state";
import { unansweredChoices } from "../shared/inbox";
import { emptyState, type Activity, type AgentRecord, type Approval } from "../shared/models";

const timestamp = "2026-10-22T00:00:00.000Z";
const manager: AgentRecord = {
  id: "manager-record",
  paseoAgentId: "manager-agent",
  name: "manager",
  qualifiedName: "manager",
  aliases: [],
  roleClass: "supervisor",
  role: "supervisor",
  reportsTo: null,
  workspaceId: "workspace",
  retired: false,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const task = {
  id: "ship-it",
  title: "Ship it",
  brief: "Ship it.",
  status: "review",
  managerName: "manager",
  workerNames: [],
  createdBy: "manager",
  data: {},
  createdAt: timestamp,
  updatedAt: timestamp,
};
const options = [
  { id: "a", label: "Design A" },
  { id: "b", label: "Design B" },
];

function choice(id: string, action: Record<string, unknown>, createdAt = timestamp): Activity {
  return {
    id,
    taskId: task.id,
    actorName: "manager",
    actorKind: "agent",
    replyTo: null,
    responseProfile: null,
    kind: "question",
    body: "Which design?",
    data: { action: { type: "choice", prompt: "Which design?", options, ...action } },
    refs: [],
    createdAt,
  };
}

const approval: Approval = {
  id: "approval-1",
  agentId: manager.id,
  paseoAgentId: manager.paseoAgentId,
  agentName: "manager",
  taskId: task.id,
  action: "pr_merge",
  command: ["gh", "pr", "merge", "3"],
  cwd: "/repo",
  fingerprint: "f",
  status: "pending",
  permissionId: "raised:1",
  feedback: null,
  createdAt: "2026-10-22T05:00:00.000Z",
  resolvedAt: null,
};

test("the inbox lists approvals, provider permissions, open choices and errors in tier order", () => {
  const state = {
    ...emptyState(),
    agents: [manager],
    tasks: [task],
    approvals: [approval, { ...approval, id: "approval-2", status: "consumed" as const }],
    activities: [
      choice("activity-open", { defaultOptionId: "b", deadline: "2026-10-22T04:00:00.000Z" }),
      choice("activity-answered", {}),
      {
        ...choice("reply", {}),
        actorKind: "human" as const,
        replyTo: "activity-answered",
        data: { selectedOption: "a" },
      },
    ],
  };
  const items = buildInbox(state, [
    {
      id: manager.paseoAgentId,
      status: "error",
      lastError: "provider crashed",
      updatedAt: "2026-10-22T01:00:00.000Z",
      pendingPermissions: [
        // The raised approval permission is already listed as its approval.
        { id: "raised:1", name: "swarm_approval_pr_merge" },
        { id: "tool-1", name: "shell", title: "Run rm -rf build" },
      ],
    },
  ]);
  assert.deepEqual(
    items.map((item) => [item.kind, item.id]),
    [
      ["approval", "approval-1"],
      ["permission", "manager-agent:tool-1"],
      ["choice", "activity-open"],
      ["error", "manager-agent:error"],
    ],
  );
  const open = items[2];
  assert.equal(open.kind === "choice" && open.defaultOptionId, "b");
  assert.equal(items[1].taskId, task.id);
});

test("choice actions resolve a timeout into a deadline and need a real default", () => {
  const now = new Date(timestamp);
  assert.deepEqual(
    normalizeChoiceAction(
      {
        action: { type: "choice", prompt: "Q", options, defaultOptionId: "a", timeoutMinutes: 30 },
      },
      now,
    ),
    {
      action: {
        type: "choice",
        prompt: "Q",
        options,
        defaultOptionId: "a",
        deadline: "2026-10-22T00:30:00.000Z",
      },
    },
  );
  assert.throws(
    () =>
      normalizeChoiceAction(
        { action: { type: "choice", prompt: "Q", options, timeoutMinutes: 30 } },
        now,
      ),
    /needs a defaultOptionId/,
  );
  assert.throws(
    () =>
      normalizeChoiceAction(
        { action: { type: "choice", prompt: "Q", options, defaultOptionId: "c" } },
        now,
      ),
    /not one of its options/,
  );
  assert.deepEqual(normalizeChoiceAction({ note: 1 }, now), { note: 1 });
});

test("a passed deadline records the default once and tells the Task manager", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "swarm-inbox-"));
  const previousHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });
  await store.commit(() => [
    { op: "put", collection: "agents", record: manager },
    { op: "put", collection: "tasks", record: task },
    {
      op: "put",
      collection: "activities",
      record: choice("expired", { defaultOptionId: "b", deadline: "2026-10-22T01:00:00.000Z" }),
    },
    {
      op: "put",
      collection: "activities",
      record: choice("later", { defaultOptionId: "a", deadline: "2026-10-23T01:00:00.000Z" }),
    },
  ]);
  const sends: Array<{ agentId: string; text: string }> = [];
  const paseo = {
    agents: {
      ref(agentId: string) {
        return {
          async send(text: string) {
            sends.push({ agentId, text });
          },
        };
      },
    },
  } as unknown as PaseoApi;

  const now = new Date("2026-10-22T02:00:00.000Z");
  await applyChoiceDefaults(paseo, now);
  await applyChoiceDefaults(paseo, now);
  const activities = store.read().activities;
  const decisions = activities.filter((activity) => activity.kind === "default-decision");
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].replyTo, "expired");
  assert.deepEqual(decisions[0].data, { selectedOption: "b", resolvedBy: "deadline" });
  assert.deepEqual(
    unansweredChoices(activities).map((activity) => activity.id),
    ["later"],
  );
  assert.equal(sends.length, 1);
  assert.equal(sends[0].agentId, manager.paseoAgentId);
  assert.match(sends[0].text, /Design B \(b\)/);
});

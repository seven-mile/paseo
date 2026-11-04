import { strict as assert } from "node:assert";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { syncAuthoredArtifacts } from "../server/artifacts";
import { forgetRunningTurns } from "../server/mailbox";
import { registerOperations } from "../server/operations";
import { store } from "../server/state";
import { seatReadView, taskView } from "../server/views";
import { seed } from "./fixtures";
import type { Activity, AgentRecord, Task } from "../shared/models";
import {
  artifactsReadRpc,
  boardReadRpc,
  createTaskRpc,
  deliverTaskRpc,
  publishArtifactRpc,
  readArtifactRpc,
  taskReadRpc,
} from "../shared/swarm";

const timestamp = "2026-11-01T00:00:00Z";
const seat = (
  name: string,
  roleClass: AgentRecord["roleClass"],
  reportsTo: string | null,
  workspaceId: string,
): Omit<AgentRecord, "swarmId"> => {
  const qualifiedName = reportsTo ? `${reportsTo}.${name}` : name;
  return {
    id: `${qualifiedName}-record`,
    paseoAgentId: `${qualifiedName}-agent`,
    name,
    qualifiedName,
    aliases: [],
    roleClass,
    role: roleClass,
    reportsTo,
    workspaceId,
    projectId: "project",
    retired: false,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
};
const planner = seat("planner", "planner", null, "root");
const lead = seat("lead", "supervisor", "planner", "lead-worktree");

interface Artifact {
  id: string;
  title: string;
  contentHash: string;
  changedAt: string;
  location: { workspaceId: string; path: string; link: string } | null;
  deliveries: Array<{ activityId: string; changed: boolean; audience: unknown[] }>;
}

// Artifact copies are read-only; the test's home is removed whole.
function makeWritable(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory()) return;
  chmodSync(path, 0o755);
  for (const entry of readdirSync(path)) makeWritable(join(path, entry));
}

// A daemon whose workspaces are directories on disk. Retiring one removes its directory, as
// Paseo does when a worktree's work merges.
function setup(t: { after(fn: () => void): void }) {
  const home = mkdtempSync(join(tmpdir(), "swarm-artifacts-"));
  const previousHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = previousHome;
    makeWritable(home);
    rmSync(home, { recursive: true, force: true });
  });
  forgetRunningTurns();
  const workspaces = new Map<string, string | null>();
  for (const id of ["root", "lead-worktree"]) {
    const directory = join(home, "workspaces", id);
    mkdirSync(directory, { recursive: true });
    workspaces.set(id, directory);
  }
  const created: string[] = [];
  const handlers = new Map<string, (input: never, context: PluginHandlerContext) => unknown>();
  const server: Pick<PluginServerContext, "handle"> = {
    handle(contract, handler) {
      handlers.set(contract.name, handler);
    },
  };
  registerOperations(server);
  const context = {
    signal: new AbortController().signal,
    paseo: {
      agents: { ref: () => ({ async send() {} }) },
      projects: {
        async list() {
          return { projects: [{ projectId: "project", projectRootPath: join(home, "root") }] };
        },
      },
      workspaces: {
        ref(id: string) {
          return {
            async refresh() {
              const directory = workspaces.get(id);
              return directory ? { id, workspaceDirectory: directory } : null;
            },
          };
        },
        async create(input: { source: { path: string }; title: string }) {
          const id = `artifacts-${created.length + 1}`;
          created.push(input.title);
          workspaces.set(id, input.source.path);
          return { id };
        },
      },
    },
  } as unknown as PluginHandlerContext;
  const call = async <Output>(
    contract: { name: string; input: { parse(value: unknown): unknown } },
    input: Record<string, unknown>,
  ) =>
    (await handlers.get(contract.name)!(contract.input.parse(input) as never, context)) as Output;
  const write = (workspaceId: string, path: string, text: string) => {
    const file = join(workspaces.get(workspaceId)!, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  };
  const retire = (workspaceId: string) => {
    rmSync(workspaces.get(workspaceId)!, { recursive: true, force: true });
    workspaces.set(workspaceId, null);
  };
  const readCopy = (artifact: Artifact, path = artifact.location!.path) =>
    readFileSync(join(workspaces.get(artifact.location!.workspaceId)!, path), "utf8");
  return { call, context, write, retire, readCopy, created, workspaces };
}

test("a published artifact is copied with its attachments and outlives the worktree that wrote it", async (t) => {
  const { call, context, write, retire, readCopy, created, workspaces } = setup(t);
  await seed({ agents: [planner, lead] });
  write("lead-worktree", "reports/auth.md", "# Auth\n\nSee [data](./data/users.csv).\n");
  write("lead-worktree", "reports/data/users.csv", "id,name\n1,ada\n");
  write("lead-worktree", "reports/scratch.md", "not a result");

  const { artifact, created: isNew } = await call<{ artifact: Artifact; created: boolean }>(
    publishArtifactRpc,
    {
      actorName: "planner.lead",
      path: "./reports/auth.md",
      title: "Auth review",
      attachments: ["reports/data"],
    },
  );
  assert.equal(isNew, true);
  assert.equal(artifact.id, "auth-review");
  assert.deepEqual(created, [`${store.read().swarms[0]!.name} artifacts`]);
  assert.equal(artifact.location?.workspaceId, "artifacts-1");
  assert.equal(artifact.location?.path, "auth-review/reports/auth.md");
  assert.equal(
    artifact.location?.link,
    "paseo-swarm://file/artifacts-1/auth-review/reports/auth.md",
  );
  // The copy sits in the swarm's directory and keeps relative links between its files.
  assert.equal(workspaces.get("artifacts-1"), join(store.read().swarms[0]!.directory, "artifacts"));
  assert.match(readCopy(artifact), /\[data\]\(\.\/data\/users\.csv\)/);
  // The copy is read-only, so no reader edits a file the next copy replaces.
  const copied = join(workspaces.get("artifacts-1")!, artifact.location!.path);
  assert.equal(statSync(copied).mode & 0o222, 0);
  assert.equal(readCopy(artifact, "auth-review/reports/data/users.csv"), "id,name\n1,ada\n");
  assert.equal(
    existsSync(join(workspaces.get("artifacts-1")!, "auth-review/reports/scratch.md")),
    false,
  );

  // Publishing the same file again is the same artifact, and tells no one.
  const again = await call<{ artifact: Artifact; created: boolean }>(publishArtifactRpc, {
    actorName: "planner.lead",
    path: "reports/auth.md",
    title: "Auth review",
    attachments: ["reports/data"],
  });
  assert.equal(again.created, false);
  assert.equal(again.artifact.contentHash, artifact.contentHash);
  assert.equal(store.read().messages.length, 0);

  // An edit reaches the copy at the author's turn end, and the worktree's removal leaves it.
  write("lead-worktree", "reports/auth.md", "# Auth\n\nRevised.\n");
  await syncAuthoredArtifacts(lead.paseoAgentId!, context);
  retire("lead-worktree");
  await syncAuthoredArtifacts(lead.paseoAgentId!, context);
  const kept = await call<Artifact>(readArtifactRpc, {
    actorName: "planner.lead",
    artifactId: "auth-review",
  });
  assert.notEqual(kept.contentHash, artifact.contentHash);
  assert.equal(readCopy(kept), "# Auth\n\nRevised.\n");
  assert.equal(readCopy(kept, "auth-review/reports/data/users.csv"), "id,name\n1,ada\n");
});

test("publishing refuses paths outside the workspace, missing files and another author's artifact", async (t) => {
  const { call, write } = setup(t);
  await seed({ agents: [planner, lead] });
  write("lead-worktree", "report.md", "# Report");
  await assert.rejects(
    call(publishArtifactRpc, { actorName: "planner.lead", path: "../secret.md", title: "X" }),
    /stays inside it/,
  );
  await assert.rejects(
    call(publishArtifactRpc, { actorName: "planner.lead", path: "missing.md", title: "X" }),
    /missing\.md is not a file in the workspace/,
  );
  await assert.rejects(
    call(publishArtifactRpc, {
      actorName: "planner.lead",
      path: "report.md",
      title: "X",
      attachments: ["absent"],
    }),
    /absent does not exist/,
  );
  await call(publishArtifactRpc, { actorName: "planner.lead", path: "report.md", title: "Report" });
  write("root", "report.md", "# Planner's");
  await assert.rejects(
    call(publishArtifactRpc, {
      actorName: "planner",
      artifactId: "report",
      path: "report.md",
      title: "Report",
    }),
    /maintained by planner\.lead/,
  );
});

test("a delivery records the artifacts it links, and readers see when one changed since", async (t) => {
  const { call, context, write } = setup(t);
  await seed({ agents: [planner, lead] });
  const task = await call<Task>(createTaskRpc, {
    id: "auth",
    title: "Review auth",
    brief: "Review it.",
    status: "development",
    managerName: "lead",
    createdBy: "planner",
    requester: "human",
  });
  write("lead-worktree", "auth.md", "# Auth v1");
  const { artifact } = await call<{ artifact: Artifact }>(publishArtifactRpc, {
    actorName: "planner.lead",
    path: "auth.md",
    title: "Auth review",
    taskId: task.id,
  });
  const delivered = await call<{ activity: Activity }>(deliverTaskRpc, {
    actorName: "planner.lead",
    taskId: task.id,
    taskState: "done",
    result: `Login is safe; one open risk. Details in [the review](${artifact.location!.link}).`,
  });
  assert.deepEqual(delivered.activity.artifacts, [
    { id: "auth-review", contentHash: artifact.contentHash },
  ]);
  const unchanged = await call<Artifact>(readArtifactRpc, {
    actorName: "planner.lead",
    artifactId: "auth-review",
  });
  assert.deepEqual(
    unchanged.deliveries.map((entry) => [entry.activityId, entry.changed]),
    [[delivered.activity.id, false]],
  );

  write("lead-worktree", "auth.md", "# Auth v2");
  await syncAuthoredArtifacts(lead.paseoAgentId!, context);
  const view = taskView(store.read(), { swarmId: task.swarmId, taskId: task.id, limit: 10 });
  const result = view.activities.find((activity) => activity.id === delivered.activity.id)!;
  assert.deepEqual(
    result.deliveredArtifacts?.map((entry) => [entry.id, entry.changed]),
    [["auth-review", true]],
  );
  // The host parses each reply with the contract's output, which must keep the artifacts.
  const read = taskReadRpc.output.parse(
    await call(taskReadRpc, { swarmId: task.swarmId, taskId: task.id }),
  );
  assert.deepEqual(
    read.data?.activities
      .find((activity) => activity.id === delivered.activity.id)
      ?.deliveredArtifacts?.map((entry) => [entry.id, entry.changed]),
    [["auth-review", true]],
  );
  const seatView = seatReadView(store.read(), lead.id);
  assert.equal(seatView.deliveries[0]?.artifacts?.[0]?.changed, true);
  const list = await call<{ data: { artifacts: Artifact[] } }>(artifactsReadRpc, {
    projectId: "project",
  });
  assert.deepEqual(
    list.data.artifacts.map((entry) => [entry.id, entry.title, entry.deliveries.length]),
    [["auth-review", "Auth review", 1]],
  );
});

test("a delivery without a Task goes to whom it names, copies the manager, and stays off the board", async (t) => {
  const { call } = setup(t);
  await seed({ agents: [planner, lead] });
  await assert.rejects(
    call(deliverTaskRpc, { actorName: "planner.lead", result: "Answer." }),
    /goes to the readers you name/,
  );
  await assert.rejects(
    call(deliverTaskRpc, {
      actorName: "planner.lead",
      result: "Answer.",
      to: ["human"],
      taskState: "done",
    }),
    /belong to a Task/,
  );
  const { activity, task } = await call<{ activity: Activity; task: Task | null }>(deliverTaskRpc, {
    actorName: "planner.lead",
    result: "The cache is safe to drop.",
    to: ["human"],
  });
  assert.equal(task, null);
  assert.equal(activity.taskId, null);
  assert.deepEqual(activity.audience, [
    { name: "human", as: "to", why: "named" },
    { name: "planner", as: "cc", why: "manager" },
  ]);
  assert.equal(store.read().messages.filter((m) => m.recipientName === "planner").length, 1);
  const seatView = seatReadView(store.read(), lead.id);
  assert.deepEqual(seatView.deliveries, []);
  assert.equal(seatView.directDeliveries[0]?.activityId, activity.id);
  const board = await call<{ activities: Activity[] }>(boardReadRpc, {});
  assert.equal(
    board.activities.some((entry) => entry.id === activity.id),
    false,
  );

  // A correction revises it; a delivery on a Task can't be revised from here.
  const revised = await call<{ activity: Activity }>(deliverTaskRpc, {
    actorName: "planner.lead",
    result: "Correction: drop it only after the migration.",
    to: ["human"],
    cc: [],
    revises: activity.id,
  });
  assert.equal(revised.activity.data.revises, activity.id);
  assert.deepEqual(revised.activity.audience, [{ name: "human", as: "to", why: "named" }]);
  await assert.rejects(
    call(deliverTaskRpc, {
      actorName: "planner",
      result: "Not mine.",
      to: ["human"],
      revises: activity.id,
    }),
    /not a delivery you made without a Task/,
  );
});

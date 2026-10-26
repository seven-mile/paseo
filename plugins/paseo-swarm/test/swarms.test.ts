import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { findSeat } from "../server/seats";
import { store, type SwarmChange } from "../server/state";
import { createSwarm, swarmTasks } from "../server/swarms";
import type { AgentRecord, SwarmState, Task } from "../shared/models";

const timestamp = "2026-10-25T00:00:00Z";

function writePwa(directory: string, project: string) {
  mkdirSync(join(directory, "roles"), { recursive: true });
  writeFileSync(join(directory, "PWA.md"), `---\nversion: 1\nproject: ${project}\n---\nShared.\n`);
  writeFileSync(
    join(directory, "roles", "planner.md"),
    "---\nversion: 1\nroleClass: planner\n---\nPlan.\n",
  );
  writeFileSync(
    join(directory, "roles", "researcher.md"),
    "---\nversion: 1\nroleClass: worker\n---\nResearch.\n",
  );
}

function setup(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "swarm-swarms-"));
  const previousHome = process.env.PASEO_HOME;
  const previousPwa = process.env.PASEO_SWARM_PWA_ROOT;
  process.env.PASEO_HOME = home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = previousHome;
    if (previousPwa === undefined) delete process.env.PASEO_SWARM_PWA_ROOT;
    else process.env.PASEO_SWARM_PWA_ROOT = previousPwa;
    rmSync(home, { recursive: true, force: true });
  });
  return home;
}

function seat(input: Partial<AgentRecord> & Pick<AgentRecord, "id" | "name">): AgentRecord {
  return {
    paseoAgentId: `${input.id}-agent`,
    qualifiedName: input.name,
    aliases: [],
    roleClass: "planner",
    role: "planner",
    reportsTo: null,
    workspaceId: null,
    retired: false,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...input,
  };
}

function task(id: string, managerName: string, swarmId: string): Task {
  return {
    id,
    swarmId,
    title: id,
    brief: "",
    status: "open",
    managerName,
    workerNames: [],
    createdBy: managerName,
    data: {},
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

async function seed(state: Partial<SwarmState>) {
  await store.commit(() => [
    ...(state.agents ?? []).map(
      (record): SwarmChange => ({ op: "put", collection: "agents", record }),
    ),
    ...(state.tasks ?? []).map(
      (record): SwarmChange => ({ op: "put", collection: "tasks", record }),
    ),
    ...(state.activities ?? []).map(
      (record): SwarmChange => ({ op: "put", collection: "activities", record }),
    ),
    ...(state.messages ?? []).map(
      (record): SwarmChange => ({ op: "put", collection: "messages", record }),
    ),
  ]);
}

test("two swarms can hold seats and Tasks with the same names without crossing", async (t) => {
  const home = setup(t);
  const source = join(home, "pwa");
  writePwa(source, "Twins");
  const alpha = await createSwarm({ sourceDirectory: source, projectId: "alpha" });
  const beta = await createSwarm({ sourceDirectory: source, projectId: "beta" });
  assert.notEqual(alpha.id, beta.id);
  assert.notEqual(alpha.directory, beta.directory);
  // A project keeps the swarm it has.
  assert.equal((await createSwarm({ sourceDirectory: source, projectId: "alpha" })).id, alpha.id);

  await seed({
    agents: [
      seat({ id: "alpha-lead", name: "lead", swarmId: alpha.id, projectId: "alpha" }),
      seat({ id: "beta-lead", name: "lead", swarmId: beta.id, projectId: "beta" }),
    ],
    tasks: [task("build", "lead", alpha.id), task("build", "lead", beta.id)],
  });

  assert.equal(findSeat(alpha.id, "lead").id, "alpha-lead");
  assert.equal(findSeat(beta.id, "lead").id, "beta-lead");
  assert.throws(() => findSeat(undefined, "lead"), /several swarms/);
  assert.deepEqual(swarmTasks(alpha.id), [task("build", "lead", alpha.id)]);
  assert.deepEqual(swarmTasks(beta.id), [task("build", "lead", beta.id)]);
});

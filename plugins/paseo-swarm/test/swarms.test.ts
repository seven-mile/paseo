import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { readPwa, readPwaFiles } from "../server/pwa";
import { assemblePrompt, findSeat } from "../server/seats";
import { getConfigPath, getMigrationReportPath, store, type SwarmChange } from "../server/state";
import { backfillSwarms, createSwarm, swarmOf, swarmTasks } from "../server/swarms";
import type { Activity, AgentRecord, MailboxMessage, SwarmState, Task } from "../shared/models";

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

function task(id: string, managerName: string, swarmId?: string): Task {
  return {
    id,
    ...(swarmId ? { swarmId } : {}),
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

function activity(id: string, taskId: string): Activity {
  return {
    id,
    taskId,
    actorName: "lead",
    actorKind: "agent",
    replyTo: null,
    responseProfile: null,
    kind: "note",
    body: id,
    data: {},
    refs: [],
    createdAt: timestamp,
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

test("records from before swarms join one swarm per project, copied from the source they used", async (t) => {
  const home = setup(t);
  const shared = join(home, "shared-pwa");
  const bundled = join(home, "bundled-pwa");
  writePwa(shared, "Shared");
  writePwa(bundled, "Bundled");
  process.env.PASEO_SWARM_PWA_ROOT = bundled;
  mkdirSync(join(getConfigPath(), ".."), { recursive: true });
  writeFileSync(
    getConfigPath(),
    JSON.stringify({ projectSources: { alpha: shared, beta: shared } }),
  );
  const sharedBefore = readPwaFiles(shared);
  const bundledBefore = readPwaFiles(bundled);

  // The receipt each occupant holds was stamped from the files the project used.
  const stamped = (record: AgentRecord, directory: string): AgentRecord => {
    const files = readPwaFiles(directory);
    const pwa = readPwa(files, record.role);
    const received = assemblePrompt(record, {
      id: "legacy",
      name: "legacy",
      directory,
      projectId: null,
      source: { revision: "", files },
      createdAt: timestamp,
      updatedAt: timestamp,
    }).received;
    assert.equal(received.pwaRevision, pwa.revision);
    return { ...record, prompt: { ...received, receivedAt: timestamp } };
  };
  const lead = stamped(seat({ id: "lead", name: "lead", projectId: "alpha" }), shared);
  const worker = stamped(
    seat({
      id: "worker",
      name: "worker",
      qualifiedName: "lead.worker",
      roleClass: "worker",
      role: "researcher",
      reportsTo: "lead",
      projectId: "alpha",
    }),
    shared,
  );
  const boss = stamped(seat({ id: "boss", name: "boss", projectId: "beta" }), shared);
  const loner = stamped(seat({ id: "loner", name: "loner" }), bundled);
  const message: MailboxMessage = {
    id: "message",
    recipientAgentId: worker.id,
    recipientName: "lead.worker",
    senderName: "lead",
    taskId: "build",
    kind: "team",
    prompt: "Queued before swarms.",
    createdAt: timestamp,
    attempts: 1,
    lastError: "Agent is offline",
    deliveredAt: null,
    deliveredToPaseoAgentId: null,
    consumedAt: null,
    failedAt: null,
  };
  await seed({
    agents: [lead, worker, boss, loner],
    tasks: [task("build", "lead"), task("ship", "boss"), task("lost", "ghost")],
    activities: [activity("built", "build"), activity("shipped", "ship"), activity("gone", "lost")],
    messages: [message],
  });

  await backfillSwarms();
  const state = store.read();

  const swarms = [...state.swarms].sort((left, right) =>
    String(left.projectId).localeCompare(String(right.projectId)),
  );
  assert.deepEqual(
    swarms.map((swarm) => swarm.projectId),
    ["alpha", "beta", null],
  );
  // Each project gets a directory of its own, holding the files it used. Sources stay unwritten.
  assert.equal(new Set(swarms.map((swarm) => swarm.directory)).size, 3);
  for (const swarm of swarms) {
    assert.ok(swarm.directory.startsWith(join(home, "swarms")));
    assert.deepEqual(readPwaFiles(swarm.directory), swarm.source.files);
  }
  assert.deepEqual(swarms[0].source.files, sharedBefore);
  assert.deepEqual(swarms[2].source.files, bundledBefore);
  assert.deepEqual(readPwaFiles(shared), sharedBefore);
  assert.deepEqual(readPwaFiles(bundled), bundledBefore);

  // Seats keep their occupants and receipts: the copy assembles the prompt they already hold.
  const [alpha, beta, none] = swarms;
  const bySeat = new Map(state.agents.map((record) => [record.id, record]));
  for (const [record, swarm] of [
    [lead, alpha],
    [worker, alpha],
    [boss, beta],
    [loner, none],
  ] as const) {
    const migrated = bySeat.get(record.id)!;
    assert.deepEqual(migrated, { ...record, swarmId: swarm.id });
    assert.equal(
      assemblePrompt(migrated, swarmOf(migrated)).received.revision,
      record.prompt!.revision,
    );
  }

  // Tasks follow their manager's seat and Activities their Task. Mail is left as it was.
  assert.deepEqual(state.tasks.map((record) => [record.id, record.swarmId]).sort(), [
    ["build", alpha.id],
    ["lost", undefined],
    ["ship", beta.id],
  ]);
  assert.deepEqual(state.activities.map((record) => [record.id, record.swarmId]).sort(), [
    ["built", alpha.id],
    ["gone", undefined],
    ["shipped", beta.id],
  ]);
  assert.deepEqual(state.messages, [message]);
  const report = JSON.parse(readFileSync(getMigrationReportPath(), "utf8")) as {
    issues: Array<{ collection: string; id: string }>;
  };
  assert.deepEqual(
    report.issues.map((issue) => [issue.collection, issue.id]),
    [
      ["tasks", "lost"],
      ["activities", "gone"],
    ],
  );

  // A second start finds nothing new to place and changes nothing.
  await backfillSwarms();
  assert.deepEqual(store.read().swarms, state.swarms);
  assert.deepEqual(store.read().agents, state.agents);
  assert.deepEqual(store.read().tasks, state.tasks);
  assert.deepEqual(store.read().activities, state.activities);
});

test("a Task whose manager name leads to several swarms is reported, not guessed", async (t) => {
  const home = setup(t);
  const source = join(home, "pwa");
  writePwa(source, "Two");
  process.env.PASEO_SWARM_PWA_ROOT = source;
  await seed({
    agents: [
      seat({ id: "alpha-lead", name: "lead", projectId: "alpha" }),
      seat({ id: "beta-lead", name: "lead", projectId: "beta" }),
    ],
    tasks: [task("build", "lead")],
  });

  await backfillSwarms();
  const state = store.read();
  assert.equal(state.swarms.length, 2);
  assert.deepEqual(state.tasks, [task("build", "lead")]);
  const report = JSON.parse(readFileSync(getMigrationReportPath(), "utf8")) as {
    issues: Array<{ id: string; reason: string }>;
  };
  assert.deepEqual(
    report.issues.map((issue) => issue.id),
    ["build"],
  );
  assert.match(report.issues[0].reason, /several swarms/);
});

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

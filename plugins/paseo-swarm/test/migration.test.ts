import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { getLegacyArchivePath, migrateStore } from "../server/migration";
import { readPwaFiles } from "../server/pwa";
import { assemblePrompt } from "../server/seats";
import {
  getConfigPath,
  getDataDirectory,
  getEventLogPath,
  getLegacyStatePath,
  getMigrationReportPath,
  getSnapshotPath,
  STORE_VERSION,
  StateLoadError,
  StateStore,
  store,
  StoreMigrationPendingError,
} from "../server/state";
import { swarmOf } from "../server/swarms";
import { emptyState, type AgentRecord, type MailboxMessage } from "../shared/models";

const timestamp = "2026-10-25T00:00:00Z";

// Records as a version 1 store held them, before every seat, Task and Activity named a swarm.
type V1Seat = Omit<AgentRecord, "swarmId"> & { swarmId?: string };

interface V1State {
  agents?: V1Seat[];
  tasks?: Array<ReturnType<typeof task>>;
  activities?: Array<ReturnType<typeof activity>>;
  messages?: MailboxMessage[];
}

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
  const home = mkdtempSync(join(tmpdir(), "swarm-migration-"));
  const previousHome = process.env.PASEO_HOME;
  const previousPwa = process.env.PASEO_SWARM_PWA_ROOT;
  process.env.PASEO_HOME = home;
  mkdirSync(getDataDirectory(), { recursive: true });
  t.after(() => {
    if (previousHome === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = previousHome;
    if (previousPwa === undefined) delete process.env.PASEO_SWARM_PWA_ROOT;
    else process.env.PASEO_SWARM_PWA_ROOT = previousPwa;
    rmSync(home, { recursive: true, force: true });
  });
  return home;
}

function seat(input: Partial<V1Seat> & Pick<V1Seat, "id" | "name">): V1Seat {
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

function task(id: string, managerName: string) {
  return {
    id,
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

function activity(id: string, taskId: string) {
  return {
    id,
    taskId,
    actorName: "lead",
    actorKind: "agent" as const,
    replyTo: null,
    responseProfile: null,
    kind: "note",
    body: id,
    data: {},
    refs: [],
    createdAt: timestamp,
  };
}

function message(id: string, recipient: V1Seat): MailboxMessage {
  return {
    id,
    recipientAgentId: recipient.id,
    recipientName: recipient.qualifiedName!,
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
}

// A version 1 store: the seats in its snapshot, everything else in one commit of its log, so the
// migration reads both.
function writeV1Store({ agents = [], tasks = [], activities = [], messages = [] }: V1State) {
  writeFileSync(
    getSnapshotPath(),
    JSON.stringify({ version: 1, seq: 1, state: { ...emptyState(), agents } }) + "\n",
  );
  const put = (collection: string, records: unknown[]) =>
    records.map((record) => ({ op: "put", collection, record }));
  const changes = [
    ...put("tasks", tasks),
    ...put("activities", activities),
    ...put("messages", messages),
  ];
  writeFileSync(getEventLogPath(), JSON.stringify({ seq: 2, at: timestamp, changes }) + "\n");
}

const readJson = <T>(path: string) => JSON.parse(readFileSync(path, "utf8")) as T;

interface Report {
  from: number;
  to: number;
  backup?: string;
  swarmsCreated?: string[];
  archive?: string | null;
  archived?: Array<{ collection: string; id: string; reason: string }>;
  seatsWithoutAgent?: string[];
  error?: string;
}

test("a version 1 store moves to one swarm per project, with a backup and an archive", async (t) => {
  const home = setup(t);
  const shared = join(home, "shared-pwa");
  const bundled = join(home, "bundled-pwa");
  writePwa(shared, "Shared");
  writePwa(bundled, "Bundled");
  process.env.PASEO_SWARM_PWA_ROOT = bundled;
  writeFileSync(
    getConfigPath(),
    JSON.stringify({ projectSources: { alpha: shared, beta: shared } }),
  );
  const sharedBefore = readPwaFiles(shared);
  const bundledBefore = readPwaFiles(bundled);

  // The receipt each occupant holds was stamped from the files the project used.
  const stamped = (record: V1Seat, directory: string): V1Seat => {
    const received = assemblePrompt(record, readPwaFiles(directory)).received;
    return { ...record, prompt: { ...received, receivedAt: timestamp } };
  };
  const lead = stamped(
    seat({
      id: "lead",
      name: "lead",
      projectId: "alpha",
      agentConfig: { provider: "slow/large", modeId: "default" },
    }),
    shared,
  );
  const worker = stamped(
    seat({
      id: "worker",
      name: "worker",
      qualifiedName: "lead.worker",
      roleClass: "worker",
      role: "researcher",
      reportsTo: "lead",
      projectId: "alpha",
      agentConfig: { provider: "slow/large" },
    }),
    shared,
  );
  // A seat from before seats kept no agent block; its occupant's config becomes one.
  const occupantConfig = { provider: "slow/large", modeId: "default", thinkingOptionId: "high" };
  const boss = stamped(
    seat({
      id: "boss",
      name: "boss",
      projectId: "beta",
      occupant: { number: 1, config: occupantConfig, generation: 0, boundAt: timestamp },
    }),
    shared,
  );
  const loner = stamped(seat({ id: "loner", name: "loner" }), bundled);
  const queued = message("queued", worker);
  const orphan = message("orphan", { ...worker, id: "gone-worker", qualifiedName: "lead.gone" });
  writeV1Store({
    agents: [lead, worker, boss, loner],
    tasks: [task("build", "lead"), task("ship", "boss"), task("lost", "ghost")],
    activities: [activity("built", "build"), activity("shipped", "ship"), activity("gone", "lost")],
    messages: [queued, orphan],
  });
  const snapshotBefore = readFileSync(getSnapshotPath(), "utf8");
  const logBefore = readFileSync(getEventLogPath(), "utf8");

  await migrateStore();

  // The switch: a version 2 snapshot and an empty log, read by the running store.
  assert.equal(readJson<{ version: number }>(getSnapshotPath()).version, STORE_VERSION);
  assert.equal(readFileSync(getEventLogPath(), "utf8"), "");
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
  for (const [record, swarm, agentConfig] of [
    [lead, alpha, lead.agentConfig],
    [worker, alpha, worker.agentConfig],
    [boss, beta, occupantConfig],
    [loner, none, undefined],
  ] as const) {
    const migrated = bySeat.get(record.id)!;
    assert.deepEqual(migrated, {
      ...record,
      swarmId: swarm.id,
      ...(agentConfig ? { agentConfig } : {}),
    });
    assert.equal(
      assemblePrompt(migrated, swarmOf(migrated).source.files).received.revision,
      record.prompt!.revision,
    );
  }

  // Tasks follow their manager's seat and Activities their Task. Mail stays as it was.
  assert.deepEqual(state.tasks.map((record) => [record.id, record.swarmId]).sort(), [
    ["build", alpha.id],
    ["ship", beta.id],
  ]);
  assert.deepEqual(state.activities.map((record) => [record.id, record.swarmId]).sort(), [
    ["built", alpha.id],
    ["shipped", beta.id],
  ]);
  assert.deepEqual(state.messages, [queued]);

  // What leads to no swarm is kept, whole, outside the live state.
  const archive = readJson<{ records: Array<{ collection: string; record: { id: string } }> }>(
    getLegacyArchivePath(),
  );
  assert.deepEqual(
    archive.records.map(({ collection, record }) => [collection, record.id]),
    [
      ["tasks", "lost"],
      ["activities", "gone"],
      ["messages", "orphan"],
    ],
  );
  assert.deepEqual(archive.records[0].record, task("lost", "ghost"));

  const report = readJson<Report>(getMigrationReportPath());
  assert.equal(report.error, undefined);
  assert.equal(report.archive, getLegacyArchivePath());
  assert.deepEqual(
    report.archived!.map((entry) => [entry.collection, entry.id]),
    [
      ["tasks", "lost"],
      ["activities", "gone"],
      ["messages", "orphan"],
    ],
  );
  assert.match(report.archived![0].reason, /No seat named ghost/);
  assert.deepEqual(report.seatsWithoutAgent, ["loner"]);
  assert.deepEqual(
    [...report.swarmsCreated!].sort(),
    swarms.map((swarm) => swarm.directory).sort(),
  );
  // The backup holds the version 1 files as they were.
  assert.equal(readFileSync(join(report.backup!, "snapshot.json"), "utf8"), snapshotBefore);
  assert.equal(readFileSync(join(report.backup!, "events.jsonl"), "utf8"), logBefore);

  // A second start finds a version 2 store and changes nothing.
  const migratedSnapshot = readFileSync(getSnapshotPath(), "utf8");
  await migrateStore();
  assert.equal(readFileSync(getSnapshotPath(), "utf8"), migratedSnapshot);
  assert.deepEqual(store.read(), state);
});

test("a crash after the switch leaves a version 1 log that the version 2 store skips", async (t) => {
  const home = setup(t);
  const source = join(home, "pwa");
  writePwa(source, "Crash");
  process.env.PASEO_SWARM_PWA_ROOT = source;
  writeV1Store({ agents: [seat({ id: "lead", name: "lead" })], tasks: [task("build", "lead")] });
  const logBefore = readFileSync(getEventLogPath(), "utf8");

  await migrateStore();
  const migrated = new StateStore().read();
  // The log truncation never happened.
  writeFileSync(getEventLogPath(), logBefore);
  assert.deepEqual(new StateStore().read(), migrated);
});

test("a Task whose manager name leads to several swarms is archived, not guessed", async (t) => {
  const home = setup(t);
  const source = join(home, "pwa");
  writePwa(source, "Two");
  process.env.PASEO_SWARM_PWA_ROOT = source;
  writeV1Store({
    agents: [
      seat({ id: "alpha-lead", name: "lead", projectId: "alpha" }),
      seat({ id: "beta-lead", name: "lead", projectId: "beta" }),
    ],
    tasks: [task("build", "lead")],
  });

  await migrateStore();
  const state = store.read();
  assert.equal(state.swarms.length, 2);
  assert.deepEqual(state.tasks, []);
  const report = readJson<Report>(getMigrationReportPath());
  assert.deepEqual(
    report.archived!.map((entry) => entry.id),
    ["build"],
  );
  assert.match(report.archived![0].reason, /several swarms/);
});

test("a store whose PWA directory cannot run stays at version 1, and the report says why", async (t) => {
  const home = setup(t);
  process.env.PASEO_SWARM_PWA_ROOT = join(home, "missing");
  writeV1Store({ agents: [seat({ id: "lead", name: "lead", projectId: "alpha" })] });
  const snapshotBefore = readFileSync(getSnapshotPath(), "utf8");
  const logBefore = readFileSync(getEventLogPath(), "utf8");

  await assert.rejects(() => migrateStore(), /cannot migrate the seats of project alpha/);
  assert.equal(readFileSync(getSnapshotPath(), "utf8"), snapshotBefore);
  assert.equal(readFileSync(getEventLogPath(), "utf8"), logBefore);
  assert.equal(existsSync(join(home, "swarms")), false);
  assert.equal(existsSync(getLegacyArchivePath()), false);
  assert.match(readJson<Report>(getMigrationReportPath()).error!, /project alpha/);
  assert.throws(() => new StateStore().read(), StoreMigrationPendingError);

  // The next start tries again, and succeeds once the directory can run.
  const source = join(home, "pwa");
  writePwa(source, "Fixed");
  process.env.PASEO_SWARM_PWA_ROOT = source;
  await migrateStore();
  assert.equal(new StateStore().read().agents[0].swarmId, new StateStore().read().swarms[0].id);
  assert.equal(readJson<Report>(getMigrationReportPath()).error, undefined);
});

test("an unreadable version 1 store is never overwritten", async (t) => {
  setup(t);
  writeFileSync(getLegacyStatePath(), '{"version": 1, "agents": [');

  await assert.rejects(() => migrateStore(), StateLoadError);
  assert.equal(readFileSync(getLegacyStatePath(), "utf8"), '{"version": 1, "agents": [');
  assert.equal(existsSync(getSnapshotPath()), false);
  assert.match(readJson<Report>(getMigrationReportPath()).error!, /state\.json cannot be read/);
});

test("a version 1 state.json from before the log is migrated and removed", async (t) => {
  const home = setup(t);
  const source = join(home, "pwa");
  writePwa(source, "Whole");
  process.env.PASEO_SWARM_PWA_ROOT = source;
  writeFileSync(
    getLegacyStatePath(),
    JSON.stringify({
      ...emptyState(),
      agents: [seat({ id: "lead", name: "lead" })],
      tasks: [task("build", "lead")],
    }),
  );

  await migrateStore();
  assert.equal(existsSync(getLegacyStatePath()), false);
  const report = readJson<Report>(getMigrationReportPath());
  assert.ok(existsSync(join(report.backup!, "state.json")));
  const state = new StateStore().read();
  assert.deepEqual(
    state.tasks.map((record) => [record.id, record.swarmId]),
    [["build", state.swarms[0].id]],
  );
});

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { registerOperations } from "../server/operations";
import { parseSwarmFile, renderSwarmFile } from "../server/roster";
import { assemblePrompt } from "../server/seats";
import { store } from "../server/state";
import { createSwarm, findSwarm } from "../server/swarms";
import { mailboxMessageStatus, type AgentRecord, type MailboxMessage } from "../shared/models";
import { directoryUpRpc, statusReadRpc } from "../shared/swarm";

const timestamp = "2026-10-25T00:00:00Z";

function writeRole(directory: string, role: string, roleClass: string, body = role) {
  writeFileSync(
    join(directory, "roles", `${role}.md`),
    `---\nversion: 1\nroleClass: ${roleClass}\n---\n${body}\n`,
  );
}

// Roster reconciliation never touches an agent, so any use of Paseo fails the test.
const untouched = {
  paseo: new Proxy(
    {},
    {
      get(_target, key) {
        throw new Error(`up touched Paseo: ${String(key)}`);
      },
    },
  ),
} as unknown as PluginHandlerContext;

async function setup(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "swarm-roster-"));
  const previousHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });
  const template = join(home, "template");
  mkdirSync(join(template, "roles"), { recursive: true });
  writeFileSync(join(template, "PWA.md"), "---\nversion: 1\nproject: Roster\n---\nAgreement.\n");
  writeRole(template, "planner", "planner");
  writeRole(template, "supervisor", "supervisor");
  writeRole(template, "developer", "worker");
  writeRole(template, "reviewer", "worker");
  const swarm = await createSwarm({ sourceDirectory: template, projectId: null });
  // A planner seat with an agent, holding the standing prompt of the accepted PWA.
  const planner: AgentRecord = {
    id: "planner-record",
    swarmId: swarm.id,
    paseoAgentId: "planner-agent",
    name: "planner",
    qualifiedName: "planner",
    aliases: [],
    roleClass: "planner",
    role: "planner",
    reportsTo: null,
    workspaceId: "workspace",
    agentConfig: { provider: "claude/opus" },
    occupant: { number: 1, config: { provider: "claude/opus" }, generation: 0, boundAt: timestamp },
    retired: false,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await store.commit(() => [
    {
      op: "put",
      collection: "agents",
      record: { ...planner, prompt: assemblePrompt(planner, swarm.source.files).received },
    },
  ]);
  const handlers = new Map<string, (input: never, context: PluginHandlerContext) => unknown>();
  registerOperations({
    handle(contract, handler) {
      handlers.set(contract.name, handler);
    },
  });
  const up = async (dryRun = false) =>
    directoryUpRpc.output.parse(
      await handlers.get(directoryUpRpc.name)!(
        directoryUpRpc.input.parse({ swarmId: swarm.id, dryRun }) as never,
        untouched,
      ),
    );
  const status = async () =>
    statusReadRpc.output.parse(
      await handlers.get(statusReadRpc.name)!(
        statusReadRpc.input.parse({ swarmId: swarm.id }) as never,
        untouched,
      ),
    );
  const file = join(swarm.directory, "swarm.yaml");
  const writeFile = (text: string) => writeFileSync(file, text);
  const seat = (name: string) =>
    store
      .read()
      .agents.findLast((record) => record.swarmId === swarm.id && record.qualifiedName === name);
  return { swarm, up, status, file, writeFile, seat };
}

const emptyPlan = {
  reserve: [],
  restore: [],
  update: [],
  retire: [],
  source: null,
  refusals: [],
};

test("swarm.yaml is a tree whose key paths are qualified names", () => {
  const seats = parseSwarmFile(
    [
      "version: 1",
      "seats:",
      "  planner:",
      "    role: planner",
      "    agent: { provider: claude/opus }",
      "    team:",
      "      lead:",
      "        role: supervisor",
      "        team:",
      "          dev: { role: developer, agent: { provider: codex, modeId: auto } }",
    ].join("\n"),
  );
  assert.deepEqual(
    seats.map((seat) => [seat.qualifiedName, seat.reportsTo, seat.role, seat.agentConfig]),
    [
      ["planner", null, "planner", { provider: "claude/opus" }],
      ["planner.lead", "planner", "supervisor", {}],
      ["planner.lead.dev", "planner.lead", "developer", { provider: "codex", modeId: "auto" }],
    ],
  );
  assert.throws(() => parseSwarmFile("version: 1\nseats:\n  a: { role: x, extra: 1 }"), /a/);
  assert.throws(() => parseSwarmFile("version: 2\nseats: {}"), /version/);
  assert.throws(() => parseSwarmFile("version: 1\nworkspaces: {}"), /workspaces/);
  assert.throws(() => parseSwarmFile("version: 1\nseats:\n  Bad: { role: x }"), /swarm.yaml/);

  const record = (name: string, reportsTo: string | null): AgentRecord => ({
    id: name,
    paseoAgentId: null,
    name: name.split(".").at(-1)!,
    qualifiedName: name,
    aliases: [],
    roleClass: "worker",
    role: "developer",
    reportsTo,
    workspaceId: null,
    retired: false,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const rendered = renderSwarmFile([record("lead", null), record("lead.dev", "lead")]);
  assert.deepEqual(
    parseSwarmFile(rendered).map((seat) => seat.qualifiedName),
    ["lead", "lead.dev"],
  );
  assert.throws(() => renderSwarmFile([record("gone.dev", "gone")]), /gone\.dev/);
});

test("up accepts the directory in one commit and never touches an agent", async (t) => {
  const { swarm, up, status, file, writeFile, seat } = await setup(t);

  // A directory without swarm.yaml gets one written from the accepted seats; nothing changes.
  assert.deepEqual((await up(true)).plan, emptyPlan);
  assert.deepEqual(
    parseSwarmFile(readFileSync(file, "utf8")).map((entry) => entry.qualifiedName),
    ["planner"],
  );
  assert.equal((await status()).unapplied, null);

  // Hire a team and edit a role; diff shows it, and nothing is accepted yet.
  writeFile(
    [
      "version: 1",
      "seats:",
      "  planner:",
      "    role: planner",
      "    agent: { provider: claude/sonnet }",
      "    team:",
      "      lead:",
      "        role: supervisor",
      "        agent: { provider: claude/opus }",
      "        team:",
      "          dev: { role: developer, agent: { provider: codex/gpt-6 } }",
    ].join("\n"),
  );
  writeRole(swarm.directory, "planner", "planner", "Plan with care.");
  const diff = await up(true);
  assert.deepEqual(diff.plan.reserve, [
    { seat: "planner.lead", role: "supervisor" },
    { seat: "planner.lead.dev", role: "developer" },
  ]);
  assert.deepEqual(diff.plan.update, [
    { seat: "planner", changes: ["provider claude/opus → claude/sonnet"] },
  ]);
  assert.deepEqual(diff.plan.source, { files: ["roles/planner.md"], prompts: ["planner"] });
  assert.equal(seat("planner.lead"), undefined);
  assert.equal((await status()).unapplied?.reserve.length, 2);
  const before = seat("planner")!;
  assert.equal((await status()).seats.find((entry) => entry.id === before.id)?.pending, null);

  // up accepts it all. Reserved seats wait for mail; the planner's agent is left as it is, and
  // its pending work says what its next mail does.
  const applied = await up();
  assert.deepEqual(applied.plan, diff.plan);
  assert.notEqual(applied.swarm.revision, swarm.source.revision);
  assert.equal(
    findSwarm(swarm.id).source.files["roles/planner.md"]?.includes("Plan with care."),
    true,
  );
  const dev = seat("planner.lead.dev")!;
  assert.equal(dev.paseoAgentId, null);
  assert.equal(dev.reportsTo, "planner.lead");
  assert.equal(dev.workspaceId, null);
  assert.deepEqual(dev.agentConfig, { provider: "codex/gpt-6" });
  const planner = seat("planner")!;
  assert.equal(planner.paseoAgentId, before.paseoAgentId);
  assert.deepEqual(planner.prompt, before.prompt);
  assert.deepEqual(planner.agentConfig, { provider: "claude/sonnet" });
  const after = await status();
  assert.equal(after.unapplied, null);
  assert.deepEqual(after.seats.find((entry) => entry.id === planner.id)?.pending, {
    kind: "adjust",
    reason: "provider claude/opus → claude/sonnet; then standing prompt changed",
  });
  assert.equal(after.seats.find((entry) => entry.id === dev.id)?.pending?.kind, "start");

  // Accepting the same directory again changes nothing.
  assert.deepEqual((await up()).plan, emptyPlan);
});

test("a seat the file drops retires; one it names again comes back with its history", async (t) => {
  const { up, writeFile, seat } = await setup(t);
  const team = (dev: string) =>
    [
      "version: 1",
      "seats:",
      "  planner:",
      "    role: planner",
      "    agent: { provider: claude/opus }",
      "    team:",
      "      lead:",
      "        role: supervisor",
      "        agent: { provider: claude/opus }",
      `        team: { ${dev}: { role: developer, agent: { provider: codex/gpt-6 } } }`,
    ].join("\n");
  writeFile(team("dev"));
  await up();
  const dev = seat("planner.lead.dev")!;
  const queued: MailboxMessage = {
    id: "queued",
    recipientAgentId: dev.id,
    recipientName: "planner.lead.dev",
    senderName: "planner.lead",
    taskId: "build",
    kind: "team",
    prompt: "Build it.",
    createdAt: timestamp,
    attempts: 0,
    lastError: null,
    deliveredAt: null,
    deliveredToPaseoAgentId: null,
    consumedAt: null,
    failedAt: null,
  };
  await store.commit(() => [
    { op: "put", collection: "messages", record: queued },
    {
      op: "put",
      collection: "tasks",
      record: {
        id: "build",
        swarmId: dev.swarmId,
        title: "Build",
        brief: "Build it.",
        status: "open",
        managerName: "planner.lead",
        workerNames: ["planner.lead.dev"],
        createdBy: "planner.lead",
        data: {},
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    },
  ]);

  // A rename is a retirement plus a new seat. Retiring shows what refers to the seat, and its
  // mail fails with the reason and stays in the mailbox.
  writeFile(team("developer"));
  const renamed = (await up()).plan;
  assert.deepEqual(renamed.reserve, [{ seat: "planner.lead.developer", role: "developer" }]);
  assert.deepEqual(renamed.retire, [
    { seat: "planner.lead.dev", tasks: ["build"], queuedMessages: 1 },
  ]);
  assert.equal(seat("planner.lead.dev")?.retired, true);
  const failed = store.read().messages.find((message) => message.id === "queued")!;
  assert.equal(mailboxMessageStatus(failed), "failed");
  assert.match(failed.lastError ?? "", /retired/);

  // Naming the old seat again brings that seat back, not a new one.
  writeFile(team("dev"));
  const restored = (await up()).plan;
  assert.deepEqual(restored.restore, [{ seat: "planner.lead.dev", changes: [] }]);
  assert.equal(seat("planner.lead.dev")?.id, dev.id);
  assert.equal(seat("planner.lead.dev")?.retired, false);
  assert.equal(seat("planner.lead.developer")?.retired, true);
});

test("up refuses a role-class change and a directory that cannot run, and changes nothing", async (t) => {
  const { swarm, up, status, writeFile, seat } = await setup(t);
  await up(true);
  const accepted = store.read();

  writeFile(
    "version: 1\nseats:\n  planner: { role: supervisor, agent: { provider: claude/opus } }",
  );
  const diff = await up(true);
  assert.match(
    diff.plan.refusals.join(),
    /planner would change role class from planner to supervisor/,
  );
  await assert.rejects(up(), /swarm up refused/);

  writeFile(
    [
      "version: 1",
      "seats:",
      "  planner:",
      "    role: planner",
      "    team: { dev: { role: developer, agent: { provider: codex/gpt-6 } } }",
    ].join("\n"),
  );
  await assert.rejects(up(), /a planner's team holds supervisors/);
  writeFile(
    "version: 1\nseats:\n  planner: { role: planner, team: { lead: { role: supervisor } } }",
  );
  await assert.rejects(up(), /provider\/model/);
  writeFile("version: 1\nseats:\n  planner: { role: missing }");
  await assert.rejects(up(), /Missing role: missing/);
  assert.match((await status()).invalid ?? "", /Missing role: missing/);

  assert.deepEqual(store.read().agents, accepted.agents);
  assert.deepEqual(findSwarm(swarm.id).source, swarm.source);
  assert.equal(seat("planner")?.role, "planner");
});

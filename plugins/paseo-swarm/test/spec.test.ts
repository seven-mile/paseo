import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { noteTurnEnded, noteTurnStarted } from "../server/mailbox";
import { registerOperations } from "../server/operations";
import { parseSwarmFile } from "../server/roster";
import { assemblePrompt } from "../server/seats";
import { recoverIntents, specHooks } from "../server/spec";
import { store } from "../server/state";
import { createSwarm } from "../server/swarms";
import { mailboxMessageStatus, type AgentRecord, type MailboxMessage } from "../shared/models";
import {
  boardReadRpc,
  createSeatRpc,
  directoryRecoverRpc,
  directoryUpRpc,
  seatListRpc,
  seatRetireRpc,
  seatUpdateRpc,
  statusReadRpc,
} from "../shared/swarm";

const timestamp = "2026-10-25T00:00:00Z";

function writeRole(directory: string, role: string, roleClass: string) {
  writeFileSync(
    join(directory, "roles", `${role}.md`),
    `---\nversion: 1\nroleClass: ${roleClass}\n---\n${role}\n`,
  );
}

// Seat changes place seats only through workspaces their managers already have.
const context = {
  paseo: {
    workspaces: {
      ref: () => ({ refresh: async () => ({ projectId: undefined }) }),
    },
    agents: {
      ref: () => ({ refresh: async () => ({ agent: { workspaceId: "lead-workspace" } }) }),
      list: async () => ({
        entries: [{ agent: { id: "planner-agent" } }, { agent: { id: "lead-agent" } }],
        pageInfo: { nextCursor: null },
      }),
    },
  },
} as unknown as PluginHandlerContext;

async function setup(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "swarm-spec-"));
  const previousHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = home;
  t.after(() => {
    specHooks.afterStep = undefined;
    if (previousHome === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });
  const template = join(home, "template");
  mkdirSync(join(template, "roles"), { recursive: true });
  writeFileSync(join(template, "PWA.md"), "---\nversion: 1\nproject: Spec\n---\nAgreement.\n");
  writeRole(template, "planner", "planner");
  writeRole(template, "supervisor", "supervisor");
  writeRole(template, "developer", "worker");
  const swarm = await createSwarm({ sourceDirectory: template, projectId: null });
  const seated = (record: Omit<AgentRecord, "swarmId" | "prompt">): AgentRecord => ({
    ...record,
    swarmId: swarm.id,
    prompt: assemblePrompt(record, swarm.source.files).received,
  });
  const config = { provider: "claude/opus" };
  const planner = seated({
    id: "planner-record",
    paseoAgentId: "planner-agent",
    name: "planner",
    qualifiedName: "planner",
    aliases: [],
    roleClass: "planner",
    role: "planner",
    reportsTo: null,
    workspaceId: "planner-workspace",
    agentConfig: config,
    occupant: { number: 1, config, generation: 0, boundAt: timestamp },
    retired: false,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const lead = seated({
    ...planner,
    id: "lead-record",
    paseoAgentId: "lead-agent",
    name: "lead",
    qualifiedName: "planner.lead",
    roleClass: "supervisor",
    role: "supervisor",
    reportsTo: "planner",
    workspaceId: "lead-workspace",
  });
  await store.commit(() => [
    { op: "put", collection: "agents", record: planner },
    { op: "put", collection: "agents", record: lead },
  ]);
  const handlers = new Map<string, (input: never, context: PluginHandlerContext) => unknown>();
  registerOperations({
    handle(contract, handler) {
      handlers.set(contract.name, handler);
    },
  });
  const call = async <I, O>(
    rpc: {
      name: string;
      input: { parse(value: unknown): I };
      output: { parse(value: unknown): O };
    },
    input: Record<string, unknown>,
  ): Promise<O> =>
    rpc.output.parse(
      await handlers.get(rpc.name)!(
        rpc.input.parse({ swarmId: swarm.id, ...input }) as never,
        context,
      ),
    );
  const hire = (name: string, reportsTo = "planner.lead") =>
    call(createSeatRpc, {
      name,
      roleClass: "worker",
      role: "developer",
      reportsTo,
      provider: "codex/gpt-6",
    });
  const file = join(swarm.directory, "swarm.yaml");
  const status = () => call(statusReadRpc, {});
  // Writes swarm.yaml from the accepted seats, as the first status does.
  await status();
  const seat = (name: string) =>
    store.read().agents.filter((record) => record.qualifiedName === name);
  return { swarm, call, hire, file, status, seat, planner };
}

const read = (path: string) => readFileSync(path, "utf8");

test("a hire is in swarm.yaml and accepted when the tool returns, and comments survive", async (t) => {
  const { hire, file, status, seat, call } = await setup(t);
  writeFileSync(file, `# The team.\n${read(file)}`.replace("lead:", "lead: # runs the team"));
  const hired = await hire("dev");
  assert.equal(hired.paseoAgentId, null);
  assert.deepEqual(hired.pending, { kind: "start", reason: "no agent yet" });
  assert.equal(seat("planner.lead.dev").length, 1);
  const text = read(file);
  assert.match(text, /^# The team\./);
  assert.match(text, /# runs the team/);
  assert.deepEqual(
    parseSwarmFile(text).find((desired) => desired.qualifiedName === "planner.lead.dev"),
    {
      name: "dev",
      qualifiedName: "planner.lead.dev",
      reportsTo: "planner.lead",
      role: "developer",
      agentConfig: { provider: "codex/gpt-6" },
    },
  );
  // Nothing for up to undo.
  assert.equal((await status()).unapplied, null);
  assert.deepEqual(store.read().intents, []);
  // A person can message the reserved seat, so clients that read it see it on the board.
  const boardNames = async (includeReserved?: boolean) =>
    (await call(boardReadRpc, includeReserved ? { includeReserved } : {})).agents.map(
      (agent) => agent.qualifiedName,
    );
  assert.deepEqual(await boardNames(), ["planner", "planner.lead"]);
  assert.deepEqual(await boardNames(true), ["planner", "planner.lead", "planner.lead.dev"]);
  await assert.rejects(() => hire("helper", "planner"), /team holds supervisors/);
  await assert.rejects(
    () =>
      call(createSeatRpc, {
        name: "deep",
        roleClass: "worker",
        role: "developer",
        reportsTo: "planner.lead.dev",
        provider: "codex/gpt-6",
      }),
    /worker and has no team/,
  );
});

test("edits elsewhere in swarm.yaml do not block a seat change; the same section conflicts", async (t) => {
  const { hire, file, call, seat, planner } = await setup(t);
  // A pending role edit, not accepted.
  writeFileSync(file, read(file).replace("role: supervisor", "role: lead-v2 # pending"));
  await hire("dev");
  assert.match(read(file), /role: lead-v2 # pending/);

  // A seat updates its own agent while its turn runs: accepted now, the agent left as it is.
  noteTurnStarted(planner.paseoAgentId!);
  t.after(() => noteTurnEnded(planner.paseoAgentId!));
  const { seats } = await call(seatUpdateRpc, {
    seats: ["planner"],
    agentConfig: { provider: "claude/sonnet" },
  });
  assert.equal(seats[0].agentConfig?.provider, "claude/sonnet");
  assert.equal(seats[0].paseoAgentId, planner.paseoAgentId);
  assert.equal(seat("planner")[0].occupant?.config.provider, "claude/opus");
  assert.equal(
    parseSwarmFile(read(file)).find((desired) => desired.name === "planner")?.agentConfig.provider,
    "claude/sonnet",
  );

  // The same sections, edited and not accepted, conflict and change nothing.
  writeFileSync(file, read(file).replace("provider: claude/sonnet", "provider: claude/haiku"));
  const before = { text: read(file), state: store.read() };
  await assert.rejects(
    () => call(seatUpdateRpc, { seats: ["planner"], agentConfig: { modeId: "plan" } }),
    /swarm\.yaml conflict: the agent of planner has changes that are not accepted/,
  );
  writeFileSync(
    file,
    `${read(file)}          qa: { role: developer, agent: { provider: codex/gpt-6 } }\n`,
  );
  const withQa = read(file);
  assert.equal(parseSwarmFile(withQa).filter((desired) => desired.name === "qa").length, 1);
  await assert.rejects(
    () => hire("qa"),
    /swarm\.yaml conflict: it already names planner\.lead\.qa/,
  );
  assert.equal(read(file), withQa);
  assert.deepEqual(store.read().agents, before.state.agents);
  assert.deepEqual(store.read().intents, []);
});

test("a crash after each step recovers without a duplicate hire or an unrelated edit", async (t) => {
  const { hire, file, seat } = await setup(t);
  const crashAfter = (step: "intent" | "write") => {
    specHooks.afterStep = (reached) => {
      if (reached === step) throw new Error(`crash after ${step}`);
    };
  };
  const original = read(file);

  crashAfter("intent");
  await assert.rejects(() => hire("dev"), /crash after intent/);
  specHooks.afterStep = undefined;
  assert.equal(store.read().intents.length, 1);
  await recoverIntents();
  assert.deepEqual(store.read().intents, []);
  assert.equal(read(file), original);
  assert.equal(seat("planner.lead.dev").length, 0);

  crashAfter("write");
  await assert.rejects(() => hire("dev"), /crash after write/);
  specHooks.afterStep = undefined;
  assert.equal(seat("planner.lead.dev").length, 0);
  const written = read(file);
  await recoverIntents();
  assert.deepEqual(store.read().intents, []);
  assert.equal(seat("planner.lead.dev").length, 1);
  assert.equal(read(file), written);
  // Recovering again, or hiring the same name again, adds nothing.
  await recoverIntents();
  await assert.rejects(() => hire("dev"), /already exists/);
  assert.equal(seat("planner.lead.dev").length, 1);
  assert.equal(parseSwarmFile(read(file)).filter((desired) => desired.name === "dev").length, 1);
});

test("a file that matches neither side holds seat changes until recover resolves it", async (t) => {
  const { hire, file, seat, status, call } = await setup(t);
  for (const keep of ["file", "intent"] as const) {
    specHooks.afterStep = (step) => {
      if (step === "intent") throw new Error("crash");
    };
    await assert.rejects(() => hire(`dev-${keep}`), /crash/);
    specHooks.afterStep = undefined;
    writeFileSync(file, `${read(file)}# edited by hand (${keep})\n`);
    await recoverIntents();
    const { recovery } = await status();
    assert.match(
      recovery ?? "",
      /changed while a change to planner\.lead\.dev-\w+ was being written/,
    );
    await assert.rejects(() => hire("other"), /swarm recover --keep-file/);
    await assert.rejects(() => call(directoryUpRpc, { dryRun: false }), /swarm recover/);
    const resolved = await call(directoryRecoverRpc, { keep });
    assert.deepEqual(resolved.seats, [`planner.lead.dev-${keep}`]);
    assert.equal((await status()).recovery, null);
    assert.match(read(file), new RegExp(`# edited by hand \\(${keep}\\)`));
    const named = parseSwarmFile(read(file)).some((desired) => desired.name === `dev-${keep}`);
    assert.equal(named, keep === "intent");
    assert.equal(seat(`planner.lead.dev-${keep}`).length, keep === "intent" ? 1 : 0);
  }
  await hire("other");
});

test("retiring a seat takes it out of swarm.yaml and fails its queued mail", async (t) => {
  const { hire, file, seat, status, call } = await setup(t);
  const dev = await hire("dev");
  const queued: MailboxMessage = {
    id: "queued",
    recipientAgentId: dev.id,
    recipientName: "planner.lead.dev",
    senderName: "planner.lead",
    taskId: null,
    kind: "team",
    prompt: "Start",
    createdAt: timestamp,
    attempts: 0,
    lastError: null,
    deliveredAt: null,
    deliveredToPaseoAgentId: null,
    consumedAt: null,
    failedAt: null,
  };
  await store.commit(() => [{ op: "put", collection: "messages", record: queued }]);
  await assert.rejects(
    () => call(seatRetireRpc, { seat: "planner.lead" }),
    /Retire the seats that report to planner\.lead first: planner\.lead\.dev/,
  );
  await assert.rejects(
    () => call(seatRetireRpc, { seat: "planner.lead.dev", actorName: "planner.lead.dev" }),
    /cannot retire/,
  );
  const { seat: retired } = await call(seatRetireRpc, {
    seat: "planner.lead.dev",
    actorName: "planner.lead",
  });
  assert.equal(retired.retired, true);
  assert.equal(seat("planner.lead.dev")[0].retired, true);
  const message = store.read().messages.find((candidate) => candidate.id === "queued")!;
  assert.equal(mailboxMessageStatus(message), "failed");
  assert.equal(message.lastError, "Seat planner.lead.dev was retired");
  assert.equal(
    parseSwarmFile(read(file)).some((desired) => desired.name === "dev"),
    false,
  );
  assert.equal((await status()).unapplied, null);
});

test("the agent of a retired seat is still found as a Swarm agent", async (t) => {
  const { call } = await setup(t);
  await call(seatRetireRpc, { seat: "planner.lead" });
  const listed = (includeRetired: boolean) =>
    call(seatListRpc, { paseoAgentId: "lead-agent", includeRetired });
  assert.deepEqual((await listed(false)).seats, []);
  assert.equal((await listed(true)).seats[0]?.qualifiedName, "planner.lead");
});

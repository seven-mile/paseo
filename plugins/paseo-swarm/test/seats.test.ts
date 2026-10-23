import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import type {
  PluginHandlerContext,
  PluginHookContext,
  PluginServerContext,
} from "@getpaseo/plugin/server";
import contribute from "../index.server";
import { flushMailbox, forgetRunningTurns, MAX_DELIVERY_ATTEMPTS } from "../server/mailbox";
import { registerOperations } from "../server/operations";
import { store } from "../server/state";
import { mailboxMessageStatus, occupantStaleReason, type AgentRecord } from "../shared/models";
import {
  appendActivityRpc,
  createTaskRpc,
  seatHistoryReadRpc,
  seatListRpc,
  seatResetRpc,
  seatUpdateRpc,
  sendMessageRpc,
} from "../shared/swarm";

const timestamp = "2026-10-23T00:00:00Z";
const supervisor: AgentRecord = {
  id: "supervisor-record",
  paseoAgentId: "supervisor-agent",
  name: "lead",
  qualifiedName: "lead",
  aliases: [],
  roleClass: "supervisor",
  role: "supervisor",
  reportsTo: null,
  workspaceId: "workspace",
  agentConfig: { provider: "slow/large", modeId: "default" },
  generation: 0,
  occupant: {
    number: 1,
    config: { provider: "slow/large", modeId: "default", thinkingOptionId: "high" },
    generation: 0,
    boundAt: timestamp,
  },
  retired: false,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const worker: AgentRecord = {
  ...supervisor,
  id: "worker-record",
  paseoAgentId: "worker-agent",
  name: "dev",
  qualifiedName: "lead.dev",
  roleClass: "worker",
  role: "developer",
  reportsTo: "lead",
};

interface Runtime {
  status: string;
  provider: string;
  model: string | null;
  currentModeId: string | null;
  thinkingOptionId: string | null;
  cwd: string;
  parent?: string;
  archived?: boolean;
}

function fakePaseo() {
  const runtime = new Map<string, Runtime>();
  const calls: string[] = [];
  const sends: Array<{ agentId: string; text: string }> = [];
  const creations: Array<{ workspaceId: string; config: Record<string, unknown> }> = [];
  const timeline: Array<{ seq: number; item: Record<string, unknown> }> = [];
  let failCreate: string | null = null;
  let failLookup: string | null = null;
  let created = 0;
  const context = {
    signal: new AbortController().signal,
    paseo: {
      agents: {
        // One agent per page, so every caller has to follow the cursor.
        async list(input: { page?: { cursor?: string } }) {
          const live = [...runtime].filter(([, agent]) => !agent.archived);
          const index = Number(input.page?.cursor ?? 0);
          return {
            entries: live.slice(index, index + 1).map(([id, agent]) => ({
              agent: {
                id,
                workspaceId: "workspace",
                labels: agent.parent ? { "paseo.parent-agent-id": agent.parent } : {},
              },
            })),
            pageInfo: { nextCursor: index + 1 < live.length ? String(index + 1) : null },
          };
        },
        ref(agentId: string) {
          return {
            async refresh() {
              if (failLookup) throw new Error(failLookup);
              const agent = runtime.get(agentId);
              return agent ? { agent: { id: agentId, workspaceId: "workspace", ...agent } } : null;
            },
            async send(text: string) {
              sends.push({ agentId, text });
            },
            async detach() {
              calls.push(`detach ${agentId}`);
              delete runtime.get(agentId)!.parent;
            },
            async archive() {
              calls.push(`archive ${agentId}`);
              runtime.get(agentId)!.archived = true;
            },
            timeline: {
              async refetch(input: { direction: string; cursor?: { seq: number }; limit: number }) {
                const end = input.cursor ? input.cursor.seq : timeline.length;
                const start = Math.max(0, end - input.limit);
                return {
                  entries: timeline.slice(start, end),
                  hasOlder: start > 0,
                  startCursor: start > 0 ? { epoch: "e", seq: start } : null,
                };
              },
            },
          };
        },
      },
      workspaces: {
        ref(workspaceId: string) {
          return {
            agents: {
              async create(creation: { config: Record<string, unknown> }) {
                if (failCreate) throw new Error(failCreate);
                created += 1;
                const id = `replacement-${created}`;
                creations.push({ workspaceId, config: creation.config });
                runtime.set(id, {
                  status: "idle",
                  provider: "fast",
                  model: null,
                  currentModeId: null,
                  thinkingOptionId: null,
                  cwd: "/repo",
                });
                return { id };
              },
            },
          };
        },
      },
    },
  } as unknown as PluginHookContext & PluginHandlerContext;
  return {
    context,
    runtime,
    calls,
    sends,
    creations,
    timeline,
    failCreate(message: string | null) {
      failCreate = message;
    },
    failLookup(message: string | null) {
      failLookup = message;
    },
  };
}

function setup(t: { after(fn: () => void): void }) {
  const home = mkdtempSync(join(tmpdir(), "swarm-seats-"));
  const previousHome = process.env.PASEO_HOME;
  const previousPwa = process.env.PASEO_SWARM_PWA_ROOT;
  process.env.PASEO_HOME = home;
  process.env.PASEO_SWARM_PWA_ROOT = resolve(__dirname, "../pwa/pr-workflow");
  t.after(() => {
    if (previousHome === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = previousHome;
    if (previousPwa === undefined) delete process.env.PASEO_SWARM_PWA_ROOT;
    else process.env.PASEO_SWARM_PWA_ROOT = previousPwa;
    rmSync(home, { recursive: true, force: true });
  });
  const handlers = new Map<string, (input: never, context: PluginHandlerContext) => unknown>();
  const hooks = new Map<string, (event: never, context: PluginHookContext) => unknown>();
  const server: Pick<PluginServerContext, "handle" | "on"> = {
    handle(contract, handler) {
      handlers.set(contract.name, handler);
    },
    on(name, handler) {
      hooks.set(name, handler);
      return () => {};
    },
  };
  registerOperations(server);
  contribute(server as PluginServerContext);
  forgetRunningTurns();
  const call = <T>(
    rpc: { name: string; input: { parse(value: unknown): unknown } },
    input: unknown,
    context: PluginHandlerContext,
  ) => handlers.get(rpc.name)!(rpc.input.parse(input) as never, context) as Promise<T>;
  const turn = (
    event: "agent.turn_started" | "agent.turn_ended",
    agentId: string,
    context: PluginHookContext,
    outcome: Record<string, unknown> = { kind: "completed" },
  ) =>
    hooks.get(event)!(
      {
        agent: { id: agentId, workspaceId: "workspace", provider: "slow", cwd: "/repo" },
        turnId: "turn",
        outcome,
        timeline: [],
        turnTimeline: [],
      } as never,
      context,
    );
  return { call, turn };
}

async function seed(fake: ReturnType<typeof fakePaseo>, agents: AgentRecord[]) {
  await store.commit(() => agents.map((record) => ({ op: "put", collection: "agents", record })));
  for (const agent of agents) {
    fake.runtime.set(agent.paseoAgentId, {
      status: "idle",
      provider: "slow",
      model: "large",
      currentModeId: "default",
      thinkingOptionId: "high",
      cwd: "/repo",
      ...(agent.reportsTo ? { parent: supervisor.paseoAgentId } : {}),
    });
  }
}

function seat(id: string): AgentRecord {
  return store.read().agents.find((agent) => agent.id === id)!;
}

interface Seats {
  seats: Array<AgentRecord & { stale: string | null }>;
}

test("staleness compares only the fields a seat specifies", () => {
  assert.equal(occupantStaleReason(supervisor), null);
  assert.equal(
    occupantStaleReason({ ...supervisor, agentConfig: { provider: "slow" } }),
    null,
    "a bare provider matches any of its models",
  );
  assert.equal(
    occupantStaleReason({ ...supervisor, agentConfig: { provider: "fast" } }),
    "provider slow/large → fast",
  );
  assert.equal(
    occupantStaleReason({ ...supervisor, agentConfig: { thinkingOptionId: "low" } }),
    "thinking high → low",
  );
  assert.equal(occupantStaleReason({ ...supervisor, generation: 1 }), "reset");
  assert.equal(
    occupantStaleReason({ ...supervisor, agentConfig: undefined, occupant: undefined }),
    null,
    "a seat from before seats existed is current",
  );
});

test("a seat edit takes effect when mail next wakes the seat, and never wakes the old agent", async (t) => {
  const { call, turn } = setup(t);
  const fake = fakePaseo();
  await seed(fake, [supervisor, worker]);

  // Mode names mean different things across providers, so a switch has to name its mode.
  await assert.rejects(
    call(
      seatUpdateRpc,
      { seats: ["lead", "lead.dev"], agentConfig: { provider: "fast" } },
      fake.context,
    ),
    /Changing to provider fast needs a mode for it: lead, lead\.dev/,
  );
  const preview = await call<Seats>(
    seatUpdateRpc,
    { seats: ["lead"], agentConfig: { provider: "fast", modeId: "plan" }, dryRun: true },
    fake.context,
  );
  assert.equal(preview.seats[0].stale, "provider slow/large → fast");
  assert.equal(seat(supervisor.id).agentConfig?.provider, "slow/large", "a dry run saves nothing");

  // Edited back before any mail arrives, the seat is current again and nothing happened.
  await call(
    seatUpdateRpc,
    { seats: ["lead"], agentConfig: { provider: "fast", modeId: "plan" } },
    fake.context,
  );
  await call(
    seatUpdateRpc,
    { seats: ["lead"], agentConfig: { provider: "slow", modeId: "default" } },
    fake.context,
  );
  assert.equal(seat(supervisor.id).paseoAgentId, supervisor.paseoAgentId);
  assert.equal(fake.creations.length, 0);

  await call(
    seatUpdateRpc,
    { seats: ["lead"], agentConfig: { thinkingOptionId: "high" } },
    fake.context,
  );
  await call(
    seatUpdateRpc,
    { seats: [supervisor.id], agentConfig: { provider: "fast", modeId: "build" } },
    fake.context,
  );
  assert.deepEqual(
    seat(supervisor.id).agentConfig,
    { provider: "fast", modeId: "build" },
    "the old provider's thinking option is dropped",
  );
  assert.equal(fake.creations.length, 0, "a seat with no mail is not replaced");
  const listed = await call<Seats>(seatListRpc, {}, fake.context);
  assert.equal(
    listed.seats.find((entry) => entry.id === supervisor.id)?.stale,
    "provider slow/large → fast",
  );

  await call(
    sendMessageRpc,
    {
      recipientPaseoAgentId: supervisor.paseoAgentId,
      recipientName: "lead",
      senderName: "human",
      body: "Status?",
    },
    fake.context,
  );

  const replaced = seat(supervisor.id);
  assert.equal(replaced.paseoAgentId, "replacement-1");
  assert.equal(occupantStaleReason(replaced), null);
  // Nothing of the old provider carries over, including the thinking option the old agent ran.
  assert.deepEqual(replaced.occupant?.config, { provider: "fast", modeId: "build" });
  assert.equal(replaced.occupant?.number, 2);
  assert.deepEqual(
    replaced.pastOccupants?.map((past) => [past.number, past.paseoAgentId, past.reason]),
    [[1, supervisor.paseoAgentId, "provider slow/large → fast"]],
  );
  assert.equal(fake.creations[0].workspaceId, "workspace");
  assert.equal(fake.creations[0].config.provider, "fast");
  assert.equal("parent" in fake.creations[0], false);
  assert.match(String(fake.creations[0].config.systemPrompt), /occupant 2 of the Swarm seat lead/);
  // The worker is detached first so archiving the old supervisor does not take it along.
  assert.deepEqual(fake.calls, [
    `detach ${worker.paseoAgentId}`,
    `archive ${supervisor.paseoAgentId}`,
  ]);
  assert.deepEqual(
    fake.sends.map((entry) => entry.agentId),
    ["replacement-1"],
  );
  assert.match(fake.sends[0].text, /Status\?/);

  // The worker's turn ends reach the seat's new agent.
  await turn("agent.turn_ended", worker.paseoAgentId, fake.context);
  assert.equal(fake.sends.at(-1)?.agentId, "replacement-1");
});

test("a stale agent finishes its turn before it is replaced, and unfinished mail moves over", async (t) => {
  const { call, turn } = setup(t);
  const fake = fakePaseo();
  await seed(fake, [supervisor, worker]);
  const send = (body: string) =>
    call(
      sendMessageRpc,
      {
        recipientPaseoAgentId: seat(worker.id).paseoAgentId,
        recipientName: "lead.dev",
        senderName: "lead",
        actorName: "lead",
        body,
      },
      fake.context,
    );

  fake.runtime.get(worker.paseoAgentId)!.status = "running";
  await turn("agent.turn_started", worker.paseoAgentId, fake.context);
  await send("Steered into the running turn");
  assert.equal(fake.sends.length, 1);

  await call(seatResetRpc, { seats: ["lead.dev"] }, fake.context);
  await send("Held until the turn ends");
  assert.equal(fake.sends.length, 1, "a stale agent is never woken again");
  assert.equal(fake.creations.length, 0);

  // The turn failed, so the steered message was never consumed.
  fake.runtime.get(worker.paseoAgentId)!.status = "idle";
  await turn("agent.turn_ended", worker.paseoAgentId, fake.context, {
    kind: "failed",
    error: { message: "provider down" },
  });
  const replaced = seat(worker.id);
  assert.equal(replaced.paseoAgentId, "replacement-1");
  assert.equal(replaced.occupant?.generation, 1);
  // A reset on the same provider keeps what the previous agent ran.
  assert.deepEqual(replaced.occupant?.config, {
    provider: "slow/large",
    modeId: "default",
    thinkingOptionId: "high",
  });
  assert.deepEqual(
    fake.sends
      .slice(1)
      .filter((entry) => entry.agentId !== supervisor.paseoAgentId)
      .map((entry) => [entry.agentId, /Steered|Held/.exec(entry.text)?.[0]]),
    [
      ["replacement-1", "Steered"],
      ["replacement-1", "Held"],
    ],
  );
});

test("a cancelled reset and a failed replacement leave the seat's agent in place", async (t) => {
  const { call } = setup(t);
  const fake = fakePaseo();
  await seed(fake, [supervisor]);

  await call(seatResetRpc, { seats: ["lead"] }, fake.context);
  assert.equal(seat(supervisor.id).generation, 1);
  const cancelled = await call<Seats>(
    seatResetRpc,
    { seats: ["lead"], cancel: true },
    fake.context,
  );
  assert.equal(cancelled.seats[0].stale, null);

  await call(seatResetRpc, { seats: ["lead"] }, fake.context);
  fake.failCreate("provider unavailable");
  await call(
    sendMessageRpc,
    {
      recipientPaseoAgentId: supervisor.paseoAgentId,
      recipientName: "lead",
      senderName: "human",
      body: "Hello",
    },
    fake.context,
  );
  // A provider that stays down past the send retry limit does not fail the mail.
  for (let flush = 0; flush < MAX_DELIVERY_ATTEMPTS + 2; flush += 1) {
    await flushMailbox(fake.context);
  }
  const [message] = store.read().messages;
  assert.equal(mailboxMessageStatus(message), "queued");
  assert.equal(message.attempts, 0);
  assert.match(
    message.lastError ?? "",
    /Could not replace the agent in seat lead: provider unavailable/,
  );
  assert.equal(seat(supervisor.id).paseoAgentId, supervisor.paseoAgentId);
  assert.equal(fake.sends.length, 0);

  fake.failCreate(null);
  await flushMailbox(fake.context);
  assert.equal(seat(supervisor.id).paseoAgentId, "replacement-1");
  assert.equal(fake.sends[0].agentId, "replacement-1");
  assert.equal(mailboxMessageStatus(store.read().messages[0]), "delivered");
});

test("a seat whose agent status cannot be read is held, and an edit reports the seat it bound", async (t) => {
  const { call } = setup(t);
  const fake = fakePaseo();
  await seed(fake, [supervisor]);
  await call(seatResetRpc, { seats: ["lead"] }, fake.context);

  fake.failLookup("daemon busy");
  await call(
    sendMessageRpc,
    {
      recipientPaseoAgentId: supervisor.paseoAgentId,
      recipientName: "lead",
      senderName: "human",
      body: "Hello",
    },
    fake.context,
  );
  const [message] = store.read().messages;
  assert.equal(mailboxMessageStatus(message), "queued");
  assert.equal(message.attempts, 0);
  assert.match(message.lastError ?? "", /Could not check the agent in seat lead: daemon busy/);
  assert.equal(fake.creations.length, 0, "an agent that may be mid-turn is not replaced");

  fake.failLookup(null);
  const updated = await call<Seats>(
    seatUpdateRpc,
    { seats: ["lead"], agentConfig: { thinkingOptionId: "high" } },
    fake.context,
  );
  assert.equal(updated.seats[0].paseoAgentId, "replacement-1");
  assert.equal(updated.seats[0].stale, null);
});

test("a seat from before seats existed is stamped with what its agent runs", async (t) => {
  const { call } = setup(t);
  const fake = fakePaseo();
  const legacy: AgentRecord = {
    ...supervisor,
    agentConfig: undefined,
    generation: undefined,
    occupant: undefined,
  };
  await seed(fake, [legacy]);
  const result = await call<Seats>(
    seatUpdateRpc,
    { seats: ["lead"], agentConfig: { provider: "slow" } },
    fake.context,
  );
  assert.equal(result.seats[0].stale, null, "the live agent already runs the wanted provider");
  assert.deepEqual(seat(supervisor.id).occupant?.config, {
    provider: "slow/large",
    modeId: "default",
    thinkingOptionId: "high",
  });
});

interface History {
  occupant: number;
  entries: Array<{ text: string }>;
  nextBefore: string | null;
}

test("earlier transcripts are paged newest first, and readable only within the reader's team", async (t) => {
  const { call } = setup(t);
  const fake = fakePaseo();
  await seed(fake, [supervisor, worker]);
  for (let seq = 1; seq <= 3; seq += 1) {
    fake.timeline.push({ seq, item: { type: "assistant_message", text: `Step ${seq}` } });
  }
  fake.timeline.push({ seq: 4, item: { type: "tool_call", name: "edit", status: "completed" } });
  await call(seatResetRpc, { seats: ["lead.dev"] }, fake.context);
  await flushMailbox(fake.context);
  await call(
    sendMessageRpc,
    {
      recipientPaseoAgentId: worker.paseoAgentId,
      recipientName: "lead.dev",
      senderName: "lead",
      actorName: "lead",
      body: "Resume",
    },
    fake.context,
  );
  assert.equal(seat(worker.id).paseoAgentId, "replacement-1");

  const first = await call<History>(
    seatHistoryReadRpc,
    { seat: "lead.dev", actorName: "lead", limit: 2 },
    fake.context,
  );
  assert.equal(first.occupant, 1);
  assert.deepEqual(
    first.entries.map((entry) => entry.text),
    ["edit (completed)", "Step 3"],
  );
  const older = await call<History>(
    seatHistoryReadRpc,
    { seat: "lead.dev", before: first.nextBefore, limit: 2 },
    fake.context,
  );
  assert.deepEqual(
    older.entries.map((entry) => entry.text),
    ["Step 2", "Step 1"],
  );
  assert.equal(older.nextBefore, null);

  await assert.rejects(
    call(seatHistoryReadRpc, { seat: "lead", actorName: "lead.dev" }, fake.context),
    /cannot read the history of seat lead/,
  );
});

test("Activities record which agent in the seat wrote them", async (t) => {
  const { call } = setup(t);
  const fake = fakePaseo();
  await seed(fake, [{ ...supervisor, roleClass: "planner", role: "planner" }]);
  await call(
    createTaskRpc,
    {
      id: "task",
      title: "Task",
      brief: "Brief",
      status: "survey",
      managerName: "lead",
      workerNames: [],
      createdBy: "lead",
      data: {},
    },
    fake.context,
  );
  const activity = await call<{ actorOccupant?: number }>(
    appendActivityRpc,
    { taskId: "task", actorName: "lead", kind: "note", body: "Note" },
    fake.context,
  );
  assert.equal(activity.actorOccupant, 1);
});

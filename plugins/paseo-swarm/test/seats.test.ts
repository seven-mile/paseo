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
import { assemblePrompt } from "../server/seats";
import { store } from "../server/state";
import { mailboxMessageStatus, type AgentRecord } from "../shared/models";
import { bootConfig, planSeat, settingsLostOnProviderChange } from "../server/seat-policy";
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
  const applied: Array<{ agentId: string; config: Record<string, unknown> }> = [];
  const failSend = new Set<string>();
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
              if (failSend.has(agentId)) throw new Error(`Cannot resume ${agentId}`);
              sends.push({ agentId, text });
              const agent = runtime.get(agentId);
              if (agent) agent.archived = false;
            },
            async applyConfig(config: Record<string, unknown>) {
              applied.push({ agentId, config });
              const agent = runtime.get(agentId)!;
              if (typeof config.modeId === "string") agent.currentModeId = config.modeId;
              if (typeof config.modelId === "string") agent.model = config.modelId;
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
    applied,
    failSend,
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

// Seeded seats carry the current standing prompt, so delivery has no refresh to send them.
async function seed(fake: ReturnType<typeof fakePaseo>, agents: AgentRecord[]) {
  await store.commit(() =>
    agents.map((record) => ({
      op: "put",
      collection: "agents",
      record: { ...record, prompt: assemblePrompt(record, record.projectId).received },
    })),
  );
  for (const agent of agents) {
    fake.runtime.set(agent.paseoAgentId!, {
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
  seats: Array<AgentRecord & { pending: { kind: string; reason: string } | null }>;
}

test("the seat policy keeps, adjusts, revives, or replaces an agent by what a change costs", () => {
  const kind = (patch: Partial<AgentRecord>) => planSeat({ ...supervisor, ...patch }).kind;
  assert.equal(kind({}), "keep");
  assert.equal(
    kind({ agentConfig: { provider: "slow" } }),
    "keep",
    "a bare provider fits any model",
  );
  assert.equal(kind({ agentConfig: { thinkingOptionId: "low" } }), "adjust");
  assert.deepEqual(planSeat({ ...supervisor, agentConfig: { modeId: "plan" } }), {
    kind: "adjust",
    reason: "mode default → plan",
    apply: { modeId: "plan" },
  });
  assert.equal(kind({ generation: 1 }), "replace", "a reset asks for a clean context");
  assert.equal(kind({ agentConfig: undefined, occupant: undefined }), "keep");

  // A model switch keeps its context only on providers known to allow it.
  const on = (running: string, wanted: string) =>
    planSeat({
      ...supervisor,
      agentConfig: { provider: wanted },
      occupant: { ...supervisor.occupant!, config: { provider: running } },
    });
  assert.deepEqual(on("claude/opus", "claude/sonnet"), {
    kind: "adjust",
    reason: "provider claude/opus → claude/sonnet",
    apply: { modelId: "sonnet" },
  });
  assert.equal(on("copilot/claude-opus", "copilot/gpt").kind, "replace");
  assert.deepEqual(on("slow/large", "fast/small"), {
    kind: "replace",
    reason: "provider slow/large → fast/small",
  });

  // An earlier agent that fits the seat, give or take in-place changes, comes back.
  const earlier = {
    ...supervisor.occupant!,
    paseoAgentId: supervisor.paseoAgentId,
    retiredAt: timestamp,
    reason: "provider slow/large → fast/small",
  };
  const moved = {
    ...supervisor,
    agentConfig: { provider: "slow/large", modeId: "default" },
    occupant: { ...supervisor.occupant!, number: 2, config: { provider: "fast/small" } },
    pastOccupants: [earlier],
  };
  assert.equal(planSeat(moved).kind, "revive");
  assert.equal(
    planSeat({ ...moved, generation: 1, occupant: { ...moved.occupant, generation: 1 } }).kind,
    "replace",
    "no agent from before a reset comes back",
  );
  // Its return brief starts a turn, so an earlier agent that would need another mode first
  // does not come back.
  assert.equal(
    planSeat({ ...moved, agentConfig: { provider: "slow/large", modeId: "plan" } }).kind,
    "replace",
  );

  // Feature values are managed per key: keys the seat leaves out are not compared.
  const featured = {
    ...supervisor,
    occupant: { ...supervisor.occupant!, config: { featureValues: { fast: true, web: false } } },
  };
  assert.equal(planSeat({ ...featured, agentConfig: { featureValues: {} } }).kind, "keep");
  assert.equal(
    planSeat({ ...featured, agentConfig: { featureValues: { fast: true } } }).kind,
    "keep",
  );
  assert.deepEqual(planSeat({ ...featured, agentConfig: { featureValues: { web: true } } }), {
    kind: "adjust",
    reason: "features web",
    apply: { featureValues: { web: true } },
  });
});

test("a new agent boots from the seat alone, and a provider change drops settings it cannot keep", () => {
  // A cleared field is not brought back from the previous agent; a bare provider keeps its model.
  assert.deepEqual(
    bootConfig(
      { provider: "slow" },
      { provider: "slow/large", modeId: "default", thinkingOptionId: "high" },
    ),
    { provider: "slow/large" },
  );
  assert.deepEqual(bootConfig({}, { provider: "slow/large", modeId: "default" }), {
    provider: "slow/large",
  });
  assert.deepEqual(settingsLostOnProviderChange("claude/opus", "codex/gpt"), [
    "modeId",
    "thinkingOptionId",
    "featureValues",
  ]);
  assert.deepEqual(settingsLostOnProviderChange("claude/opus", "claude/sonnet"), []);
  assert.deepEqual(
    settingsLostOnProviderChange("opencode/anthropic/opus", "opencode/openai/gpt"),
    ["thinkingOptionId", "featureValues"],
    "another vendor behind OpenCode gets its own thinking variants and features",
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
    /needs provider\/model and a mode for it: lead \(fast\), lead\.dev \(fast\)/,
  );
  const preview = await call<Seats>(
    seatUpdateRpc,
    { seats: ["lead"], agentConfig: { provider: "fast/small", modeId: "plan" }, dryRun: true },
    fake.context,
  );
  assert.deepEqual(preview.seats[0].pending, {
    kind: "replace",
    reason: "provider slow/large → fast/small, mode default → plan",
  });
  assert.equal(seat(supervisor.id).agentConfig?.provider, "slow/large", "a dry run saves nothing");

  // Edited back before any mail arrives, the seat is current again and nothing happened.
  await call(
    seatUpdateRpc,
    { seats: ["lead"], agentConfig: { provider: "fast/small", modeId: "plan" } },
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
    { seats: [supervisor.id], agentConfig: { provider: "fast/small", modeId: "build" } },
    fake.context,
  );
  assert.deepEqual(
    seat(supervisor.id).agentConfig,
    { provider: "fast/small", modeId: "build" },
    "the old provider's thinking option is dropped",
  );
  assert.equal(fake.creations.length, 0, "a seat with no mail is not replaced");
  const listed = await call<Seats>(seatListRpc, {}, fake.context);
  assert.equal(
    listed.seats.find((entry) => entry.id === supervisor.id)?.pending?.reason,
    "provider slow/large → fast/small, mode default → build",
  );

  await call(
    sendMessageRpc,
    {
      recipientName: "lead",
      senderName: "human",
      body: "Status?",
    },
    fake.context,
  );

  const replaced = seat(supervisor.id);
  assert.equal(replaced.paseoAgentId, "replacement-1");
  assert.equal(planSeat(replaced).kind, "keep");
  // Nothing of the old provider carries over, including the thinking option the old agent ran.
  assert.deepEqual(replaced.occupant?.config, { provider: "fast/small", modeId: "build" });
  assert.equal(replaced.occupant?.number, 2);
  assert.deepEqual(
    replaced.pastOccupants?.map((past) => [past.number, past.paseoAgentId, past.reason]),
    [[1, supervisor.paseoAgentId, "provider slow/large → fast/small, mode default → build"]],
  );
  assert.equal(fake.creations[0].workspaceId, "workspace");
  assert.equal(fake.creations[0].config.provider, "fast/small");
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

test("an in-place change keeps the agent and its context", async (t) => {
  const { call } = setup(t);
  const fake = fakePaseo();
  await seed(fake, [supervisor]);
  const send = (body: string) =>
    call(
      sendMessageRpc,
      {
        recipientName: "lead",
        senderName: "human",
        body,
      },
      fake.context,
    );

  // A mode picked in the agent's own chat is drift the seat tolerates.
  fake.runtime.get(supervisor.paseoAgentId)!.currentModeId = "chat-picked";
  const listed = await call<Seats>(seatListRpc, {}, fake.context);
  assert.equal(listed.seats[0].pending, null, "drift alone does not change the plan");
  await call(
    seatUpdateRpc,
    { seats: ["lead"], agentConfig: { thinkingOptionId: "low" } },
    fake.context,
  );
  await send("Status?");
  assert.equal(fake.creations.length, 0);
  assert.deepEqual(fake.applied, [
    { agentId: supervisor.paseoAgentId, config: { thinkingOptionId: "low" } },
  ]);
  assert.equal(fake.runtime.get(supervisor.paseoAgentId)!.currentModeId, "chat-picked");
  assert.equal(seat(supervisor.id).occupant?.config.thinkingOptionId, "low");
  assert.equal(seat(supervisor.id).occupant?.number, 1);
  assert.equal(fake.sends.at(-1)?.agentId, supervisor.paseoAgentId);
});

test("moving a seat back brings back its earlier agent, or a new one if that cannot resume", async (t) => {
  const { call } = setup(t);
  const fake = fakePaseo();
  await seed(fake, [supervisor]);
  const send = (body: string) =>
    call(
      sendMessageRpc,
      {
        recipientName: "lead",
        senderName: "human",
        body,
      },
      fake.context,
    );
  const move = (provider: string, modeId: string) =>
    call(seatUpdateRpc, { seats: ["lead"], agentConfig: { provider, modeId } }, fake.context);

  await move("fast/small", "build");
  await send("On B");
  assert.equal(seat(supervisor.id).paseoAgentId, "replacement-1");

  const preview = await call<Seats>(
    seatUpdateRpc,
    { seats: ["lead"], agentConfig: { provider: "slow/large", modeId: "default" }, dryRun: true },
    fake.context,
  );
  assert.equal(preview.seats[0].pending?.kind, "revive");
  await move("slow/large", "default");
  await send("Back on A");
  const back = seat(supervisor.id);
  assert.equal(back.paseoAgentId, supervisor.paseoAgentId);
  assert.equal(back.occupant?.number, 1);
  assert.deepEqual(
    back.pastOccupants?.map((past) => [past.number, past.paseoAgentId]),
    [[2, "replacement-1"]],
  );
  assert.equal(fake.runtime.get("replacement-1")!.archived, true);
  assert.equal(fake.runtime.get(supervisor.paseoAgentId)!.archived, false);
  // The return brief goes first; "On B", which occupant 2 never finished, moves over with the mail.
  assert.deepEqual(
    fake.sends
      .slice(-3)
      .map((entry) => [entry.agentId, /seat lead again|On B|Back on A/.exec(entry.text)?.[0]]),
    [
      [supervisor.paseoAgentId, "seat lead again"],
      [supervisor.paseoAgentId, "On B"],
      [supervisor.paseoAgentId, "Back on A"],
    ],
  );
  assert.equal(fake.applied.length, 0);
  assert.equal(fake.creations.length, 1);

  // An earlier agent whose session cannot resume is a miss: the seat gets a new agent.
  await move("fast/small", "build");
  fake.failSend.add("replacement-1");
  await send("To B again");
  assert.equal(seat(supervisor.id).paseoAgentId, "replacement-2");
  assert.equal(seat(supervisor.id).occupant?.number, 3);
  assert.match(fake.sends.at(-1)!.text, /To B again/);
});

test("a stale agent finishes its turn before it is replaced, and unfinished mail moves over", async (t) => {
  const { call, turn } = setup(t);
  const fake = fakePaseo();
  await seed(fake, [supervisor, worker]);
  const send = (body: string) =>
    call(
      sendMessageRpc,
      {
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

  // A seat that pins only its provider keeps the model its agent runs.
  await call(
    seatUpdateRpc,
    { seats: ["lead.dev"], agentConfig: { provider: "slow" } },
    fake.context,
  );
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
  // A new agent boots from the seat alone: the bare provider keeps its model, and the thinking
  // option the seat never named is left to the provider's default.
  assert.equal(fake.creations[0].config.provider, "slow/large");
  assert.deepEqual(replaced.occupant?.config, { provider: "slow/large", modeId: "default" });
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
  assert.equal(cancelled.seats[0].pending, null);

  await call(seatResetRpc, { seats: ["lead"] }, fake.context);
  fake.failCreate("provider unavailable");
  await call(
    sendMessageRpc,
    {
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
    /Could not update the agent in seat lead: provider unavailable/,
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
  assert.equal(updated.seats[0].pending, null);
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
  assert.equal(result.seats[0].pending, null, "the live agent already runs the wanted provider");
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
      recipientName: "lead.dev",
      senderName: "lead",
      actorName: "lead",
      body: "Resume",
    },
    fake.context,
  );
  assert.equal(seat(worker.id).paseoAgentId, "replacement-1");

  const current = await call<History>(
    seatHistoryReadRpc,
    { seat: "lead.dev", actorName: "lead", limit: 2 },
    fake.context,
  );
  assert.equal(current.occupant, 2, "the current occupant by default");
  const first = await call<History>(
    seatHistoryReadRpc,
    { seat: "lead.dev", actorName: "lead", occupant: 1, limit: 2 },
    fake.context,
  );
  assert.equal(first.occupant, 1);
  assert.deepEqual(
    first.entries.map((entry) => entry.text),
    ["edit (completed)", "Step 3"],
  );
  const older = await call<History>(
    seatHistoryReadRpc,
    { seat: "lead.dev", occupant: 1, before: first.nextBefore, limit: 2 },
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

test("a reserved seat starts its agent on its first message, held while the start fails", async (t) => {
  const { call } = setup(t);
  const fake = fakePaseo();
  await seed(fake, [supervisor]);
  const reserved: AgentRecord = {
    ...worker,
    paseoAgentId: null,
    occupant: undefined,
    agentConfig: { provider: "fast/small", modeId: "build" },
  };
  await store.commit(() => [{ op: "put", collection: "agents", record: reserved }]);
  const listed = await call<Seats>(seatListRpc, {}, fake.context);
  assert.deepEqual(listed.seats.find((entry) => entry.id === worker.id)?.pending, {
    kind: "start",
    reason: "no agent yet",
  });
  const send = (body: string) =>
    call(
      sendMessageRpc,
      { recipientName: "dev", senderName: "lead", actorName: "lead", body },
      fake.context,
    );

  fake.failCreate("provider unavailable");
  await send("Start");
  assert.equal(seat(worker.id).paseoAgentId, null);
  const held = store.read().messages.at(-1)!;
  assert.equal(mailboxMessageStatus(held), "queued");
  assert.equal(held.attempts, 0);
  assert.match(held.lastError ?? "", /provider unavailable/);

  fake.failCreate(null);
  await flushMailbox(fake.context);
  const started = seat(worker.id);
  assert.equal(started.paseoAgentId, "replacement-1");
  assert.equal(started.occupant?.number, 1);
  assert.deepEqual(fake.creations[0].config.provider, "fast/small");
  assert.doesNotMatch(String(fake.creations[0].config.systemPrompt), /Orientation:|takeover/i);
  assert.equal(fake.runtime.get("replacement-1")!.parent, undefined);
  assert.deepEqual(
    fake.sends.map((entry) => [entry.agentId, entry.text.includes("Start")]),
    [["replacement-1", true]],
  );
});

test("an agent whose standing prompt is out of date gets the current one ahead of its mail", async (t) => {
  const { call } = setup(t);
  const fake = fakePaseo();
  await seed(fake, [supervisor]);
  await store.commit(() => [
    {
      op: "put",
      collection: "agents",
      record: {
        ...seat(supervisor.id),
        prompt: { revision: "old", pwaRevision: "old", receivedAt: timestamp },
      },
    },
  ]);
  const send = (body: string) =>
    call(sendMessageRpc, { recipientName: "lead", senderName: "human", body }, fake.context);
  await send("First");
  await send("Second");
  assert.deepEqual(
    fake.sends.map((entry) => /paseo-swarm-prompt-refresh|First|Second/.exec(entry.text)?.[0]),
    ["paseo-swarm-prompt-refresh", "First", "Second"],
  );
  assert.notEqual(seat(supervisor.id).prompt?.revision, "old");
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

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type {
  PluginHandlerContext,
  PluginHookContext,
  PluginLifecycleEvents,
  PluginServerContext,
} from "@getpaseo/plugin/server";
import contribute from "../index.server";
import {
  DIGEST_HOLD_LIMIT_MS,
  enqueueMessage,
  flushMailbox,
  forgetRunningTurns,
  MAX_DELIVERY_ATTEMPTS,
  SETTLED_MESSAGE_LIMIT,
} from "../server/mailbox";
import { registerOperations } from "../server/operations";
import { pwaFilesRevision } from "../server/pwa";
import { StateStore, store } from "../server/state";
import { swarmOf } from "../server/swarms";
import { seed as seedRecords, type Seeded } from "./fixtures";
import { mailboxMessageStatus, type AgentRecord } from "../shared/models";
import { mailboxReadRpc, sendMessageRpc } from "../shared/swarm";

const timestamp = "2026-10-22T00:00:00Z";
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
const worker: AgentRecord = {
  ...manager,
  id: "worker-record",
  paseoAgentId: "worker-agent",
  name: "worker",
  qualifiedName: "manager.worker",
  roleClass: "worker",
  role: "researcher",
  reportsTo: "manager",
};
const reviewer: AgentRecord = {
  ...worker,
  id: "reviewer-record",
  paseoAgentId: "reviewer-agent",
  name: "reviewer",
  qualifiedName: "manager.reviewer",
};

interface Send {
  agentId: string;
  text: string;
  messageId: string;
}

function fakePaseo() {
  const sends: Send[] = [];
  const failures = new Map<string, string>();
  const context = {
    signal: new AbortController().signal,
    paseo: {
      agents: {
        ref(agentId: string) {
          return {
            async send(text: string, options: { messageId: string }) {
              sends.push({ agentId, text, messageId: options.messageId });
              const failure = failures.get(agentId);
              if (failure) throw new Error(failure);
            },
          };
        },
      },
    },
  } as unknown as PluginHookContext & PluginHandlerContext;
  return { sends, failures, context };
}

function setup(t: { after(fn: () => void): void }) {
  const home = mkdtempSync(join(tmpdir(), "swarm-mailbox-"));
  const previousHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = previousHome;
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
  const hookAgent = (agent: AgentRecord) => ({
    id: agent.paseoAgentId,
    workspaceId: "workspace",
    parentAgentId: null,
    provider: "claude",
    cwd: home,
    title: null,
  });
  const turnStarted = (agent: AgentRecord, context: PluginHookContext) =>
    hooks.get("agent.turn_started")!({ agent: hookAgent(agent), turnId: "turn" } as never, context);
  const turnEnded = (
    agent: AgentRecord,
    outcome: PluginLifecycleEvents["agent.turn_ended"]["outcome"],
    context: PluginHookContext,
    turnTimeline: PluginLifecycleEvents["agent.turn_ended"]["timeline"] = [],
  ) =>
    hooks.get("agent.turn_ended")!(
      {
        agent: hookAgent(agent),
        turnId: "turn",
        outcome,
        timeline: turnTimeline,
        turnTimeline,
      } as never,
      context,
    );
  const send = (context: PluginHandlerContext, body: string) =>
    handlers.get(sendMessageRpc.name)!(
      sendMessageRpc.input.parse({
        recipientName: "manager.worker",
        senderName: "manager",
        actorName: "manager",
        body,
      }) as never,
      context,
    ) as Promise<ReturnType<typeof sendMessageRpc.output.parse>>;
  const readMailbox = (context: PluginHandlerContext, input: Record<string, unknown> = {}) =>
    handlers.get(mailboxReadRpc.name)!(
      mailboxReadRpc.input.parse(input) as never,
      context,
    ) as Promise<ReturnType<typeof mailboxReadRpc.output.parse>>;
  const sendTo = (context: PluginHandlerContext, recipient: AgentRecord, body: string) =>
    handlers.get(sendMessageRpc.name)!(
      sendMessageRpc.input.parse({
        recipientName: recipient.qualifiedName,
        senderName: "outsider",
        body,
      }) as never,
      context,
    ) as Promise<ReturnType<typeof sendMessageRpc.output.parse>>;
  return { turnStarted, turnEnded, send, sendTo, readMailbox };
}

async function seed(agents: Seeded["agents"]) {
  await seedRecords({ agents });
}

test("an undeliverable message stays queued, survives a restart, and is retried in order", async (t) => {
  const { turnEnded, send, readMailbox } = setup(t);
  const { sends, failures, context } = fakePaseo();
  await seed([manager, worker]);
  failures.set(worker.paseoAgentId, "Agent is offline");

  const first = await send(context, "First assignment");
  assert.equal(first.delivered, false);
  assert.equal(first.status, "queued");
  assert.match(first.receipt, /queued in the recipient's Swarm mailbox/);
  assert.match(first.receipt, /Agent is offline/);
  const second = await send(context, "Second assignment");
  assert.equal(second.status, "queued");
  // The second send retried the first message and stopped there, keeping order.
  assert.deepEqual(
    sends.map((entry) => entry.messageId),
    [first.messageId, first.messageId],
  );

  const persisted = new StateStore().read().messages;
  assert.deepEqual(
    persisted.map((message) => [message.id, mailboxMessageStatus(message), message.attempts]),
    [
      [first.messageId, "queued", 2],
      [second.messageId, "queued", 0],
    ],
  );
  assert.equal(
    persisted[0].prompt,
    `<paseo-swarm-team-message id="${first.messageId}" from="manager" to="manager.worker">\nFirst assignment\n</paseo-swarm-team-message>`,
  );

  failures.delete(worker.paseoAgentId);
  sends.length = 0;
  await turnEnded(manager, { kind: "completed" }, context);
  assert.deepEqual(
    sends.map((entry) => [entry.agentId, entry.messageId]),
    [
      [worker.paseoAgentId, first.messageId],
      [worker.paseoAgentId, second.messageId],
    ],
  );
  assert.match(sends[0].text, /First assignment/);
  const delivered = await readMailbox(context, { recipientName: "manager.worker" });
  assert.deepEqual(
    delivered.messages.map((message) => [message.id, message.status]),
    [
      [second.messageId, "delivered"],
      [first.messageId, "delivered"],
    ],
  );
  assert.equal(delivered.messages[0].deliveredToPaseoAgentId, worker.paseoAgentId);
});

test("a completed turn marks delivered mail consumed; a failed turn does not", async (t) => {
  const { turnEnded, send, readMailbox } = setup(t);
  const { context } = fakePaseo();
  await seed([manager, worker]);

  const result = await send(context, "Check the build");
  assert.equal(result.status, "delivered");
  assert.match(result.receipt, /delivered to manager\.worker's Swarm mailbox/);

  await turnEnded(worker, { kind: "failed", error: { message: "provider down" } }, context);
  const afterFailure = await readMailbox(context, { senderName: "manager" });
  assert.equal(afterFailure.messages[0].status, "delivered");

  await turnEnded(worker, { kind: "completed" }, context);
  const afterCompletion = await readMailbox(context, { senderName: "manager" });
  assert.equal(afterCompletion.messages[0].status, "consumed");
  const runtime = await readMailbox(context, { recipientName: "manager" });
  assert.ok(runtime.messages.every((message) => message.kind === "runtime"));
});

test("mail waits behind a standing prompt that could not be delivered", async (t) => {
  const { send } = setup(t);
  const { sends, failures, context } = fakePaseo();
  await seed([manager, worker]);
  const received = () =>
    store.read().agents.find((agent) => agent.id === worker.id)!.prompt!.revision;
  const before = received();
  // An accepted role change gives the worker a new standing prompt.
  const swarm = swarmOf(store.read().agents.find((agent) => agent.id === worker.id)!);
  const files = {
    ...swarm.source.files,
    "roles/researcher.md": swarm.source.files["roles/researcher.md"] + "\nCite every source.\n",
  };
  await store.commit(() => [
    {
      op: "put",
      collection: "swarms",
      record: { ...swarm, source: { revision: pwaFilesRevision(files), files } },
    },
  ]);
  failures.set(worker.paseoAgentId!, "Agent is offline");

  const held = await send(context, "Survey the API");
  assert.equal(held.status, "queued");
  assert.match(held.receipt, /Could not refresh the standing prompt of seat manager\.worker/);
  assert.deepEqual(
    sends.map((entry) => entry.messageId.startsWith("prompt-refresh-")),
    [true],
  );
  const stored = store.read().messages.find((message) => message.id === held.messageId)!;
  assert.equal(stored.attempts, 0);
  assert.equal(received(), before);

  // The next flush sends the prompt, then the mail, and only then moves the receipt.
  failures.delete(worker.paseoAgentId!);
  await flushMailbox(context);
  assert.deepEqual(
    sends.map((entry) => entry.messageId === held.messageId),
    [false, false, true],
  );
  assert.match(sends[1].text, /Cite every source/);
  assert.notEqual(received(), before);
  const delivered = store.read().messages.find((message) => message.id === held.messageId)!;
  assert.equal(mailboxMessageStatus(delivered), "delivered");
});

test("mail follows the roster member when its Paseo agent is replaced", async (t) => {
  const { send } = setup(t);
  const { sends, failures, context } = fakePaseo();
  await seed([manager, worker]);
  failures.set(worker.paseoAgentId, "Context corrupted");
  const queued = await send(context, "Resume the survey");
  assert.equal(queued.status, "queued");

  await store.commit((state) => [
    {
      op: "put",
      collection: "agents",
      record: {
        ...state.agents.find((agent) => agent.id === worker.id)!,
        paseoAgentId: "replacement-agent",
      },
    },
  ]);
  sends.length = 0;
  await flushMailbox(context);
  assert.deepEqual(
    sends.map((entry) => [entry.agentId, entry.messageId]),
    [["replacement-agent", queued.messageId]],
  );
  const stored = store.read().messages.find((message) => message.id === queued.messageId)!;
  assert.equal(stored.recipientAgentId, worker.id);
  assert.equal(stored.deliveredToPaseoAgentId, "replacement-agent");
});

test("delivery gives up after repeated failures, on retired recipients, and never resends an unknown outcome", async (t) => {
  setup(t);
  const { sends, failures, context } = fakePaseo();
  await seed([manager, worker]);
  const enqueue = (recipientAgentId: string) =>
    enqueueMessage({
      recipientAgentId,
      recipientName: recipientAgentId,
      senderName: "manager",
      taskId: null,
      kind: "team",
      render: (id) => `body ${id}`,
    });

  failures.set(worker.paseoAgentId, "Agent is offline");
  const flaky = await enqueue(worker.id);
  for (let attempt = 0; attempt < MAX_DELIVERY_ATTEMPTS + 2; attempt += 1) {
    await flushMailbox(context);
  }
  const failed = store.read().messages.find((message) => message.id === flaky.id)!;
  assert.equal(mailboxMessageStatus(failed), "failed");
  assert.equal(failed.attempts, MAX_DELIVERY_ATTEMPTS);
  assert.equal(sends.length, MAX_DELIVERY_ATTEMPTS);

  failures.set(worker.paseoAgentId, "agent_request_outcome_unknown");
  const unknown = await enqueue(worker.id);
  await flushMailbox(context);
  await flushMailbox(context);
  const settled = store.read().messages.find((message) => message.id === unknown.id)!;
  assert.equal(mailboxMessageStatus(settled), "delivered");
  assert.match(settled.lastError!, /outcome unknown/);
  assert.equal(sends.filter((entry) => entry.messageId === unknown.id).length, 1);

  await store.commit((state) => [
    {
      op: "put",
      collection: "agents",
      record: { ...state.agents.find((agent) => agent.id === manager.id)!, retired: true },
    },
  ]);
  const orphan = await enqueue(manager.id);
  await flushMailbox(context);
  const dropped = store.read().messages.find((message) => message.id === orphan.id)!;
  assert.equal(mailboxMessageStatus(dropped), "failed");
  assert.match(dropped.lastError!, /no longer an active Swarm agent/);
  assert.equal(sends.filter((entry) => entry.messageId === orphan.id).length, 0);
});

test("settled mail is pruned oldest first while queued mail is kept", async (t) => {
  setup(t);
  await seed([manager, worker]);
  const settled = Array.from({ length: SETTLED_MESSAGE_LIMIT }, (_, index) => ({
    id: `settled-${index}`,
    recipientAgentId: worker.id,
    recipientName: "manager.worker",
    senderName: "manager",
    taskId: null,
    kind: "team" as const,
    prompt: "old",
    createdAt: timestamp,
    attempts: 1,
    lastError: null,
    deliveredAt: timestamp,
    deliveredToPaseoAgentId: worker.paseoAgentId,
    consumedAt: timestamp,
    failedAt: null,
  }));
  const queued = { ...settled[0], id: "still-queued", deliveredAt: null, consumedAt: null };
  await store.commit(() =>
    [queued, ...settled].map((record) => ({ op: "put", collection: "messages", record })),
  );
  await enqueueMessage({
    recipientAgentId: worker.id,
    recipientName: "manager.worker",
    senderName: "manager",
    taskId: null,
    kind: "team",
    render: () => "new",
  });
  // Pruning happens on the next enqueue once the settled count is over the limit.
  await store.commit((state) => [
    {
      op: "put",
      collection: "messages",
      record: { ...state.messages.at(-1)!, deliveredAt: timestamp, consumedAt: timestamp },
    },
  ]);
  await enqueueMessage({
    recipientAgentId: worker.id,
    recipientName: "manager.worker",
    senderName: "manager",
    taskId: null,
    kind: "team",
    render: () => "newest",
  });
  const ids = store.read().messages.map((message) => message.id);
  assert.ok(ids.includes("still-queued"));
  assert.ok(!ids.includes("settled-0"));
  assert.ok(ids.includes("settled-1"));
  assert.equal(ids.length, SETTLED_MESSAGE_LIMIT + 2);
});

test("child turn ends coalesce into one digest per manager wake", async (t) => {
  const { turnStarted, turnEnded } = setup(t);
  const { sends, context } = fakePaseo();
  await seed([manager, worker, reviewer]);

  // An idle manager is woken by the first turn end right away.
  await turnEnded(worker, { kind: "completed" }, context, [
    { type: "assistant_message", text: "Survey done." },
  ]);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].agentId, manager.paseoAgentId);
  assert.match(sends[0].messageId, /^digest-/);
  assert.equal(
    sends[0].text,
    [
      '<paseo-swarm-turn-digest manager="manager" turns="1">',
      '<turn agent="manager.worker" outcome="completed" files="0">',
      "Survey done.",
      "</turn>",
      "</paseo-swarm-turn-digest>",
    ].join("\n"),
  );

  // While that wake runs, further turn ends wait for it to finish.
  await turnStarted(manager, context);
  const report = "x".repeat(2000);
  await turnEnded(reviewer, { kind: "completed" }, context, [
    {
      type: "tool_call",
      callId: "a",
      name: "Edit",
      status: "completed",
      error: null,
      detail: { type: "edit", filePath: "src/a.ts" },
    },
    {
      type: "tool_call",
      callId: "b",
      name: "Write",
      status: "completed",
      error: null,
      detail: { type: "write", filePath: "src/a.ts" },
    },
    {
      type: "tool_call",
      callId: "c",
      name: "Write",
      status: "completed",
      error: null,
      detail: { type: "write", filePath: "src/b.ts" },
    },
    { type: "assistant_message", text: report },
  ]);
  await turnEnded(worker, { kind: "failed", error: { message: 'provider "down"' } }, context);
  assert.equal(sends.length, 1);
  const held = store.read().messages.filter((message) => message.kind === "runtime");
  assert.deepEqual(
    held.map((message) => mailboxMessageStatus(message)),
    ["delivered", "queued", "queued"],
  );

  await turnEnded(manager, { kind: "completed" }, context);
  assert.equal(sends.length, 2);
  const digest = sends[1];
  assert.equal(digest.agentId, manager.paseoAgentId);
  assert.match(digest.text, /^<paseo-swarm-turn-digest manager="manager" turns="2">\n/);
  assert.ok(
    digest.text.includes(
      `<turn agent="manager.reviewer" outcome="completed" files="2" truncated="true" occupant="1">\n${"x".repeat(1500)}\n</turn>`,
    ),
  );
  assert.ok(
    digest.text.includes(
      '<turn agent="manager.worker" outcome="failed" detail="provider &quot;down&quot;" files="0" />',
    ),
  );
  const rows = store.read().messages.filter((message) => message.kind === "runtime");
  assert.deepEqual(
    rows.map((message) => [mailboxMessageStatus(message), message.batchId === digest.messageId]),
    [
      ["consumed", false],
      ["delivered", true],
      ["delivered", true],
    ],
  );
});

test("a message to a busy manager releases its held rows first, in order", async (t) => {
  const { turnStarted, turnEnded, sendTo } = setup(t);
  const { sends, context } = fakePaseo();
  await seed([manager, worker]);
  await turnStarted(manager, context);
  await turnEnded(worker, { kind: "completed" }, context);
  assert.equal(sends.length, 0);

  const message = await sendTo(context, manager, "Human steer");
  assert.equal(message.status, "delivered");
  assert.deepEqual(
    sends.map((entry) => entry.messageId.split("-")[0]),
    ["digest", "message"],
  );
  assert.match(sends[0].text, /<turn agent="manager\.worker" outcome="completed" files="0" \/>/);
});

test("a failed digest is resent with the same rows and id; later rows go in the next digest", async (t) => {
  const { turnStarted, turnEnded } = setup(t);
  const { sends, failures, context } = fakePaseo();
  await seed([manager, worker, reviewer]);
  failures.set(manager.paseoAgentId, "Agent is offline");
  await turnEnded(worker, { kind: "completed" }, context);
  const [first] = sends;
  assert.match(first.text, /turns="1"/);

  await turnStarted(manager, context);
  await turnEnded(reviewer, { kind: "completed" }, context);
  // Each retry resends the formed digest unchanged; the reviewer's row waits behind it.
  assert.ok(sends.length > 1);
  assert.ok(
    sends.every((entry) => entry.messageId === first.messageId && entry.text === first.text),
  );

  failures.delete(manager.paseoAgentId);
  sends.length = 0;
  await turnEnded(manager, { kind: "completed" }, context);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].messageId, first.messageId);
  // That digest woke the manager; the reviewer's row is the next wake.
  await turnEnded(manager, { kind: "completed" }, context);
  assert.equal(sends.length, 2);
  assert.notEqual(sends[1].messageId, first.messageId);
  assert.match(sends[1].text, /turns="1"/);
  assert.match(sends[1].text, /manager\.reviewer/);
});

test("rows held past the limit are steered into a manager whose turn end was never seen", async (t) => {
  const { turnStarted } = setup(t);
  const { sends, context } = fakePaseo();
  await seed([manager, worker]);
  await turnStarted(manager, context);
  const row = await enqueueMessage({
    recipientAgentId: manager.id,
    recipientName: "manager",
    senderName: "manager.worker",
    taskId: null,
    kind: "runtime",
    render: () => '<turn agent="manager.worker" outcome="completed" files="0" />',
  });
  await flushMailbox(context);
  assert.equal(sends.length, 0);

  await store.commit((state) => [
    {
      op: "put",
      collection: "messages",
      record: {
        ...state.messages.find((message) => message.id === row.id)!,
        createdAt: new Date(Date.now() - DIGEST_HOLD_LIMIT_MS - 1000).toISOString(),
      },
    },
  ]);
  await flushMailbox(context);
  assert.equal(sends.length, 1);
  assert.match(sends[0].messageId, /^digest-/);
});

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
import { forgetRunningTurns } from "../server/mailbox";
import { registerOperations } from "../server/operations";
import { store } from "../server/state";
import { forgetWaits } from "../server/waits";
import { seed } from "./fixtures";
import { mailboxMessageStatus, type AgentRecord } from "../shared/models";
import { sendMessageRpc, waitCancelRpc, waitPollRpc, waitStartRpc } from "../shared/swarm";

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

type Poll = ReturnType<typeof waitPollRpc.output.parse>;

function setup(t: { after(fn: () => void): void }) {
  const home = mkdtempSync(join(tmpdir(), "swarm-waits-"));
  const previousHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = home;
  t.after(() => {
    forgetWaits();
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
  forgetWaits();

  const sends: Array<{ agentId: string; text: string }> = [];
  const context = {
    signal: new AbortController().signal,
    paseo: {
      agents: {
        ref(agentId: string) {
          return {
            async send(text: string) {
              sends.push({ agentId, text });
            },
          };
        },
      },
    },
  } as unknown as PluginHookContext & PluginHandlerContext;

  const call = <T>(name: string, input: unknown) =>
    handlers.get(name)!(input as never, context) as Promise<T>;
  const start = async (seats: string[]) =>
    (
      await call<{ waitId: string }>(
        waitStartRpc.name,
        waitStartRpc.input.parse({ paseoAgentId: manager.paseoAgentId, seats }),
      )
    ).waitId;
  const poll = (waitId: string, windowMs = 2000) =>
    call<Poll>(waitPollRpc.name, waitPollRpc.input.parse({ waitId, windowMs }));
  const cancel = (waitId: string, release: string[] = []) =>
    call(waitCancelRpc.name, waitCancelRpc.input.parse({ waitId, release }));
  const sendToManager = (body: string) =>
    call<ReturnType<typeof sendMessageRpc.output.parse>>(
      sendMessageRpc.name,
      sendMessageRpc.input.parse({
        recipientName: "manager",
        senderName: "manager.worker",
        actorName: "manager.worker",
        body,
      }),
    );
  const hookAgent = (agent: AgentRecord) => ({
    id: agent.paseoAgentId,
    workspaceId: "workspace",
    parentAgentId: null,
    provider: "claude",
    cwd: home,
    title: null,
  });
  const turnEnded = (
    agent: AgentRecord,
    outcome: PluginLifecycleEvents["agent.turn_ended"]["outcome"],
    text?: string,
  ) => {
    const timeline = text ? [{ type: "assistant_message" as const, text }] : [];
    return hooks.get("agent.turn_ended")!(
      {
        agent: hookAgent(agent),
        turnId: "turn",
        outcome,
        timeline,
        turnTimeline: timeline,
      } as never,
      context,
    );
  };
  const permission = (agent: AgentRecord) =>
    hooks.get("agent.permission_requested")!(
      {
        agent: hookAgent(agent),
        request: { id: "p", provider: "claude", name: "Bash", kind: "tool", title: "Run npm test" },
      } as never,
      context,
    );
  return { sends, start, poll, cancel, sendToManager, turnEnded, permission };
}

const managerMail = () =>
  store.read().messages.filter((message) => message.recipientAgentId === manager.id);

test("mail to a waiting agent is returned by the wait instead of steered, and consumed at its turn end", async (t) => {
  const { sends, start, poll, sendToManager, turnEnded } = setup(t);
  await seed({ agents: [manager, worker] });
  const waitId = await start([]);

  const pending = poll(waitId);
  const receipt = await sendToManager("Survey done: three options.");
  // The wait claimed it before the send returned, so the sender's receipt says delivered.
  assert.equal(receipt.status, "delivered");
  const result = await pending;
  assert.equal(result.expired, false);
  assert.equal(sends.filter((send) => send.agentId === manager.paseoAgentId).length, 0);
  assert.equal(result.mail.length, 1);
  assert.match(result.mail[0], /<paseo-swarm-team-message[^>]*from="manager\.worker"/);
  assert.match(result.mail[0], /Survey done: three options\./);
  assert.deepEqual(result.messageIds, [receipt.messageId]);
  const [row] = managerMail();
  assert.equal(mailboxMessageStatus(row), "delivered");
  assert.equal(row.deliveredToPaseoAgentId, manager.paseoAgentId);

  await turnEnded(manager, { kind: "completed" });
  assert.equal(mailboxMessageStatus(managerMail()[0]), "consumed");
});

test("mail queued before the wait started is its first answer", async (t) => {
  const { start, poll, cancel, sendToManager } = setup(t);
  await seed({ agents: [manager, worker] });
  const firstWait = await start([]);
  await sendToManager("Early report");
  // A newer wait replaces the older one, and the mail was never claimed.
  const waitId = await start([]);
  assert.equal((await poll(firstWait)).expired, true);
  const result = await poll(waitId);
  assert.match(result.mail.join("\n"), /Early report/);
  await cancel(waitId);
});

test("a waited seat's turn end and permission prompt end the wait; unwaited seats do not", async (t) => {
  const { sends, start, poll, cancel, turnEnded, permission } = setup(t);
  await seed({ agents: [manager, worker, reviewer] });
  const waitId = await start(["manager.worker"]);

  await turnEnded(reviewer, { kind: "completed" }, "Not waited on");
  const quiet = await poll(waitId, 50);
  assert.deepEqual(quiet, { expired: false, mail: [], messageIds: [], events: [] });

  await turnEnded(worker, { kind: "completed" }, "Finished without a report");
  const ended = await poll(waitId);
  assert.deepEqual(ended.events, [
    {
      seat: "manager.worker",
      kind: "turn-ended",
      outcome: "completed",
      detail: null,
      files: 0,
      report: "Finished without a report",
      truncated: false,
      occupant: 1,
    },
  ]);

  await permission(worker);
  const asked = await poll(waitId);
  assert.deepEqual(asked.events, [
    { seat: "manager.worker", kind: "permission", request: "Run npm test" },
  ]);
  await cancel(waitId);
  // Completed turns write nothing to the manager.
  assert.equal(managerMail().length, 0);
  assert.equal(sends.length, 0);
});

test("a waited report's failure reaches its manager once, as mail", async (t) => {
  const { start, poll, cancel, turnEnded } = setup(t);
  await seed({ agents: [manager, worker] });
  const waitId = await start(["manager.worker"]);
  await turnEnded(worker, { kind: "failed", error: { message: "provider down" } });
  const result = await poll(waitId);
  assert.deepEqual(result.events, []);
  assert.equal(result.mail.length, 1);
  assert.match(
    result.mail[0],
    /<turn agent="manager\.worker" outcome="failed" detail="provider down" files="0" \/>/,
  );
  await cancel(waitId);
});

test("an idle manager still gets a report's failure pushed", async (t) => {
  const { sends, turnEnded } = setup(t);
  await seed({ agents: [manager, worker] });
  await turnEnded(worker, { kind: "failed", error: { message: "provider down" } });
  assert.equal(sends.length, 1);
  assert.equal(sends[0].agentId, manager.paseoAgentId);
  assert.match(sends[0].text, /outcome="failed"/);
});

test("ending a wait sends held mail the ordinary way, and released mail goes out again", async (t) => {
  const { sends, start, poll, cancel, sendToManager } = setup(t);
  await seed({ agents: [manager, worker] });
  let waitId = await start([]);
  await sendToManager("Held while waiting");
  assert.equal(sends.length, 0);
  await cancel(waitId);
  assert.equal(sends.length, 1);
  assert.match(sends[0].text, /Held while waiting/);

  // A claim whose answer never reached the agent is released and steered.
  waitId = await start([]);
  await sendToManager("Claimed, then lost");
  const claimed = await poll(waitId);
  assert.equal(claimed.messageIds.length, 1);
  await cancel(waitId, claimed.messageIds);
  assert.equal(sends.length, 2);
  assert.match(sends[1].text, /Claimed, then lost/);
});

test("a waited seat that is retired ends the wait", async (t) => {
  const { start, poll, cancel } = setup(t);
  await seed({ agents: [manager, worker] });
  const waitId = await start(["manager.worker"]);
  const pending = poll(waitId);
  await store.commit((state) => [
    {
      op: "put",
      collection: "agents",
      record: { ...state.agents.find((agent) => agent.id === worker.id)!, retired: true },
    },
  ]);
  assert.deepEqual((await pending).events, [{ seat: "manager.worker", kind: "retired" }]);
  await cancel(waitId);
});

test("a waiting agent whose turn ends gets its held mail by the ordinary path", async (t) => {
  const { sends, start, poll, sendToManager, turnEnded } = setup(t);
  await seed({ agents: [manager, worker] });
  const waitId = await start([]);
  await sendToManager("Arrived as the turn was interrupted");
  assert.equal(sends.length, 0);
  await turnEnded(manager, { kind: "canceled", reason: "interrupted" });
  assert.equal(sends.length, 1);
  assert.match(sends[0].text, /Arrived as the turn was interrupted/);
  assert.equal((await poll(waitId)).expired, true);
});

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { registerOperations } from "../server/operations";
import { store } from "../server/state";
import type { Activity, AgentRecord, MailboxMessage, Task } from "../shared/models";
import { rosterReadRpc, seatReadRpc, taskReadRpc, tasksReadRpc } from "../shared/swarm";
import { seed } from "./fixtures";

const timestamp = "2026-11-02T00:00:00Z";

function seat(name: string, overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: `${name}-record`,
    swarmId: undefined as unknown as string,
    paseoAgentId: `${name}-agent`,
    name,
    qualifiedName: name,
    aliases: [],
    roleClass: "supervisor",
    role: "supervisor",
    reportsTo: null,
    workspaceId: `${name}-workspace`,
    projectId: "project",
    retired: false,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

function task(id: string): Task {
  return {
    id,
    swarmId: undefined as unknown as string,
    title: `Task ${id}`,
    brief: "A long brief ".repeat(200),
    status: "doing",
    managerName: "manager",
    workerNames: [],
    createdBy: "manager",
    data: { large: "x".repeat(1000) },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function activity(id: string, taskId: string, overrides: Partial<Activity> = {}): Activity {
  return {
    id,
    swarmId: undefined as unknown as string,
    taskId,
    actorName: "manager",
    actorKind: "agent",
    replyTo: null,
    responseProfile: null,
    kind: "note",
    body: `Activity ${id}`,
    data: {},
    refs: [],
    createdAt: timestamp,
    ...overrides,
  };
}

const choice = {
  action: { type: "choice", prompt: "Ship it?", options: [{ id: "yes", label: "Yes" }] },
};

async function withHandlers(
  run: (invoke: (name: string, input: unknown) => Promise<unknown>) => Promise<void>,
) {
  const home = mkdtempSync(join(tmpdir(), "swarm-views-"));
  const previousHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = home;
  const handlers = new Map<string, (input: never, context: PluginHandlerContext) => unknown>();
  const contracts = new Map<string, { input: { parse(input: unknown): unknown } }>();
  registerOperations({
    handle(contract, handler) {
      handlers.set(contract.name, handler);
      contracts.set(contract.name, contract);
    },
  });
  const context = {
    paseo: {
      projects: {
        async list() {
          return { projects: [{ projectId: "project", projectRootPath: home }] };
        },
      },
    },
  } as unknown as PluginHandlerContext;
  try {
    await run(async (name, input) =>
      handlers.get(name)!(contracts.get(name)!.input.parse(input) as never, context),
    );
  } finally {
    if (previousHome === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
}

test("the seat read carries one seat's occupants, retired seats included", async () => {
  await withHandlers(async (invoke) => {
    await seed({
      agents: [
        seat("manager"),
        seat("gone", {
          retired: true,
          occupant: { number: 2, generation: 1, config: {}, boundAt: timestamp },
        }),
      ],
    });
    const read = async (seatId: string, etag?: string) =>
      seatReadRpc.output.parse(
        await invoke(seatReadRpc.name, etag ? { seatId, etag } : { seatId }),
      );
    const first = await read("gone-record");
    assert.equal(first.data?.seat?.name, "gone");
    assert.equal(first.data?.seat?.occupant?.number, 2);
    assert.deepEqual(await read("gone-record", first.etag), { etag: first.etag, data: null });
    assert.deepEqual((await read("missing")).data, { seat: null });
  });
});

test("the roster read is lean, leaves out retired seats, and answers a held etag with no data", async () => {
  await withHandlers(async (invoke) => {
    await seed({
      agents: [
        seat("manager"),
        seat("gone", { retired: true }),
        seat("reserved", { paseoAgentId: null }),
      ],
    });
    const read = async (etag?: string) =>
      rosterReadRpc.output.parse(await invoke(rosterReadRpc.name, etag ? { etag } : {}));
    const first = await read();
    assert.ok(first.data);
    assert.deepEqual(
      first.data.agents.map((agent) => agent.name),
      ["manager", "reserved"],
    );
    for (const agent of first.data.agents) {
      assert.equal("pastOccupants" in agent, false);
      assert.equal("prompt" in agent, false);
    }
    assert.deepEqual(await read(first.etag), { etag: first.etag, data: null });

    // A commit the roster does not show keeps its etag.
    const message: MailboxMessage = {
      id: "message",
      recipientAgentId: "manager-record",
      recipientName: "manager",
      senderName: "human",
      taskId: null,
      kind: "team",
      prompt: "hello",
      createdAt: timestamp,
      attempts: 0,
      lastError: null,
      deliveredAt: null,
      deliveredToPaseoAgentId: null,
      consumedAt: null,
      failedAt: null,
    };
    await store.commit(() => [{ op: "put", collection: "messages", record: message }]);
    assert.deepEqual(await read(first.etag), { etag: first.etag, data: null });

    const manager = store.read().agents.find((agent) => agent.name === "manager")!;
    await store.commit(() => [
      { op: "put", collection: "agents", record: { ...manager, retired: true } },
    ]);
    const changed = await read(first.etag);
    assert.notEqual(changed.etag, first.etag);
    assert.deepEqual(
      changed.data?.agents.map((agent) => agent.name),
      ["reserved"],
    );

    // A reload mints a new revision, and the content still decides the etag.
    store.forget();
    assert.deepEqual(await read(changed.etag), { etag: changed.etag, data: null });
  });
});

test("the Task list carries attention counts, not Activities or briefs", async () => {
  await withHandlers(async (invoke) => {
    await seed({
      agents: [seat("manager")],
      tasks: [task("first"), task("second")],
      activities: [
        activity("asked", "first", { data: choice }),
        activity("answered", "first", { data: choice }),
        activity("reply", "first", { actorKind: "human", actorName: "human", replyTo: "answered" }),
        activity("note", "second"),
      ],
    });
    const read = async (input: unknown) =>
      tasksReadRpc.output.parse(await invoke(tasksReadRpc.name, input));
    const list = await read({ projectId: "project" });
    assert.ok(list.data);
    assert.deepEqual(
      list.data.tasks.map(({ id, attention }) => ({ id, attention })),
      [
        { id: "first", attention: 1 },
        { id: "second", attention: 0 },
      ],
    );
    assert.equal(JSON.stringify(list.data).includes("A long brief"), false);
    assert.equal(JSON.stringify(list.data).includes("Activity"), false);
    assert.deepEqual(await read({ projectId: "project", etag: list.etag }), {
      etag: list.etag,
      data: null,
    });

    // Answering the choice changes the list.
    const reply = store.read().activities.find((candidate) => candidate.id === "reply")!;
    await store.commit(() => [
      {
        op: "put",
        collection: "activities",
        record: { ...reply, id: "reply-2", replyTo: "asked" },
      },
    ]);
    const answered = await read({ projectId: "project", etag: list.etag });
    assert.equal(answered.data?.tasks.find((candidate) => candidate.id === "first")?.attention, 0);
  });
});

test("a Task read returns its latest Activities and every unanswered choice and its result before them", async () => {
  await withHandlers(async (invoke) => {
    const notes = Array.from({ length: 6 }, (_, index) => activity(`note-${index}`, "first"));
    await seed({
      agents: [seat("manager")],
      tasks: [task("first"), task("other")],
      activities: [
        activity("old-choice", "first", { data: choice }),
        activity("old-answered", "first", { data: choice }),
        activity("first-result", "first", { kind: "delivery" }),
        activity("result", "first", { kind: "delivery" }),
        ...notes,
        activity("elsewhere", "other"),
        activity("late-reply", "first", {
          actorKind: "human",
          actorName: "human",
          replyTo: "old-answered",
        }),
      ],
    });
    const swarmId = store.read().swarms[0].id;
    const read = async (input: Record<string, unknown>) =>
      taskReadRpc.output.parse(
        await invoke(taskReadRpc.name, { swarmId, taskId: "first", ...input }),
      );

    const page = await read({ limit: 3 });
    assert.ok(page.data);
    assert.equal(page.data.task.brief.startsWith("A long brief"), true);
    assert.deepEqual(
      page.data.activities.map((entry) => entry.id),
      ["old-choice", "result", "note-4", "note-5", "late-reply"],
    );
    assert.equal(page.data.olderCount, 6);

    const all = await read({});
    assert.equal(all.data?.activities.length, 11);
    assert.equal(all.data?.olderCount, 0);
    assert.deepEqual(await read({ etag: all.etag }), { etag: all.etag, data: null });
    await assert.rejects(async () => read({ taskId: "missing" }), /Unknown Task/);
  });
});

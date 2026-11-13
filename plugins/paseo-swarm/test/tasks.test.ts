import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { forgetRunningTurns } from "../server/mailbox";
import { registerOperations } from "../server/operations";
import { store } from "../server/state";
import { handOverTasks } from "../server/tasks";
import { seatReadView } from "../server/views";
import { seed } from "./fixtures";
import type { Activity, AgentRecord, AudienceEntry, Task } from "../shared/models";
import {
  appendActivityRpc,
  appendHumanActivityRpc,
  closeTasksRpc,
  createTaskRpc,
  deliverTaskRpc,
  sendMessageRpc,
  updateTaskRpc,
} from "../shared/swarm";

const timestamp = "2026-11-01T00:00:00Z";
const seat = (
  name: string,
  roleClass: AgentRecord["roleClass"],
  reportsTo: string | null,
): AgentRecord => {
  const qualifiedName = reportsTo ? `${reportsTo}.${name}` : name;
  return {
    id: `${qualifiedName}-record`,
    paseoAgentId: `${qualifiedName}-agent`,
    name,
    qualifiedName,
    aliases: [],
    roleClass,
    role: roleClass === "worker" ? "developer" : roleClass,
    reportsTo,
    workspaceId: "workspace",
    retired: false,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
};
const planner = seat("planner", "planner", null);
const lead = seat("lead", "supervisor", "planner");
const ops = seat("ops", "supervisor", "planner");
const dev = seat("dev", "worker", "planner.lead");

function setup(t: { after(fn: () => void): void }) {
  const home = mkdtempSync(join(tmpdir(), "swarm-tasks-"));
  const previousHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });
  forgetRunningTurns();
  const handlers = new Map<string, (input: never, context: PluginHandlerContext) => unknown>();
  const server: Pick<PluginServerContext, "handle"> = {
    handle(contract, handler) {
      handlers.set(contract.name, handler);
    },
  };
  registerOperations(server);
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
  } as unknown as PluginHandlerContext;
  const call = async <Output>(
    contract: { name: string; input: { parse(value: unknown): unknown } },
    input: Record<string, unknown>,
  ) =>
    (await handlers.get(contract.name)!(contract.input.parse(input) as never, context)) as Output;
  const mailTo = (agent: AgentRecord) =>
    sends.filter((send) => send.agentId === agent.paseoAgentId).map((send) => send.text);
  return { call, sends, mailTo };
}

const create = (input: Record<string, unknown>) => ({
  id: "fix-login",
  title: "Fix login",
  brief: "Make login work again.",
  status: "development",
  managerName: "lead",
  createdBy: "planner",
  ...input,
});
const activitiesOf = (taskId: string) =>
  store.read().activities.filter((activity) => activity.taskId === taskId);
const taskOf = (taskId: string) => store.read().tasks.find((task) => task.id === taskId)!;

test("a Task created for another seat is its assignment, and only the line above may create it", async (t) => {
  const { call, mailTo } = setup(t);
  await seed({ agents: [planner, lead, ops, dev] });

  const task = await call<Task>(createTaskRpc, create({}));
  assert.equal(task.managerName, "planner.lead");
  assert.equal(task.createdBy, "planner");
  assert.ok(task.briefUpdatedAt);
  const [assigned] = mailTo(lead);
  assert.match(assigned, /kind="task-assigned"/);
  assert.match(assigned, /task="fix-login"/);
  assert.match(assigned, /Make login work again\./);

  await assert.rejects(
    call(createTaskRpc, create({ id: "sibling", managerName: "ops", createdBy: "planner.lead" })),
    /planner\.lead cannot make planner\.ops the owner of sibling: a Task can be given only to yourself or a seat below you/,
  );
  await assert.rejects(
    call(createTaskRpc, create({ id: "for-worker", managerName: "planner.lead.dev" })),
    /workers don't own Tasks/,
  );
  await assert.rejects(
    call(
      createTaskRpc,
      create({ id: "by-worker", managerName: "planner.lead", createdBy: "planner.lead.dev" }),
    ),
    /planner\.lead\.dev cannot create Task by-worker: workers don't create or own Tasks/,
  );
});

test("the owner's line changes a Task and the owner hears of it; anyone else is told who can", async (t) => {
  const { call, mailTo } = setup(t);
  await seed({ agents: [planner, lead, ops, dev] });
  await call(createTaskRpc, create({}));
  const before = mailTo(lead).length;

  await call(updateTaskRpc, {
    taskId: "fix-login",
    actorName: "planner",
    brief: "Make login work again, without a schema change.",
    briefBasedOn: taskOf("fix-login").briefUpdatedAt,
    status: "review",
    reason: "The human ruled out migrations",
  });
  const change = activitiesOf("fix-login").at(-1)!;
  assert.equal(change.kind, "change");
  assert.equal(change.actorName, "planner");
  assert.equal(
    change.body,
    "Status: development → review\nBrief revised\nReason: The human ruled out migrations",
  );
  assert.equal(change.data.previousBrief, "Make login work again.");
  const [notice] = mailTo(lead).slice(before);
  assert.match(notice, /kind="task-change"/);
  assert.match(notice, /Brief revised/);

  await assert.rejects(
    call(updateTaskRpc, { taskId: "fix-login", actorName: "ops", status: "survey" }),
    /planner\.ops cannot update Task fix-login: only its owner and the seats above it can, and that line is planner\.lead < planner\. Message planner\.lead/,
  );
  await assert.rejects(
    call(updateTaskRpc, { taskId: "fix-login", actorName: "planner.lead.dev", status: "survey" }),
    /workers don't change Tasks.*Send your result or question to planner\.lead/,
  );

  // Reassignment hands the Task over as an assignment; the old owner is told.
  await call(updateTaskRpc, {
    taskId: "fix-login",
    actorName: "planner",
    managerName: "ops",
    reason: "lead is on the release",
  });
  assert.equal(taskOf("fix-login").managerName, "planner.ops");
  const assigned = mailTo(ops).at(-1)!;
  assert.match(assigned, /from="planner"/);
  assert.match(assigned, /kind="task-assigned"/);
  assert.match(assigned, /previous-owner="planner\.lead"/);
  assert.match(mailTo(lead).at(-1)!, /Owner: planner\.lead → planner\.ops/);
});

test("deliver records the result and closes the Task in one call; a retry changes nothing", async (t) => {
  const { call, sends, mailTo } = setup(t);
  await seed({ agents: [planner, lead, ops, dev] });
  await call(createTaskRpc, create({}));
  const fixed = {
    taskId: "fix-login",
    actorName: "planner.lead",
    result: "Login works again. The session cookie lost its domain in #42.",
    taskState: "done",
    status: "completed",
  };

  const first = await call<{
    task: Task;
    activity: { id: string; kind: string };
    duplicate: boolean;
  }>(deliverTaskRpc, fixed);
  assert.equal(first.duplicate, false);
  assert.equal(first.task.resolution, "done");
  assert.equal(first.task.status, "completed");
  assert.equal(first.activity.kind, "delivery");
  assert.equal(activitiesOf("fix-login").length, 1);
  const delivered = mailTo(planner).at(-1)!;
  assert.match(delivered, /kind="delivery"/);
  assert.match(delivered, /task-state="done"/);

  const mailCount = sends.length;
  const retry = await call<{ activity: { id: string }; duplicate: boolean }>(deliverTaskRpc, fixed);
  assert.equal(retry.duplicate, true);
  assert.equal(retry.activity.id, first.activity.id);
  assert.equal(activitiesOf("fix-login").length, 1);
  assert.equal(sends.length, mailCount);

  await assert.rejects(
    call(deliverTaskRpc, {
      taskId: "fix-login",
      actorName: "planner.lead",
      result: "Again",
      taskState: "open",
      revises: "activity-missing",
    }),
    /cannot revise activity-missing: it is not a delivery on Task fix-login/,
  );
  await assert.rejects(
    call(deliverTaskRpc, {
      taskId: "fix-login",
      actorName: "planner.lead.dev",
      result: "Done",
      taskState: "done",
    }),
    /workers don't change Tasks/,
  );
});

test("a revision that invalidates a done result reopens the Task in the same call", async (t) => {
  const { call, mailTo } = setup(t);
  await seed({ agents: [planner, lead, ops, dev] });
  await call(createTaskRpc, create({}));
  const first = await call<{ activity: { id: string } }>(deliverTaskRpc, {
    taskId: "fix-login",
    actorName: "planner.lead",
    result: "Login works again.",
    taskState: "done",
  });

  // A correction that keeps the Task done.
  const typoFree = await call<{ task: Task; activity: { data: Record<string, unknown> } }>(
    deliverTaskRpc,
    {
      taskId: "fix-login",
      actorName: "planner.lead",
      result: "Correction: the cause was the proxy, not #42. Login still works.",
      taskState: "done",
      revises: first.activity.id,
    },
  );
  assert.equal(typoFree.activity.data.revises, first.activity.id);
  assert.equal(typoFree.task.resolution, "done");

  // A correction that means more work: one call records it and reopens the Task.
  const reopened = await call<{ task: Task; activity: { data: Record<string, unknown> } }>(
    deliverTaskRpc,
    {
      taskId: "fix-login",
      actorName: "planner.lead",
      result: "Login fails again on Safari; the fix is incomplete.",
      taskState: "open",
      revises: first.activity.id,
    },
  );
  assert.equal(reopened.task.resolution, undefined);
  assert.equal(reopened.task.resolvedAt, undefined);
  assert.equal(reopened.activity.data.taskState, "open");
  assert.equal(reopened.activity.data.reopened, "done");
  const mail = mailTo(planner).at(-1)!;
  assert.match(mail, /task-state="open"/);
  assert.match(mail, /reopened="done"/);
});

test("the same text delivered after the Task changed is a new delivery, not a retry", async (t) => {
  const { call } = setup(t);
  await seed({ agents: [planner, lead, ops, dev] });
  await call(createTaskRpc, create({}));
  const done = {
    taskId: "fix-login",
    actorName: "planner.lead",
    result: "Login works again.",
    taskState: "done",
  };
  const first = await call<{ activity: { id: string } }>(deliverTaskRpc, done);

  await call(updateTaskRpc, {
    taskId: "fix-login",
    actorName: "planner.lead",
    resolution: null,
    reason: "QA found a regression",
  });
  const again = await call<{ activity: { id: string }; duplicate: boolean; task: Task }>(
    deliverTaskRpc,
    done,
  );
  assert.equal(again.duplicate, false);
  assert.notEqual(again.activity.id, first.activity.id);
  assert.equal(again.task.resolution, "done");

  // The same text with a different Task state is a new submission too.
  const open = await call<{ duplicate: boolean }>(deliverTaskRpc, { ...done, taskState: "open" });
  assert.equal(open.duplicate, false);
  assert.equal(
    activitiesOf("fix-login").filter((activity) => activity.kind === "delivery").length,
    3,
  );
});

test("closing without a result needs a reason, and results go through deliver only", async (t) => {
  const { call } = setup(t);
  await seed({ agents: [planner, lead, ops, dev] });
  await call(createTaskRpc, create({}));
  await call(createTaskRpc, create({ id: "login-again", title: "Login again" }));

  await assert.rejects(
    call(updateTaskRpc, { taskId: "fix-login", actorName: "planner.lead", resolution: "done" }),
    /completed by the delivery that carries its result. Call swarm_task_deliver/,
  );
  await assert.rejects(
    call(updateTaskRpc, {
      taskId: "login-again",
      actorName: "planner.lead",
      resolution: "wont-do",
    }),
    /needs a reason/,
  );
  await assert.rejects(
    call(updateTaskRpc, {
      taskId: "login-again",
      actorName: "planner.lead",
      resolution: "duplicate",
      reason: "Same work",
    }),
    /Pass duplicateOf/,
  );
  await call(updateTaskRpc, {
    taskId: "login-again",
    actorName: "planner.lead",
    resolution: "duplicate",
    duplicateOf: "fix-login",
    reason: "Same work",
  });
  assert.equal(taskOf("login-again").resolution, "duplicate");
  assert.equal(
    activitiesOf("login-again").at(-1)!.body,
    "Closed as a duplicate of fix-login\nReason: Same work",
  );
  await call(updateTaskRpc, {
    taskId: "login-again",
    actorName: "planner",
    resolution: null,
    reason: "Different login path",
  });
  const reopened = taskOf("login-again");
  assert.equal(reopened.resolution, undefined);
  assert.equal(reopened.duplicateOf, undefined);

  await assert.rejects(
    call(appendActivityRpc, {
      taskId: "fix-login",
      actorName: "planner.lead",
      kind: "delivery",
      body: "Done",
    }),
    /results are recorded by swarm_task_deliver/,
  );
});

test("a human note goes to the owner with copies to the seats it names", async (t) => {
  const { call, mailTo } = setup(t);
  await seed({ agents: [planner, lead, ops, dev] });
  await call(createTaskRpc, create({}));
  const leadBefore = mailTo(lead).length;

  await call(appendHumanActivityRpc, {
    taskId: "fix-login",
    kind: "human-note",
    body: "Keep the old cookie name.",
    cc: ["planner"],
  });
  const [toOwner] = mailTo(lead).slice(leadBefore);
  const [copy] = mailTo(planner);
  for (const envelope of [toOwner, copy]) {
    assert.match(envelope, /to="planner\.lead"/);
    assert.match(envelope, /cc="planner"/);
    assert.match(envelope, /Keep the old cookie name\./);
  }

  // A seat message names its Task as context, whoever sends it.
  const receipt = await call<{ cc: Array<{ recipient: string }> }>(sendMessageRpc, {
    senderName: "human",
    recipientName: "planner.lead",
    taskId: "fix-login",
    cc: ["planner"],
    body: "Ship it today.",
  });
  assert.deepEqual(
    receipt.cc.map((entry) => entry.recipient),
    ["planner"],
  );
});

test("a human reply to a choice names the question and the option it picked", async (t) => {
  const { call, mailTo } = setup(t);
  await seed({ agents: [planner, lead, ops, dev] });
  await call(createTaskRpc, create({}));
  const choice = await call<{ id: string }>(appendActivityRpc, {
    taskId: "fix-login",
    actorName: "planner.lead",
    kind: "question",
    body: "Beta has the fix; stable ships Monday.",
    data: {
      action: {
        type: "choice",
        prompt: "Which release\nchannel?",
        options: [
          { id: "beta", label: "Beta" },
          { id: "stable", label: "Stable" },
        ],
      },
    },
  });
  const before = mailTo(lead).length;
  await call(appendHumanActivityRpc, {
    taskId: "fix-login",
    kind: "human-response",
    body: "Selected: Beta",
    replyTo: choice.id,
    responseProfile: "decision",
    data: { selectedOption: "beta" },
  });
  const [reply] = mailTo(lead).slice(before);
  assert.match(reply, new RegExp(`reply-to="${choice.id}"`));
  assert.match(reply, /question="Which release channel\?"/);
  assert.match(reply, /selected-option="beta"/);

  // A note that answers no choice carries neither.
  await call(appendHumanActivityRpc, {
    taskId: "fix-login",
    kind: "human-note",
    body: "Thanks.",
  });
  const note = mailTo(lead).at(-1)!;
  assert.doesNotMatch(note, /question=|selected-option=/);
});

test("a retiring owner's open Tasks move to the nearest seat above it that stays", async (t) => {
  setup(t);
  await seed({ agents: [planner, lead, ops, dev] });
  const base = {
    swarmId: store.read().swarms[0].id,
    brief: "Brief",
    status: "development",
    createdBy: "planner",
    data: {},
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const state = {
    ...store.read(),
    tasks: [
      {
        ...base,
        id: "open",
        title: "Open",
        managerName: "planner.lead",
        workerNames: ["planner.lead.dev"],
      },
      {
        ...base,
        id: "closed",
        title: "Closed",
        managerName: "planner.lead",
        workerNames: [],
        resolution: "done" as const,
      },
      { ...base, id: "other", title: "Other", managerName: "planner.ops", workerNames: [] },
    ],
  };
  const retiring = state.agents.filter((agent) => agent.qualifiedName?.startsWith("planner.lead"));
  const changes = handOverTasks(state, retiring, "swarm");
  const tasks = changes.flatMap((change) =>
    change.op === "put" && change.collection === "tasks" ? [change.record] : [],
  );
  assert.deepEqual(
    tasks.map((task) => [task.id, task.managerName, task.workerNames]),
    // The closed Task keeps its owner: it carries no commitment to hand over.
    [["open", "planner", []]],
  );
  const mail = changes.flatMap((change) =>
    change.op === "put" && change.collection === "messages" ? [change.record] : [],
  );
  assert.equal(mail.length, 1);
  assert.equal(mail[0].recipientName, "planner");
  assert.match(mail[0].prompt, /planner\.lead retired\. You now own its open Task:\n- open: Open/);
  const activities = changes.flatMap((change) =>
    change.op === "put" && change.collection === "activities" ? [change.record] : [],
  );
  assert.deepEqual(
    activities.map((activity) => [activity.taskId, activity.body]),
    [["open", "Owner: planner.lead → planner\nReason: planner.lead retired"]],
  );
});

test("recording work underway notifies its owner without assigning it, and its delivery goes to the requester", async (t) => {
  const { call, mailTo } = setup(t);
  await seed({ agents: [planner, lead, ops, dev] });

  const recorded = await call<Task & { audience: AudienceEntry[] }>(
    createTaskRpc,
    create({ requester: "human", assign: false }),
  );
  assert.equal(recorded.requester, "human");
  assert.equal(recorded.briefUnconfirmedBy, "planner");
  assert.deepEqual(recorded.audience, [{ name: "planner.lead", as: "to", why: "owner" }]);
  const [notice] = mailTo(lead);
  assert.match(notice, /kind="task-recorded"/);
  assert.match(notice, /requester="human"/);
  assert.doesNotMatch(notice, /task-assigned/);

  // Defaults: To whoever asked, Cc the owner's manager. The owner's delivery confirms the brief.
  const first = await call<{ activity: Activity; task: Task }>(deliverTaskRpc, {
    taskId: "fix-login",
    actorName: "planner.lead",
    result: "Login works again.",
    taskState: "done",
  });
  assert.deepEqual(first.activity.audience, [
    { name: "human", as: "to", why: "requester" },
    { name: "planner", as: "cc", why: "manager" },
  ]);
  assert.equal(first.task.briefUnconfirmedBy, undefined);
  const copy = mailTo(planner).at(-1)!;
  assert.match(copy, /to="human" cc="planner" addressed="cc"/);
  assert.match(copy, /kind="delivery"/);

  // Either list replaces both defaults, so to: [] records without telling anyone.
  const before = mailTo(planner).length;
  const quiet = await call<{ activity: Activity }>(deliverTaskRpc, {
    taskId: "fix-login",
    actorName: "planner.lead",
    result: "Also checked the mobile login.",
    taskState: "done",
    to: [],
  });
  assert.equal(quiet.activity.audience, undefined);
  assert.equal(mailTo(planner).length, before);

  // The seat's conversation lists the deliveries it addressed to the human.
  const { deliveries } = seatReadView(store.read(), lead.id);
  assert.deepEqual(
    deliveries.map((delivery) => [delivery.taskTitle, delivery.as, delivery.body]),
    [["Fix login", "to", "Login works again."]],
  );

  // A seat above the owner that delivers still tells the owner, whatever its lists say.
  await call(deliverTaskRpc, {
    taskId: "fix-login",
    actorName: "planner",
    result: "Reopened: the fix broke SSO.",
    taskState: "open",
    to: [],
  });
  assert.match(mailTo(lead).at(-1)!, /Reopened: the fix broke SSO\./);

  await assert.rejects(
    call(deliverTaskRpc, {
      taskId: "fix-login",
      actorName: "planner.lead",
      result: "Fixed SSO.",
      taskState: "done",
      cc: ["nobody"],
    }),
    /Unknown active agent: nobody/,
  );
});

test("a brief rewrite from an older read is refused, and the owner confirms a brief by writing it", async (t) => {
  const { call, mailTo } = setup(t);
  await seed({ agents: [planner, lead, ops, dev] });
  await call(createTaskRpc, create({ assign: false, requester: "human" }));
  const stale = taskOf("fix-login").briefUpdatedAt!;

  await new Promise((resolve) => setTimeout(resolve, 5));
  await call(updateTaskRpc, {
    taskId: "fix-login",
    actorName: "planner.lead",
    brief: "Make login work again; keep the old session cookies valid.",
  });
  assert.equal(taskOf("fix-login").briefUnconfirmedBy, undefined);

  await assert.rejects(
    call(updateTaskRpc, {
      taskId: "fix-login",
      actorName: "planner",
      brief: "Make login work again.",
      briefBasedOn: stale,
    }),
    /planner cannot rewrite the brief of Task fix-login: the brief was rewritten at .*retry once/,
  );
  await assert.rejects(
    call(updateTaskRpc, { taskId: "fix-login", actorName: "planner", brief: "Something else." }),
    /pass its briefUpdatedAt as briefBasedOn/,
  );
  assert.equal(
    taskOf("fix-login").brief,
    "Make login work again; keep the old session cookies valid.",
  );

  await call(updateTaskRpc, {
    taskId: "fix-login",
    actorName: "planner",
    brief: "Make login work again; old cookies may expire.",
    briefBasedOn: taskOf("fix-login").briefUpdatedAt,
    reason: "The human accepted expiring sessions",
  });
  assert.equal(taskOf("fix-login").briefUnconfirmedBy, "planner");
  assert.match(mailTo(lead).at(-1)!, /kind="task-change"/);

  // Writing the brief unchanged confirms it.
  await call(updateTaskRpc, {
    taskId: "fix-login",
    actorName: "planner.lead",
    brief: taskOf("fix-login").brief,
  });
  assert.equal(taskOf("fix-login").briefUnconfirmedBy, undefined);
});

test("an Activity reaches only whom it addresses, its asker and its owner; closing without a result copies the requester", async (t) => {
  const { call, mailTo } = setup(t);
  await seed({ agents: [planner, lead, ops, dev] });
  await call(createTaskRpc, create({ requester: "ops" }));
  const opsBefore = mailTo(ops).length;
  const plannerBefore = mailTo(planner).length;

  const note = await call<Activity>(appendActivityRpc, {
    taskId: "fix-login",
    actorName: "planner.lead",
    kind: "decision",
    body: "Keep the cookie domain.",
  });
  assert.equal(note.audience, undefined);
  assert.equal(mailTo(planner).length, plannerBefore);

  const addressed = await call<Activity>(appendActivityRpc, {
    taskId: "fix-login",
    actorName: "planner.lead",
    kind: "blocker",
    body: "Staging is down.",
    to: ["dev"],
    cc: ["planner"],
  });
  assert.deepEqual(addressed.audience, [
    { name: "planner.lead.dev", as: "to", why: "named" },
    { name: "planner", as: "cc", why: "named" },
  ]);
  assert.match(mailTo(dev).at(-1)!, /addressed="to"/);
  assert.match(mailTo(planner).at(-1)!, /addressed="cc"/);

  // A seat above the owner reaches the owner; a reply reaches its asker.
  const question = await call<Activity>(appendActivityRpc, {
    taskId: "fix-login",
    actorName: "planner",
    kind: "question",
    body: "Does this touch SSO?",
  });
  assert.deepEqual(question.audience, [{ name: "planner.lead", as: "to", why: "owner" }]);
  const answer = await call<Activity>(appendActivityRpc, {
    taskId: "fix-login",
    actorName: "planner.lead",
    kind: "answer",
    body: "No.",
    replyTo: question.id,
  });
  assert.deepEqual(answer.audience, [{ name: "planner", as: "to", why: "asker" }]);

  // The update result says whom the change reached, like a delivery or an Activity does.
  const closed = await call<Task & { audience?: AudienceEntry[] }>(updateTaskRpc, {
    taskId: "fix-login",
    actorName: "planner.lead",
    resolution: "wont-do",
    reason: "The login page is being replaced",
  });
  assert.deepEqual(closed.audience, [{ name: "planner.ops", as: "cc", why: "requester" }]);
  const closing = mailTo(ops).slice(opsBefore);
  assert.equal(closing.length, 1);
  assert.match(closing[0], /cc="planner\.ops" addressed="cc"/);
  assert.doesNotMatch(closing[0], / to="/);
  assert.match(closing[0], /Closed as wont-do/);
  assert.deepEqual(activitiesOf("fix-login").at(-1)!.audience, [
    { name: "planner.ops", as: "cc", why: "requester" },
  ]);
});

test("a superseded Task names its replacement, and every closure records who closed it", async (t) => {
  const { call } = setup(t);
  await seed({ agents: [planner, lead, ops, dev] });
  await call(createTaskRpc, create({}));
  await call(createTaskRpc, create({ id: "auth-rework", title: "Rework auth" }));

  await assert.rejects(
    call(updateTaskRpc, {
      taskId: "fix-login",
      actorName: "planner",
      resolution: "wont-do",
      supersededBy: "auth-rework",
      reason: "Folded into the rework",
    }),
    /supersededBy goes with resolution superseded/,
  );
  const superseded = await call<Task & { audience?: AudienceEntry[] }>(updateTaskRpc, {
    taskId: "fix-login",
    actorName: "planner",
    resolution: "superseded",
    supersededBy: "auth-rework",
    reason: "Folded into the rework",
  });
  // The planner closing its own request reaches only the owner.
  assert.deepEqual(superseded.audience, [{ name: "planner.lead", as: "to", why: "owner" }]);
  assert.equal(taskOf("fix-login").supersededBy, "auth-rework");
  assert.equal(taskOf("fix-login").resolvedBy, "planner");
  assert.match(activitiesOf("fix-login").at(-1)!.body, /Closed as superseded by auth-rework/);

  // Reopening clears the closure; the owner's delivery records it again.
  await call(updateTaskRpc, {
    taskId: "fix-login",
    actorName: "planner",
    resolution: null,
    reason: "The rework was cancelled",
  });
  assert.equal(taskOf("fix-login").supersededBy, undefined);
  await call(deliverTaskRpc, {
    taskId: "fix-login",
    actorName: "planner.lead",
    result: "Login works again.",
    taskState: "done",
  });
  assert.equal(taskOf("fix-login").resolvedBy, "planner.lead");
});

test("the human closes Tasks as done: the owner hears of one close, a quiet bulk close tells no one", async (t) => {
  const { call, mailTo } = setup(t);
  await seed({ agents: [planner, lead, ops, dev] });
  await call(createTaskRpc, create({}));
  await call(createTaskRpc, create({ id: "old-a", title: "Old A" }));
  await call(createTaskRpc, create({ id: "old-b", title: "Old B" }));
  const swarmId = taskOf("fix-login").swarmId;
  const leadBefore = mailTo(lead).length;

  const accepted = await call<{ closed: string[]; skipped: string[] }>(closeTasksRpc, {
    swarmId,
    taskIds: ["fix-login"],
    reason: "The staging fix is enough",
  });
  assert.deepEqual(accepted, { closed: ["fix-login"], skipped: [] });
  assert.equal(taskOf("fix-login").resolution, "done");
  assert.equal(taskOf("fix-login").resolvedBy, "human");
  const change = activitiesOf("fix-login").at(-1)!;
  assert.equal(change.actorKind, "human");
  assert.match(change.body, /Closed as done\nReason: The staging fix is enough/);
  assert.deepEqual(change.audience, [{ name: "planner.lead", as: "to", why: "owner" }]);
  const told = mailTo(lead).slice(leadBefore);
  assert.equal(told.length, 1);
  assert.match(told[0], /kind="task-change"/);

  const cleared = await call<{ closed: string[]; skipped: string[] }>(closeTasksRpc, {
    swarmId,
    taskIds: ["old-a", "old-b", "fix-login"],
    reason: "Finished before Swarm recorded results",
    quiet: true,
  });
  assert.deepEqual(cleared, { closed: ["old-a", "old-b"], skipped: ["fix-login"] });
  assert.equal(mailTo(lead).length, leadBefore + 1);
  assert.equal(activitiesOf("old-a").at(-1)!.audience, undefined);
  await assert.rejects(
    call(closeTasksRpc, { swarmId, taskIds: ["no-such-task"], reason: "x" }),
    /Unknown Task: no-such-task/,
  );
});

test("a record may leave its brief to the owner, and a brief rewrite copies the requester and manager", async (t) => {
  const { call, mailTo } = setup(t);
  await seed({ agents: [planner, lead, ops, dev] });

  await assert.rejects(
    call(createTaskRpc, { ...create({}), brief: undefined }),
    /only work recorded for another seat \(assign: false\) may wait for its owner's brief/,
  );
  const recorded = await call<Task>(createTaskRpc, {
    ...create({ requester: "ops", assign: false }),
    brief: undefined,
  });
  assert.equal(recorded.brief, "");
  assert.equal(recorded.briefUnconfirmedBy, undefined);
  assert.match(mailTo(lead).at(-1)!, /No brief yet\. Write the agreement as you hold it/);

  // The owner writes the agreement it holds; the requester and the owner's manager hear of it.
  const written = await call<Task & { audience?: AudienceEntry[] }>(updateTaskRpc, {
    taskId: "fix-login",
    actorName: "planner.lead",
    brief: "Fix login for SSO users; the human still has to confirm the cookie scope.",
    reason: "Agreed with the human in conversation",
  });
  assert.deepEqual(written.audience, [
    { name: "planner.ops", as: "cc", why: "requester" },
    { name: "planner", as: "cc", why: "manager" },
  ]);
  assert.match(mailTo(ops).at(-1)!, /Brief revised\nReason: Agreed with the human in conversation/);
});

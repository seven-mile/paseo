import type { RpcInput } from "@getpaseo/plugin";
import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { randomUUID } from "node:crypto";
import {
  agentQualifiedName,
  currentOccupant,
  HUMAN,
  type Activity,
  type AgentRecord,
  type AudienceEntry,
  type SwarmState,
  type Task,
} from "../shared/models";
import { appendActivityRpc, createTaskRpc, deliverTaskRpc, updateTaskRpc } from "../shared/swarm";
import { newMessage } from "./mail";
import { flushMailbox } from "./mailbox";
import { resolveAudience, type Audience } from "./audience";
import { messagePrompt } from "./prompts";
import { resolveActivityRefs } from "./refs";
import { store, type SwarmChange } from "./state";
import { findAgent, findSwarm, swarmOfSeatName } from "./swarms";

// Tasks: who may change one, and the operations that leave their own history. Authority follows
// the reporting line from the Task's owner, never a list kept on the Task.

const now = () => new Date().toISOString();

// Activity kinds the framework writes itself. Agents get them through the operations, so a Task's
// history never holds a hand-written copy of what an operation already recorded.
const DELIVERY = "delivery";
const CHANGE = "change";

// The owner and every seat above it, nearest first.
export function lineOf(state: Readonly<SwarmState>, swarmId: string, ownerName: string): string[] {
  const seats = new Map(
    state.agents
      .filter((seat) => seat.swarmId === swarmId)
      .map((seat) => [agentQualifiedName(seat), seat]),
  );
  const line: string[] = [];
  let name: string | null = ownerName;
  while (name && !line.includes(name)) {
    line.push(name);
    name = seats.get(name)?.reportsTo ?? null;
  }
  return line;
}

// A refusal says what was refused, the rule and facts that refused it, and what to do instead.
function refusal(refused: string, rule: string, instead: string): Error {
  return new Error(`${refused}: ${rule}. ${instead}`);
}

function assertOnLine(task: Task, actor: AgentRecord, action: string): void {
  const name = agentQualifiedName(actor);
  const line = lineOf(store.read(), task.swarmId, task.managerName);
  if (line.includes(name)) return;
  if (actor.roleClass === "worker") {
    throw refusal(
      `${name} cannot ${action} Task ${task.id}`,
      `workers don't change Tasks, and ${task.id} is owned by ${task.managerName}`,
      `Send your result or question to ${actor.reportsTo ?? "your manager"} with swarm_message_send and taskId ${task.id}.`,
    );
  }
  throw refusal(
    `${name} cannot ${action} Task ${task.id}`,
    `only its owner and the seats above it can, and that line is ${line.join(" < ")}`,
    `Message ${task.managerName} about it, or ask a seat on that line to reassign the Task to you.`,
  );
}

function findTask(swarmId: string, taskId: string): Task {
  const task = store
    .read()
    .tasks.find((candidate) => candidate.swarmId === swarmId && candidate.id === taskId);
  if (!task) throw new Error(`Unknown Task: ${taskId}`);
  return task;
}

function actorSwarmId(input: { swarmId?: string }, actorName: string): string {
  return input.swarmId ? findSwarm(input.swarmId).id : swarmOfSeatName(actorName).id;
}

// A seat that can own a Task for this actor: not a worker, and the actor is on its line.
function assertOwnable(
  owner: AgentRecord,
  actor: AgentRecord,
  taskId: string,
  state: Readonly<SwarmState>,
): void {
  const ownerName = agentQualifiedName(owner);
  const actorName = agentQualifiedName(actor);
  if (owner.roleClass === "worker") {
    throw refusal(
      `${actorName} cannot make ${ownerName} the owner of ${taskId}`,
      "workers don't own Tasks",
      `Keep the Task with a supervisor and message ${ownerName} with taskId ${taskId}; delegating part of the work needs no Task of its own.`,
    );
  }
  if (!lineOf(state, owner.swarmId, ownerName).includes(actorName)) {
    throw refusal(
      `${actorName} cannot make ${ownerName} the owner of ${taskId}`,
      `a Task can be given only to yourself or a seat below you, and ${ownerName} reports to ${owner.reportsTo ?? "no one"}`,
      `Message ${ownerName}, or ask a seat above it to give it the Task.`,
    );
  }
}

// workerNames records who works on the Task. It grants nothing, so the only rule is that each
// entry is a worker on the owner's team.
function resolveTaskWorkers(workerNames: string[], owner: AgentRecord): string[] {
  const ownerName = agentQualifiedName(owner);
  return workerNames.map((workerName) => {
    const worker = findAgent(owner.swarmId, workerName, ownerName);
    if (worker.roleClass !== "worker" || worker.reportsTo !== ownerName) {
      throw refusal(
        `${agentQualifiedName(worker)} cannot be listed as a worker on a Task owned by ${ownerName}`,
        "workerNames lists the worker seats that report to the Task's owner",
        "Leave it out; anyone can still be messaged about the Task.",
      );
    }
    return agentQualifiedName(worker);
  });
}

interface ActivityInput {
  swarmId: string;
  taskId: string;
  actorName: string;
  actorKind: "agent" | "human";
  actorOccupant?: number;
  replyTo: string | null;
  responseProfile: "decision" | "steering" | "discussion" | null;
  kind: string;
  body: string;
  data: Record<string, unknown>;
  audience?: AudienceEntry[];
}

export function makeActivity(input: ActivityInput, state: Readonly<SwarmState>): Activity {
  return {
    id: `activity-${randomUUID()}`,
    swarmId: input.swarmId,
    taskId: input.taskId,
    actorName: input.actorName,
    actorKind: input.actorKind,
    ...(input.actorOccupant === undefined ? {} : { actorOccupant: input.actorOccupant }),
    replyTo: input.replyTo,
    responseProfile: input.responseProfile,
    kind: input.kind,
    body: input.body,
    data: input.data,
    refs: resolveActivityRefs(input.body, state, input.swarmId),
    ...(input.audience?.length ? { audience: input.audience } : {}),
    createdAt: now(),
  };
}

// One data-only envelope about a Task, queued in the same commit as the change it reports.
function taskMail(input: {
  taskId: string | null;
  recipient: AgentRecord;
  sender: string;
  kind: string;
  body: string;
  attributes?: Record<string, string | null | undefined>;
  // The write's audience, when the mail is one copy of an addressed write.
  audience?: Audience;
  addressed?: "to" | "cc";
}): SwarmChange {
  const recipientName = agentQualifiedName(input.recipient);
  return {
    op: "put",
    collection: "messages",
    record: newMessage({
      recipientAgentId: input.recipient.id,
      recipientName,
      senderName: input.sender,
      taskId: input.taskId,
      kind: "team",
      render: (messageId) =>
        messagePrompt({
          id: messageId,
          sender: input.sender,
          recipient: recipientName,
          to: input.audience?.to,
          cc: input.audience?.cc,
          addressed: input.addressed,
          message: input.body,
          taskId: input.taskId,
          attributes: { kind: input.kind, ...input.attributes },
        }),
    }),
  };
}

// One copy of an addressed write to each seat in its audience, each saying whether its reader is
// in to or cc.
function addressedMail(
  audience: Audience,
  mail: {
    taskId: string;
    sender: string;
    kind: string;
    body: string;
    attributes?: Record<string, string | null | undefined>;
  },
): SwarmChange[] {
  return audience.seats.map(({ seat, as }) =>
    taskMail({ ...mail, recipient: seat, audience, addressed: as }),
  );
}

// "human" or a seat of the swarm, by its qualified name.
function requesterName(swarmId: string, name: string, actorName: string): string {
  return name === HUMAN ? HUMAN : agentQualifiedName(findAgent(swarmId, name, actorName));
}

function assignment(task: Task, reason?: string): string {
  return [`# ${task.title}`, "", task.brief, ...(reason ? ["", `Reason: ${reason}`] : [])].join(
    "\n",
  );
}

function activeSeat(state: Readonly<SwarmState>, swarmId: string, name: string | null) {
  if (!name) return undefined;
  return state.agents.find(
    (seat) => seat.swarmId === swarmId && !seat.retired && agentQualifiedName(seat) === name,
  );
}

// Mail is part of the commit, so a failed send leaves it queued for the next flush.
async function deliverMail(context: PluginHandlerContext): Promise<void> {
  try {
    await flushMailbox(context);
  } catch (error) {
    console.warn("[paseo-swarm] Task mail stays queued for the next delivery attempt", error);
  }
}

interface FieldChange {
  field: "owner" | "status" | "resolution" | "title" | "brief";
  from: string | null;
  to: string | null;
}

function describeChanges(changes: FieldChange[], task: Task, reason?: string): string {
  const lines = changes.map((change) => {
    switch (change.field) {
      case "owner":
        return `Owner: ${change.from} → ${change.to}`;
      case "status":
        return `Status: ${change.from} → ${change.to}`;
      case "title":
        return `Title: ${change.from} → ${change.to}`;
      case "brief":
        return "Brief revised";
      case "resolution":
        if (change.to === null) return "Reopened";
        if (change.to === "duplicate") return `Closed as a duplicate of ${task.duplicateOf}`;
        if (change.to === "superseded" && task.supersededBy) {
          return `Closed as superseded by ${task.supersededBy}`;
        }
        return `Closed as ${change.to}`;
    }
  });
  return [...lines, ...(reason ? [`Reason: ${reason}`] : [])].join("\n");
}

// Seats that are retiring hand their open Tasks to the nearest seat above them that stays, each
// with a change Activity, and that seat gets one message listing them. Retired names leave every
// worker list. A Task whose whole line retires keeps its owner.
export function handOverTasks(
  state: Readonly<SwarmState>,
  retiring: readonly AgentRecord[],
  by: string,
): SwarmChange[] {
  if (retiring.length === 0) return [];
  const names = new Set(retiring.map(agentQualifiedName));
  const swarmIds = new Set(retiring.map((seat) => seat.swarmId));
  const changes: SwarmChange[] = [];
  const moved = new Map<string, { heir: AgentRecord; tasks: Task[]; from: Set<string> }>();
  const timestamp = now();
  for (const task of state.tasks) {
    if (!swarmIds.has(task.swarmId)) continue;
    const workerNames = task.workerNames.filter((name) => !names.has(name));
    let next: Task = task;
    if (workerNames.length !== task.workerNames.length) {
      next = { ...next, workerNames, updatedAt: timestamp };
    }
    if (names.has(task.managerName) && !task.resolution) {
      const heir = lineOf(state, task.swarmId, task.managerName)
        .slice(1)
        .filter((name) => !names.has(name))
        .map((name) => activeSeat(state, task.swarmId, name))
        .find((seat) => seat !== undefined);
      if (heir) {
        const heirName = agentQualifiedName(heir);
        next = { ...next, managerName: heirName, updatedAt: timestamp };
        changes.push({
          op: "put",
          collection: "activities",
          record: makeActivity(
            {
              swarmId: task.swarmId,
              taskId: task.id,
              actorName: by,
              actorKind: "agent",
              replyTo: null,
              responseProfile: null,
              kind: CHANGE,
              body: describeChanges(
                [{ field: "owner", from: task.managerName, to: heirName }],
                task,
                `${task.managerName} retired`,
              ),
              data: {
                changes: [{ field: "owner", from: task.managerName, to: heirName }],
                reason: `${task.managerName} retired`,
              },
            },
            state,
          ),
        });
        const entry = moved.get(heir.id) ?? { heir, tasks: [], from: new Set<string>() };
        entry.tasks.push(next);
        entry.from.add(task.managerName);
        moved.set(heir.id, entry);
      }
    }
    if (next !== task) changes.push({ op: "put", collection: "tasks", record: next });
  }
  for (const { heir, tasks, from } of moved.values()) {
    changes.push(
      taskMail({
        // A handover of several Tasks is about none of them in particular.
        taskId: tasks.length === 1 ? tasks[0].id : null,
        recipient: heir,
        sender: by,
        kind: "task-handover",
        body: [
          `${[...from].join(", ")} retired. You now own ${tasks.length === 1 ? "its open Task" : "its open Tasks"}:`,
          ...tasks.map((task) => `- ${task.id}: ${task.title}`),
          "Read each with swarm_task_read, then keep it, reassign it, or close it with a reason.",
        ].join("\n"),
      }),
    );
  }
  return changes;
}

type UpdateInput = RpcInput<typeof updateTaskRpc>;

interface UpdatePlan {
  newOwner: AgentRecord | null;
  workerNames: string[] | undefined;
}

// Checks an update against the Task as read, before the commit applies it.
function planUpdate(input: UpdateInput, task: Task, actor: AgentRecord): UpdatePlan {
  const actorName = agentQualifiedName(actor);
  const refuse = (rule: string, instead: string) =>
    refusal(`${actorName} cannot update Task ${task.id}`, rule, instead);
  let newOwner: AgentRecord | null = null;
  if (input.managerName !== undefined) {
    const candidate = findAgent(task.swarmId, input.managerName, actorName);
    if (agentQualifiedName(candidate) !== task.managerName) {
      assertOwnable(candidate, actor, task.id, store.read());
      newOwner = candidate;
    }
  }
  if (input.resolution === "done") {
    throw refuse(
      "a Task is completed by the delivery that carries its result",
      "Call swarm_task_deliver with the result and taskState: done.",
    );
  }
  if (input.resolution && !input.reason) {
    throw refuse(
      `closing it as ${input.resolution} without a result needs a reason`,
      "Pass reason with what made the work unnecessary.",
    );
  }
  if (input.resolution === null && task.resolution && !input.reason) {
    throw refuse("reopening a closed Task needs a reason", "Pass reason.");
  }
  if (input.resolution === "duplicate") {
    if (!input.duplicateOf || input.duplicateOf === task.id) {
      throw refuse(
        "a duplicate names the Task that carries the work",
        "Pass duplicateOf with that Task's id.",
      );
    }
    findTask(task.swarmId, input.duplicateOf);
  } else if (input.duplicateOf) {
    throw refuse("duplicateOf goes with resolution duplicate", "Pass both, or neither.");
  }
  if (input.supersededBy !== undefined) {
    if (input.resolution !== "superseded" || input.supersededBy === task.id) {
      throw refuse(
        "supersededBy goes with resolution superseded and names another Task",
        "Pass resolution superseded with the replacing Task's id, or leave supersededBy out.",
      );
    }
    findTask(task.swarmId, input.supersededBy);
  }
  const owner = newOwner ?? activeSeat(store.read(), task.swarmId, task.managerName);
  if (input.workerNames !== undefined) {
    if (!owner) {
      throw refuse(`its owner ${task.managerName} is retired`, "Reassign the Task first.");
    }
    return { newOwner, workerNames: resolveTaskWorkers(input.workerNames, owner) };
  }
  // Workers on the old owner's team leave the list with it.
  const workerNames = newOwner
    ? task.workerNames.filter((name) => name.startsWith(`${agentQualifiedName(newOwner)}.`))
    : undefined;
  return { newOwner, workerNames };
}

// The owner confirms a brief by writing it, even unchanged; a brief another seat wrote waits for
// that. A new owner takes the Task as an assignment, brief included.
function confirmBrief(
  next: Task,
  input: UpdateInput,
  changed: FieldChange[],
  actorName: string,
  reassigned: boolean,
): void {
  if (input.brief !== undefined && actorName === next.managerName) {
    delete next.briefUnconfirmedBy;
  } else if (changed.some((change) => change.field === "brief")) {
    next.briefUnconfirmedBy = actorName;
  }
  if (reassigned && next.managerName !== actorName) delete next.briefUnconfirmedBy;
}

function applyUpdate(
  current: Task,
  input: UpdateInput,
  plan: UpdatePlan,
  timestamp: string,
  actorName: string,
) {
  const changed: FieldChange[] = [];
  const next: Task = { ...current, updatedAt: timestamp };
  if (plan.newOwner) {
    next.managerName = agentQualifiedName(plan.newOwner);
    changed.push({ field: "owner", from: current.managerName, to: next.managerName });
  }
  if (input.status !== undefined && input.status !== current.status) {
    next.status = input.status;
    changed.push({ field: "status", from: current.status, to: input.status });
  }
  if (input.title !== undefined && input.title !== current.title) {
    next.title = input.title;
    changed.push({ field: "title", from: current.title, to: input.title });
  }
  if (input.brief !== undefined && input.brief !== current.brief) {
    next.brief = input.brief;
    next.briefUpdatedAt = timestamp;
    changed.push({ field: "brief", from: null, to: null });
  }
  if (input.resolution !== undefined && input.resolution !== (current.resolution ?? null)) {
    changed.push({ field: "resolution", from: current.resolution ?? null, to: input.resolution });
    delete next.resolution;
    delete next.resolvedAt;
    delete next.resolvedBy;
    delete next.duplicateOf;
    delete next.supersededBy;
    if (input.resolution) {
      next.resolution = input.resolution;
      next.resolvedAt = timestamp;
      next.resolvedBy = actorName;
      if (input.duplicateOf) next.duplicateOf = input.duplicateOf;
      if (input.supersededBy) next.supersededBy = input.supersededBy;
    }
  }
  if (plan.workerNames !== undefined) next.workerNames = plan.workerNames;
  if (input.data !== undefined) next.data = input.data;
  confirmBrief(next, input, changed, actorName, plan.newOwner !== null);
  return { next, changed };
}

// Changes the change Activity does not record, which the owner still hears of.
function informationalChanges(next: Task, plan: UpdatePlan, input: UpdateInput): string[] {
  return [
    ...(plan.workerNames !== undefined
      ? [`Workers: ${next.workerNames.join(", ") || "none"}`]
      : []),
    ...(input.data !== undefined ? ["Data replaced"] : []),
  ];
}

// Who hears of an update: the owner when another seat made it, and the requester, in cc, when the
// Task closes without a result, since otherwise the asker never learns the work was dropped.
function changeAudience(input: {
  state: Readonly<SwarmState>;
  current: Task;
  changed: FieldChange[];
  actorName: string;
  ownerTold: boolean;
}): Audience {
  const { state, current, changed, actorName, ownerTold } = input;
  const closed = changed.some(
    (change) => change.field === "resolution" && change.to !== null && change.to !== "done",
  );
  return resolveAudience({
    state,
    swarmId: current.swarmId,
    actorName,
    always:
      current.managerName !== actorName && ownerTold
        ? [{ name: current.managerName, why: "owner" }]
        : [],
    defaults: {
      cc: closed ? [{ name: current.requester ?? current.createdBy, why: "requester" }] : [],
    },
  });
}

// The change Activity for formal changes, the new owner's assignment, word to an owner that did
// not make the change, and a copy to the requester when the Task closes without a result.
function updateRecords(input: {
  state: Readonly<SwarmState>;
  current: Task;
  next: Task;
  changed: FieldChange[];
  input: UpdateInput;
  actor: AgentRecord;
  plan: UpdatePlan;
}): { records: SwarmChange[]; reached: AudienceEntry[] } {
  const { state, current, next, changed, actor, plan } = input;
  const { reason } = input.input;
  const actorName = agentQualifiedName(actor);
  const swarmId = next.swarmId;
  const records: SwarmChange[] = [];
  const summary = changed.length > 0 ? describeChanges(changed, next, reason) : null;
  const informational = informationalChanges(next, plan, input.input);
  const assigned =
    plan.newOwner && agentQualifiedName(plan.newOwner) !== actorName
      ? resolveAudience({
          state,
          swarmId,
          actorName,
          always: [{ name: agentQualifiedName(plan.newOwner), why: "owner" }],
        })
      : null;
  const told = changeAudience({
    state,
    current,
    changed,
    actorName,
    ownerTold: Boolean(summary) || informational.length > 0,
  });
  const reached = [...(assigned?.entries ?? []), ...told.entries].filter(
    (entry, index, all) => all.findIndex((other) => other.name === entry.name) === index,
  );
  if (summary) {
    records.push({
      op: "put",
      collection: "activities",
      record: makeActivity(
        {
          swarmId,
          taskId: next.id,
          actorName,
          actorKind: "agent",
          actorOccupant: currentOccupant(actor).number,
          replyTo: null,
          responseProfile: null,
          kind: CHANGE,
          body: summary,
          data: {
            changes: changed.map(({ field, from, to }) =>
              field === "brief" ? { field } : { field, from, to },
            ),
            ...(reason ? { reason } : {}),
            ...(changed.some((change) => change.field === "brief")
              ? { previousBrief: current.brief }
              : {}),
          },
          audience: reached,
        },
        state,
      ),
    });
  }
  if (assigned) {
    records.push(
      ...addressedMail(assigned, {
        taskId: next.id,
        sender: actorName,
        kind: "task-assigned",
        body: assignment(next, reason),
        attributes: { status: next.status, "previous-owner": current.managerName },
      }),
    );
  }
  const newOwnerName = assigned?.to[0];
  const change = {
    ...told,
    seats: told.seats.filter(({ seat }) => agentQualifiedName(seat) !== newOwnerName),
  };
  records.push(
    ...addressedMail(change, {
      taskId: next.id,
      sender: actorName,
      kind: "task-change",
      body: summary ?? [...informational, ...(reason ? [`Reason: ${reason}`] : [])].join("\n"),
    }),
  );
  return { records, reached };
}

// A brief rewrite by anyone but the owner names the version it was based on, and any rewrite that
// names one is refused when the brief changed after it. A late brief never replaces a newer one.
function assertBriefBase(current: Task, input: UpdateInput, actorName: string): void {
  if (input.brief === undefined || input.brief === current.brief) return;
  const base = current.briefUpdatedAt;
  if (!base) return;
  const refused = `${actorName} cannot rewrite the brief of Task ${current.id}`;
  if (input.briefBasedOn === undefined) {
    if (actorName === current.managerName) return;
    throw refusal(
      refused,
      `a seat other than its owner ${current.managerName} rewrites a brief only from the version it read`,
      "Read the Task with swarm_task_read and pass its briefUpdatedAt as briefBasedOn.",
    );
  }
  if (input.briefBasedOn !== base) {
    throw refusal(
      refused,
      `the brief was rewritten at ${base}, after the version you read (${input.briefBasedOn})`,
      "Read the Task again with swarm_task_read, fold your change into the current brief, and retry once with its briefUpdatedAt as briefBasedOn.",
    );
  }
}

// How long a repeated call counts as a retry of the same submission.
const RETRY_WINDOW_MS = 5 * 60_000;

// The delivery a call repeats, when it is a retry: the Task's newest Activity is this seat's
// identical delivery, made moments ago. Anything recorded on the Task since, such as a reopen or a
// change, makes the same text a new delivery.
function retriedDelivery(
  swarmId: string,
  taskId: string,
  actorName: string,
  input: RpcInput<typeof deliverTaskRpc>,
): Activity | undefined {
  const latest = store
    .read()
    .activities.findLast((activity) => activity.swarmId === swarmId && activity.taskId === taskId);
  if (
    latest?.kind === DELIVERY &&
    latest.actorName === actorName &&
    latest.body === input.result &&
    latest.data.taskState === input.taskState &&
    (latest.data.revises ?? null) === input.revises &&
    (latest.data.status ?? null) === (input.status ?? null) &&
    Date.now() - Date.parse(latest.createdAt) < RETRY_WINDOW_MS
  ) {
    return latest;
  }
  return undefined;
}

// A delivery goes To whoever asked for the work and Cc the owner's manager, who decides what comes
// next. The owner always hears of a delivery another seat makes on its Task.
function deliveryAudience(
  state: Readonly<SwarmState>,
  task: Task,
  actorName: string,
  input: RpcInput<typeof deliverTaskRpc>,
): Audience {
  const manager = activeSeat(state, task.swarmId, task.managerName)?.reportsTo;
  return resolveAudience({
    state,
    swarmId: task.swarmId,
    actorName,
    to: input.to,
    cc: input.cc,
    defaults: {
      to: [{ name: task.requester ?? task.createdBy, why: "requester" }],
      cc: manager ? [{ name: manager, why: "manager" }] : [],
    },
    always: [{ name: task.managerName, why: "owner" }],
  });
}

export function registerTasks(server: Pick<PluginServerContext, "handle">): void {
  // Creating a Task for another seat is its assignment: the owner gets the brief in its mailbox.
  // With assign: false it records work the owner already has, and the owner gets a record notice.
  server.handle(
    createTaskRpc,
    async (input: RpcInput<typeof createTaskRpc>, context: PluginHandlerContext) => {
      const swarmId = actorSwarmId(input, input.createdBy);
      const actor = findAgent(swarmId, input.createdBy);
      const actorName = agentQualifiedName(actor);
      if (actor.roleClass === "worker") {
        throw refusal(
          `${actorName} cannot create Task ${input.id}`,
          "workers don't create or own Tasks",
          `Send your result or question to ${actor.reportsTo ?? "your manager"} with swarm_message_send.`,
        );
      }
      const owner = findAgent(swarmId, input.managerName, actorName);
      const ownerName = agentQualifiedName(owner);
      assertOwnable(owner, actor, input.id, store.read());
      const workerNames = resolveTaskWorkers(input.workerNames, owner);
      const requester = requesterName(swarmId, input.requester ?? actorName, actorName);
      const recording = !input.assign && ownerName !== actorName;
      const timestamp = now();
      let result!: Task;
      let audience: Audience | undefined;
      await store.commit((state) => {
        if (state.tasks.some((task) => task.swarmId === swarmId && task.id === input.id)) {
          throw new Error(`Task id already exists: ${input.id}`);
        }
        result = {
          id: input.id,
          swarmId,
          title: input.title,
          brief: input.brief,
          status: input.status,
          managerName: ownerName,
          workerNames,
          createdBy: actorName,
          requester,
          data: input.data,
          briefUpdatedAt: timestamp,
          ...(recording ? { briefUnconfirmedBy: actorName } : {}),
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        const changes: SwarmChange[] = [{ op: "put", collection: "tasks", record: result }];
        if (ownerName !== actorName) {
          audience = resolveAudience({
            state,
            swarmId,
            actorName,
            always: [{ name: ownerName, why: "owner" }],
          });
          changes.push(
            ...addressedMail(audience, {
              taskId: result.id,
              sender: actorName,
              kind: recording ? "task-recorded" : "task-assigned",
              body: assignment(result),
              attributes: {
                status: result.status,
                requester: requester === actorName ? undefined : requester,
              },
            }),
          );
        }
        return changes;
      });
      if (audience) await deliverMail(context);
      return { ...result, ...(audience ? { audience: audience.entries } : {}) };
    },
  );

  server.handle(
    updateTaskRpc,
    async (input: RpcInput<typeof updateTaskRpc>, context: PluginHandlerContext) => {
      const swarmId = actorSwarmId(input, input.actorName);
      const task = findTask(swarmId, input.taskId);
      const actor = findAgent(swarmId, input.actorName);
      assertOnLine(task, actor, "update");
      const plan = planUpdate(input, task, actor);
      let result!: Task;
      let reached: AudienceEntry[] = [];
      await store.commit((state) => {
        const current = state.tasks.find(
          (candidate) => candidate.swarmId === swarmId && candidate.id === task.id,
        );
        if (!current) throw new Error(`Unknown Task: ${task.id}`);
        assertBriefBase(current, input, agentQualifiedName(actor));
        const { next, changed } = applyUpdate(
          current,
          input,
          plan,
          now(),
          agentQualifiedName(actor),
        );
        result = next;
        const written = updateRecords({ state, current, next, changed, input, actor, plan });
        reached = written.reached;
        return [{ op: "put", collection: "tasks", record: next }, ...written.records];
      });
      await deliverMail(context);
      return { ...result, audience: reached };
    },
  );

  // One call records a result: the delivery Activity, the Task state it leaves the Task in, and
  // word to the owner's line. taskState is the state after the delivery, so a correction that
  // invalidates a finished result reopens the Task in the same commit.
  server.handle(
    deliverTaskRpc,
    async (input: RpcInput<typeof deliverTaskRpc>, context: PluginHandlerContext) => {
      const swarmId = actorSwarmId(input, input.actorName);
      const task = findTask(swarmId, input.taskId);
      const actor = findAgent(swarmId, input.actorName);
      const actorName = agentQualifiedName(actor);
      assertOnLine(task, actor, "deliver on");
      const deliveries = store
        .read()
        .activities.filter(
          (activity) =>
            activity.swarmId === swarmId &&
            activity.taskId === task.id &&
            activity.kind === DELIVERY,
        );
      if (input.revises && !deliveries.some((activity) => activity.id === input.revises)) {
        throw refusal(
          `${actorName} cannot revise ${input.revises}`,
          `it is not a delivery on Task ${task.id}`,
          "Pass the id of an earlier delivery on this Task (swarm_activity_list shows them), or leave revises out.",
        );
      }
      const retried = retriedDelivery(swarmId, task.id, actorName, input);
      if (retried) return { task: findTask(swarmId, task.id), activity: retried, duplicate: true };

      let result!: { task: Task; activity: Activity };
      await store.commit((state) => {
        const current = state.tasks.find(
          (candidate) => candidate.swarmId === swarmId && candidate.id === task.id,
        );
        if (!current) throw new Error(`Unknown Task: ${task.id}`);
        const timestamp = now();
        const next: Task = { ...current, updatedAt: timestamp };
        if (input.status !== undefined) next.status = input.status;
        // A delivery by the owner confirms the brief it worked from.
        if (actorName === current.managerName) delete next.briefUnconfirmedBy;
        const audience = deliveryAudience(state, current, actorName, input);
        const reopened = input.taskState === "open" && current.resolution !== undefined;
        delete next.resolution;
        delete next.resolvedAt;
        delete next.resolvedBy;
        delete next.duplicateOf;
        delete next.supersededBy;
        if (input.taskState === "done") {
          const already = current.resolution === "done";
          next.resolution = "done";
          next.resolvedAt = already ? current.resolvedAt : timestamp;
          next.resolvedBy = already ? (current.resolvedBy ?? actorName) : actorName;
        }
        const activity = makeActivity(
          {
            swarmId,
            taskId: task.id,
            actorName,
            actorKind: "agent",
            actorOccupant: currentOccupant(actor).number,
            replyTo: null,
            responseProfile: null,
            kind: DELIVERY,
            body: input.result,
            data: {
              taskState: input.taskState,
              ...(reopened ? { reopened: current.resolution } : {}),
              ...(input.status !== undefined ? { status: input.status } : {}),
              ...(input.status !== undefined && input.status !== current.status
                ? { previousStatus: current.status }
                : {}),
              ...(input.revises ? { revises: input.revises } : {}),
            },
            audience: audience.entries,
          },
          state,
        );
        result = { task: next, activity };
        const changes: SwarmChange[] = [
          { op: "put", collection: "tasks", record: next },
          { op: "put", collection: "activities", record: activity },
        ];
        changes.push(
          ...addressedMail(audience, {
            taskId: next.id,
            sender: actorName,
            kind: DELIVERY,
            body: input.result,
            attributes: {
              activity: activity.id,
              "task-state": input.taskState,
              reopened: reopened ? current.resolution : undefined,
              status: next.status,
              revises: input.revises,
            },
          }),
        );
        return changes;
      });
      await deliverMail(context);
      return { ...result, duplicate: false };
    },
  );

  // An Activity is on the record; it reaches someone only when addressed, when it answers an
  // asker, or when a seat above the owner writes it.
  server.handle(
    appendActivityRpc,
    async (input: RpcInput<typeof appendActivityRpc>, context: PluginHandlerContext) => {
      const swarmId = actorSwarmId(input, input.actorName);
      const task = findTask(swarmId, input.taskId);
      const actor = findAgent(swarmId, input.actorName);
      const actorName = agentQualifiedName(actor);
      assertOnLine(task, actor, "append an Activity to");
      if (input.kind === DELIVERY) {
        throw refusal(
          `${actorName} cannot append a delivery Activity`,
          "results are recorded by swarm_task_deliver, which also sets the Task's state",
          "Call swarm_task_deliver with the result.",
        );
      }
      if (input.kind === CHANGE) {
        throw refusal(
          `${actorName} cannot append a change Activity`,
          "Swarm writes change Activities when owner, status, resolution, title or brief change",
          "Make the change with swarm_task_update; append a decision only to explain what the change doesn't.",
        );
      }
      const { to, cc, ...fields } = input;
      let result!: Activity;
      let audience!: Audience;
      await store.commit((state) => {
        const asked = input.replyTo
          ? state.activities.find(
              (activity) => activity.swarmId === swarmId && activity.id === input.replyTo,
            )
          : undefined;
        audience = resolveAudience({
          state,
          swarmId,
          actorName,
          to,
          cc,
          always: [
            { name: task.managerName, why: "owner" },
            ...(asked
              ? [
                  {
                    name: asked.actorKind === "human" ? HUMAN : asked.actorName,
                    why: "asker" as const,
                  },
                ]
              : []),
          ],
        });
        result = makeActivity(
          {
            ...fields,
            swarmId,
            actorName,
            actorKind: "agent",
            actorOccupant: currentOccupant(actor).number,
            audience: audience.entries,
          },
          state,
        );
        return [
          { op: "put", collection: "activities", record: result },
          ...addressedMail(audience, {
            taskId: task.id,
            sender: actorName,
            kind: "activity",
            body: result.body,
            attributes: {
              activity: result.id,
              "activity-kind": result.kind,
              "reply-to": result.replyTo,
            },
          }),
        ];
      });
      if (audience.seats.length > 0) await deliverMail(context);
      return result;
    },
  );
}

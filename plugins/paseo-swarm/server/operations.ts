import type { RpcInput } from "@getpaseo/plugin";
import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import { listPwaRoles, readPwa, readPwaFiles } from "./pwa";
import { messagePrompt, messageReceipt, refreshedPrompt, turnDigestRow } from "./prompts";
import {
  assemblePrompt,
  findSeat,
  listSeats,
  readSeatHistory,
  resetSeats,
  seatOfAgent,
  seatView,
  updateSeats,
  type SeatView,
} from "./seats";
import type { TurnSummary } from "./turns";
import { enqueueMessage, flushMailbox, sendThroughMailbox } from "./mailbox";
import { makeActivity, registerTasks } from "./tasks";
import { store } from "./state";
import { readPwaSource } from "./source";
import {
  createSwarm,
  findAgent,
  findSwarm,
  resolveSwarm,
  swarmForProject,
  swarmOf,
  swarmOfSeatName,
  swarmSeats,
  swarmTasks,
} from "./swarms";
import {
  conditionalValue,
  conditionalView,
  rosterView,
  seatReadView,
  taskView,
  tasksView,
} from "./views";
import { planRoster, readDesired } from "./roster";
import {
  assertNoConflict,
  mutateSpec,
  pendingConflict,
  recoverIntents,
  resolveConflict,
  withSwarmLock,
} from "./spec";
import {
  appendHumanActivityRpc,
  boardReadRpc,
  rosterReadRpc,
  seatReadRpc,
  taskReadRpc,
  tasksReadRpc,
  createSeatRpc,
  directoryRecoverRpc,
  directoryUpRpc,
  statusReadRpc,
  type RosterPlan,
  sendMessageRpc,
  pwaSourceReadRpc,
  pwaSourceSetRpc,
  pwaRolesReadRpc,
  mailboxReadRpc,
  refreshPromptRpc,
  seatHistoryReadRpc,
  seatListRpc,
  seatResetRpc,
  seatRetireRpc,
  seatUpdateRpc,
  SWARM_FEATURES,
} from "../shared/swarm";
import type {
  AgentConfig,
  AgentRecord,
  MailboxMessage,
  MessageKind,
  SwarmRecord,
  Task,
} from "../shared/models";
import { agentQualifiedName, currentOccupant, mailboxMessageStatus } from "../shared/models";

const now = () => new Date().toISOString();
const id = (prefix: string) => `${prefix}-${randomUUID()}`;

function swarmSummary(swarm: SwarmRecord) {
  return {
    id: swarm.id,
    name: swarm.name,
    directory: swarm.directory,
    projectId: swarm.projectId,
    revision: swarm.source.revision,
  };
}

async function availableAgents(context: PluginHandlerContext) {
  const agents: Array<{ id: string; workspaceId?: string }> = [];
  let cursor: string | undefined;
  do {
    const page = await context.paseo.agents.list({
      filter: { includeArchived: false },
      page: { limit: 200, ...(cursor ? { cursor } : {}) },
    });
    for (const entry of page.entries) agents.push(entry.agent);
    cursor = page.pageInfo.nextCursor ?? undefined;
  } while (cursor);
  return agents;
}

async function projectRoot(projectId: string, context: PluginHandlerContext): Promise<string> {
  const { projects } = await context.paseo.projects.list({});
  const project = projects.find((candidate) => candidate.projectId === projectId);
  if (!project) throw new Error(`Unknown project: ${projectId}`);
  return project.projectRootPath;
}

function realDirectory(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function contains(directory: string, path: string): boolean {
  const root = realDirectory(directory);
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

// The project whose checkout or workspace holds the directory, the closest one if several do.
async function projectOfDirectory(
  cwd: string,
  context: PluginHandlerContext,
): Promise<string | null> {
  const roots: Array<{ projectId: string; path: string }> = [];
  const { projects } = await context.paseo.projects.list({});
  for (const project of projects) {
    roots.push({ projectId: project.projectId, path: project.projectRootPath });
  }
  let cursor: string | undefined;
  do {
    const page = await context.paseo.workspaces.list({
      page: { limit: 200, ...(cursor ? { cursor } : {}) },
    });
    for (const workspace of page.entries) {
      if (workspace.workspaceDirectory) {
        roots.push({ projectId: workspace.projectId, path: workspace.workspaceDirectory });
      }
    }
    cursor = page.pageInfo.nextCursor ?? undefined;
  } while (cursor);
  const closest = roots
    .filter((root) => contains(root.path, cwd))
    .sort((a, b) => realDirectory(b.path).length - realDirectory(a.path).length)[0];
  return closest?.projectId ?? null;
}

// The swarm a directory command means. An explicit swarm or project wins. Otherwise the CLI's
// working directory names it: the swarm directory it is in, or the swarms of the project whose
// checkout or workspace holds it. A directory in neither falls back to the only swarm.
async function directorySwarm(
  input: { swarmId?: string; projectId?: string; cwd?: string },
  context: PluginHandlerContext,
): Promise<SwarmRecord> {
  const { cwd, ...scope } = input;
  if (scope.swarmId || scope.projectId || !cwd) return resolveSwarm(scope);
  const real = realDirectory(cwd);
  const inSwarm = store.read().swarms.find((swarm) => contains(swarm.directory, real));
  if (inSwarm) return inSwarm;
  const projectId = await projectOfDirectory(real, context);
  return resolveSwarm(projectId ? { projectId } : {});
}

interface ProjectScopeInput {
  projectId?: string;
  workspaceId?: string | null;
  parent: AgentRecord | null;
}

async function projectScope(
  input: ProjectScopeInput,
  context: PluginHandlerContext,
): Promise<string | undefined> {
  let projectId = input.projectId ?? input.parent?.projectId;
  if (input.projectId && input.parent?.projectId && input.projectId !== input.parent.projectId) {
    throw new Error("Choose a manager and workspace in the selected project.");
  }
  const parentWorkspaceId = input.parent ? await seatWorkspaceId(input.parent, context) : null;
  const workspaceIds = new Set([parentWorkspaceId, input.workspaceId]);
  for (const workspaceId of workspaceIds) {
    if (!workspaceId) continue;
    const workspace = await context.paseo.workspaces.ref(workspaceId).refresh();
    if (!workspace) throw new Error(`Unknown workspace: ${workspaceId}`);
    if (projectId && projectId !== workspace.projectId) {
      throw new Error("Choose a manager and workspace in the selected project.");
    }
    projectId = workspace.projectId;
  }
  if (projectId) await projectRoot(projectId, context);
  return projectId;
}

// Where a seat works: its own record, or for seats made before workspaces were recorded, where its
// agent runs.
async function seatWorkspaceId(
  seat: AgentRecord,
  context: PluginHandlerContext,
): Promise<string | null> {
  if (seat.workspaceId || seat.paseoAgentId === null) return seat.workspaceId;
  const snapshot = (await context.paseo.agents.ref(seat.paseoAgentId).refresh())?.agent;
  if (!snapshot) throw new Error(`Unknown manager agent: ${seat.paseoAgentId}`);
  return snapshot.workspaceId ?? null;
}

function ensureUniqueName(
  swarmId: string,
  name: string,
  qualifiedName: string,
  parent: AgentRecord | null,
  exceptPaseoAgentId?: string,
): void {
  const agents = swarmSeats(swarmId, true);
  if (
    agents.some(
      (candidate) =>
        candidate.paseoAgentId !== exceptPaseoAgentId &&
        agentQualifiedName(candidate) === qualifiedName,
    )
  ) {
    throw new Error(`Agent qualified name already exists: ${qualifiedName}`);
  }
  if (
    parent &&
    agents.some(
      (candidate) =>
        candidate.paseoAgentId !== exceptPaseoAgentId &&
        candidate.reportsTo === agentQualifiedName(parent) &&
        (candidate.name === name || candidate.aliases.includes(name)),
    )
  ) {
    throw new Error(`Agent name already exists under ${agentQualifiedName(parent)}: ${name}`);
  }
}

// The manager of a new seat: reportsTo when given, else the seat that asks.
function parentFor(
  swarmId: string,
  actor: AgentRecord | null,
  reportsTo: string | null,
): AgentRecord | null {
  return reportsTo
    ? findAgent(swarmId, reportsTo, actor ? agentQualifiedName(actor) : undefined)
    : actor;
}

// The swarm a request that may create seats acts in: the one it names, else its actor's or its
// manager's, else its project's, which a project with a PWA directory chosen before swarms gets on
// first use.
async function requestSwarm(
  input: {
    swarmId?: string;
    projectId?: string;
    workspaceId?: string | null;
    actorName?: string | null;
    reportsTo?: string | null;
  },
  context: PluginHandlerContext,
): Promise<SwarmRecord> {
  if (input.swarmId) return findSwarm(input.swarmId);
  if (input.actorName) return swarmOfSeatName(input.actorName);
  if (input.reportsTo) return swarmOfSeatName(input.reportsTo);
  return swarmForProject(await projectScope({ ...input, parent: null }, context));
}

// A project-attached swarm takes seats only from its own project.
function assertSwarmProject(swarm: SwarmRecord, projectId: string | undefined): void {
  if (swarm.projectId !== null && swarm.projectId !== projectId) {
    throw new Error("Choose a manager and workspace in the selected project.");
  }
}

// The swarm an actor-named request acts in.
function actorSwarm(input: { swarmId?: string }, actorName: string): SwarmRecord {
  return input.swarmId ? findSwarm(input.swarmId) : swarmOfSeatName(actorName);
}

function assertCanCreateAgent(
  actor: AgentRecord | null,
  parent: AgentRecord | null,
  roleClass: AgentRecord["roleClass"],
): void {
  if (!actor) return;
  if (actor.roleClass === "worker") throw new Error(`Worker ${actor.name} cannot create an agent`);
  if (actor.roleClass === "planner" && roleClass !== "supervisor") {
    throw new Error(`Planner ${actor.name} can create supervisors only`);
  }
  if (actor.roleClass === "supervisor" && roleClass !== "worker") {
    throw new Error(`Supervisor ${actor.name} can create workers only`);
  }
  if (actor.roleClass === "planner" && parent && parent.roleClass !== "planner") {
    throw new Error(`Agent ${actor.name} cannot create under ${agentQualifiedName(parent)}`);
  }
  if (actor.roleClass === "supervisor" && parent?.id !== actor.id) {
    throw new Error(
      `Agent ${actor.name} cannot create under ${parent ? agentQualifiedName(parent) : "no parent"}`,
    );
  }
}

function findTask(swarmId: string, taskId: string): Task {
  const value = swarmTasks(swarmId).find((candidate) => candidate.id === taskId);
  if (!value) throw new Error(`Unknown Task: ${taskId}`);
  return value;
}

// A Task named by a request with no actor: in the swarm it names, else the one Task with that id.
function findTaskFor(input: { swarmId?: string; projectId?: string }, taskId: string): Task {
  if (input.swarmId || input.projectId) return findTask(resolveSwarm(input).id, taskId);
  const tasks = store.read().tasks.filter((task) => task.swarmId && task.id === taskId);
  if (tasks.length > 1) throw new Error(`Task ${taskId} exists in several swarms. Name the swarm.`);
  if (tasks.length === 0) throw new Error(`Unknown Task: ${taskId}`);
  return tasks[0];
}

async function assertCreationWorkspace(
  actor: AgentRecord | null,
  workspaceId: string,
  context: PluginHandlerContext,
): Promise<void> {
  if (actor) {
    const seats = store.read().agents.filter((candidate) => !candidate.retired);
    const allowed = seats.filter(
      (candidate) => candidate.id === actor.id || candidate.reportsTo === agentQualifiedName(actor),
    );
    // Reserved seats have no agent in the workspace yet, but they will.
    const outsiderSeat = seats.find(
      (seat) => seat.workspaceId === workspaceId && !allowed.includes(seat),
    );
    if (outsiderSeat) {
      throw new Error(
        `Workspace ${workspaceId} holds seat ${agentQualifiedName(outsiderSeat)} outside ${agentQualifiedName(actor)}'s direct roster`,
      );
    }
    const allowedIds = new Set(allowed.map((candidate) => candidate.paseoAgentId));
    const outsider = (await availableAgents(context)).find(
      (agent) => agent.workspaceId === workspaceId && !allowedIds.has(agent.id),
    );
    if (outsider) {
      throw new Error(
        `Workspace ${workspaceId} contains agent ${outsider.id} outside ${agentQualifiedName(actor)}'s direct roster`,
      );
    }
  }
}

// What a new seat wants its agent to run; its first mail starts an agent with it.
function seatConfig(input: RpcInput<typeof createSeatRpc>): AgentConfig {
  return {
    provider: input.provider,
    ...(input.modeId ? { modeId: input.modeId } : {}),
    ...(input.thinkingOptionId ? { thinkingOptionId: input.thinkingOptionId } : {}),
    ...(input.featureValues ? { featureValues: input.featureValues } : {}),
  };
}

// A new seat gets its workspace when its first agent starts (placeSeat in server/seats.ts), so a
// change the spec refuses leaves no workspace behind. A manager can still name one it made itself.
async function namedWorkspace(
  input: RpcInput<typeof createSeatRpc>,
  actor: AgentRecord | null,
  parent: AgentRecord | null,
  context: PluginHandlerContext,
): Promise<string | null> {
  if (!input.workspaceId) return null;
  const owner = actor ?? parent;
  if (
    input.roleClass === "supervisor" &&
    owner &&
    input.workspaceId === (await seatWorkspaceId(owner, context))
  ) {
    throw new Error(
      "A supervisor works in a workspace of its own. Leave workspaceId out and Swarm gives it a new worktree.",
    );
  }
  await assertCreationWorkspace(actor, input.workspaceId, context);
  return input.workspaceId;
}

// One message to its recipient and the same envelope to each Cc seat. Every copy names the
// recipient in to, so a Cc reader knows it is informed, not asked.
async function sendWithCopies(
  input: {
    swarmId: string;
    recipient: AgentRecord;
    cc: readonly string[];
    sender: string;
    taskId: string | null;
    kind: MessageKind;
    body: string;
    attributes?: Record<string, string | null | undefined>;
  },
  context: PluginHandlerContext,
): Promise<{ message: MailboxMessage; copies: MailboxMessage[] }> {
  const to = agentQualifiedName(input.recipient);
  const copiedSeats = [
    ...new Map(
      input.cc
        .map((name) => findAgent(input.swarmId, name, input.recipient.reportsTo ?? undefined))
        .filter(
          (seat) => agentQualifiedName(seat) !== to && agentQualifiedName(seat) !== input.sender,
        )
        .map((seat) => [seat.id, seat]),
    ).values(),
  ];
  const cc = copiedSeats.map(agentQualifiedName);
  const queue = (seat: AgentRecord) =>
    enqueueMessage({
      recipientAgentId: seat.id,
      recipientName: agentQualifiedName(seat),
      senderName: input.sender,
      taskId: input.taskId,
      kind: input.kind,
      render: (messageId) =>
        messagePrompt({
          id: messageId,
          sender: input.sender,
          recipient: to,
          cc,
          message: input.body,
          taskId: input.taskId,
          attributes: input.attributes,
        }),
    });
  const message = await queue(input.recipient);
  const copies = [];
  for (const seat of copiedSeats) copies.push(await queue(seat));
  await flushMailbox(context);
  const current = (queued: MailboxMessage) =>
    store.read().messages.find((candidate) => candidate.id === queued.id) ?? queued;
  return { message: current(message), copies: copies.map(current) };
}

export function registerOperations(server: Pick<PluginServerContext, "handle">): void {
  registerTasks(server);
  // The board of one swarm, or of every swarm when the request names none, as before swarms.
  server.handle(boardReadRpc, async ({ projectId, swarmId, includeReserved }, context) => {
    if (projectId) await projectRoot(projectId, context);
    const saved = store.read();
    const swarms = saved.swarms.filter(
      (swarm) =>
        (!swarmId || swarm.id === swarmId) && (!projectId || swarm.projectId === projectId),
    );
    const inScope = new Set(swarms.map((swarm) => swarm.id));
    const scoped = <T extends { swarmId?: string }>(records: readonly T[]) =>
      records.filter((record) => record.swarmId !== undefined && inScope.has(record.swarmId));
    const board = {
      version: saved.version,
      // A reserved seat has no agent until its first mail starts one; a person can send that mail.
      agents: scoped(saved.agents)
        .filter((agent) => agent.paseoAgentId !== null || includeReserved === true)
        .map(seatView),
      tasks: scoped(saved.tasks),
      activities: scoped(saved.activities),
      swarms: swarms.map((swarm) => ({
        id: swarm.id,
        name: swarm.name,
        projectId: swarm.projectId,
      })),
      features: SWARM_FEATURES,
    };
    if (!projectId && !swarmId) return board;
    if (swarms.length !== 1) return { ...board, statuses: [] };
    const { files } = swarms[0].source;
    const planner = listPwaRoles(files).find((role) => role.roleClass === "planner");
    if (!planner) return { ...board, statuses: [] };
    return { ...board, statuses: readPwa(files, planner.role).statuses };
  });
  server.handle(rosterReadRpc, ({ etag }) => conditionalView("roster", etag, rosterView));
  server.handle(seatReadRpc, ({ seatId, etag }) =>
    conditionalValue(seatReadView(store.read(), seatId), etag),
  );
  server.handle(tasksReadRpc, async ({ projectId, swarmId, etag }, context) => {
    if (projectId) await projectRoot(projectId, context);
    return conditionalView(`tasks:${projectId ?? ""}:${swarmId ?? ""}`, etag, (state) =>
      tasksView(state, { projectId, swarmId }),
    );
  });
  server.handle(taskReadRpc, ({ swarmId, taskId, limit, etag }) =>
    conditionalView(`task:${swarmId}/${taskId}:${limit}`, etag, (state) =>
      taskView(state, { swarmId, taskId, limit }),
    ),
  );
  // A project's swarm directory, or the PWA directory chosen before swarms that its swarm will
  // be instantiated from.
  server.handle(pwaSourceReadRpc, async ({ projectId }, context) => {
    if (projectId) await projectRoot(projectId, context);
    const swarm = store
      .read()
      .swarms.find((candidate) => candidate.projectId === (projectId ?? null));
    return { path: swarm?.directory ?? readPwaSource(projectId) };
  });
  // Instantiates the chosen directory as the project's swarm. The chosen directory is copied, so
  // a template or a directory shared by several projects is never written.
  server.handle(pwaSourceSetRpc, async ({ path, projectId }, context) => {
    const root = projectId ? await projectRoot(projectId, context) : process.cwd();
    if (store.read().swarms.some((swarm) => swarm.projectId === (projectId ?? null))) {
      throw new Error(
        "This project already has a swarm. Edit its directory and run `paseo-swarm swarm up`.",
      );
    }
    const trimmed = path.trim();
    if (!trimmed) throw new Error("Enter a PWA directory.");
    const swarm = await createSwarm({
      sourceDirectory: resolve(root, trimmed),
      projectId: projectId ?? null,
    });
    return { path: swarm.directory };
  });
  // The roles a seat can take: from a directory being chosen, else from the swarm's accepted PWA.
  server.handle(pwaRolesReadRpc, async ({ roleClass, path, projectId, swarmId }, context) => {
    const root = projectId ? await projectRoot(projectId, context) : process.cwd();
    let files;
    if (path) {
      files = readPwaFiles(resolve(root, path));
    } else if (
      swarmId ||
      store.read().swarms.some((swarm) => swarm.projectId === (projectId ?? null))
    ) {
      files = resolveSwarm({ swarmId, projectId }).source.files;
    } else {
      const directory = readPwaSource(projectId);
      if (!directory) {
        throw new Error("No PWA directory configured. Choose one in Project Settings → Swarm.");
      }
      files = readPwaFiles(directory);
    }
    const roles = listPwaRoles(files);
    for (const role of roles) readPwa(files, role.role);
    return roles.filter((role) => !roleClass || role.roleClass === roleClass);
  });

  server.handle(
    createSeatRpc,
    async (input: RpcInput<typeof createSeatRpc>, context: PluginHandlerContext) => {
      const swarm = await requestSwarm(input, context);
      const actor = input.actorName ? findAgent(swarm.id, input.actorName) : null;
      const parent = parentFor(swarm.id, actor, input.reportsTo);
      assertCanCreateAgent(actor, parent, input.roleClass);
      if (!input.provider.includes("/")) {
        throw new Error(`A new seat needs provider/model, not ${input.provider}`);
      }
      const projectId = await projectScope({ ...input, parent }, context);
      assertSwarmProject(swarm, projectId);
      const qualifiedName = parent ? `${agentQualifiedName(parent)}.${input.name}` : input.name;
      ensureUniqueName(swarm.id, input.name, qualifiedName, parent);
      const reportsTo = parent ? agentQualifiedName(parent) : null;
      // Fails now, rather than at the first mail, when the role is not in the PWA.
      assemblePrompt(
        {
          name: input.name,
          qualifiedName,
          roleClass: input.roleClass,
          role: input.role,
          reportsTo,
        },
        swarm.source.files,
      );
      const workspaceId = await namedWorkspace(input, actor, parent, context);
      const timestamp = now();
      const seat: AgentRecord = {
        id: id("agent"),
        swarmId: swarm.id,
        paseoAgentId: null,
        name: input.name,
        qualifiedName,
        aliases: input.aliases,
        roleClass: input.roleClass,
        role: input.role,
        reportsTo,
        workspaceId,
        projectId,
        agentConfig: seatConfig(input),
        generation: 0,
        retired: false,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await mutateSpec(swarm.id, () => {
        ensureUniqueName(swarm.id, input.name, qualifiedName, parent);
        return [{ kind: "add", seat }];
      });
      return seatView(seat);
    },
  );

  // Roster reconciliation: accepts the swarm directory, its seats and PWA together, in one commit.
  // No agent is touched; each seat's next mail brings its agent in line.
  server.handle(directoryUpRpc, async ({ dryRun, ...scope }, context) => {
    const swarm = await directorySwarm(scope, context);
    // Under the lock seat tools take, so up never reads a file a seat change is writing.
    const plan = await withSwarmLock(swarm.id, async () => {
      await recoverIntents(swarm.id);
      if (!dryRun) assertNoConflict(swarm.id);
      const desired = readDesired(swarm, swarmSeats(swarm.id));
      let result!: RosterPlan;
      await store.commit((state) => {
        const planned = planRoster(findSwarm(swarm.id), desired, state);
        result = planned.plan;
        if (dryRun) return [];
        if (result.refusals.length > 0) {
          throw new Error(`swarm up refused: ${result.refusals.join(" ")}`);
        }
        return planned.changes;
      });
      return result;
    });
    if (!dryRun) {
      // Delivers the handover of retired seats' open Tasks.
      await flushMailbox(context).catch((error) => {
        console.warn("[paseo-swarm] Task handover mail stays queued", error);
      });
    }
    return { swarm: swarmSummary(findSwarm(swarm.id)), plan };
  });
  server.handle(directoryRecoverRpc, async ({ keep, ...scope }, context) => {
    const swarm = await directorySwarm(scope, context);
    const intent = await resolveConflict(swarm.id, keep);
    return {
      swarm: swarmSummary(findSwarm(swarm.id)),
      seats: intent.changes.map((change) => agentQualifiedName(change.seat)),
    };
  });
  server.handle(statusReadRpc, async (scope, context) => {
    const swarm = await directorySwarm(scope, context);
    let unapplied: RosterPlan | null = null;
    let invalid: string | null = null;
    try {
      const plan = planRoster(swarm, readDesired(swarm, swarmSeats(swarm.id)), store.read()).plan;
      const empty =
        plan.source === null &&
        !plan.name &&
        [plan.reserve, plan.restore, plan.update, plan.retire, plan.refusals].every(
          (entries) => entries.length === 0,
        );
      unapplied = empty ? null : plan;
    } catch (error) {
      invalid = error instanceof Error ? error.message : String(error);
    }
    return {
      swarm: swarmSummary(swarm),
      unapplied,
      invalid,
      recovery: pendingConflict(swarm.id)?.conflict ?? null,
      seats: swarmSeats(swarm.id).map(seatView),
    };
  });

  server.handle(refreshPromptRpc, async ({ paseoAgentId }) => {
    const current = seatOfAgent(paseoAgentId);
    if (!current) throw new Error(`Unknown active Swarm agent: ${paseoAgentId}`);
    const assembled = assemblePrompt(current, swarmOf(current).source.files);
    const previousRevision = current.prompt?.revision ?? null;
    const changed = previousRevision !== assembled.received.revision;
    // Read only. A tool result is not a delivery Swarm can vouch for, so the seat's receipt stays
    // as it is, and the reconciler still sends a changed prompt ahead of the next mail.
    return {
      revision: assembled.received.revision,
      previousRevision,
      changed,
      prompt: refreshedPrompt({ pwa: assembled.pwa, agent: current, changed }),
    };
  });

  server.handle(
    appendHumanActivityRpc,
    async (input: RpcInput<typeof appendHumanActivityRpc>, context: PluginHandlerContext) => {
      const task = findTaskFor(input, input.taskId);
      const swarmId = swarmOf(task).id;
      const { cc, ...fields } = input;
      let result!: ReturnType<typeof makeActivity>;
      await store.commit((state) => {
        result = makeActivity({ ...fields, swarmId, actorKind: "human" }, state);
        return [{ op: "put", collection: "activities", record: result }];
      });
      let owner: AgentRecord;
      try {
        owner = findAgent(swarmId, task.managerName);
      } catch (error) {
        return {
          ...result,
          notificationWarning: error instanceof Error ? error.message : String(error),
        };
      }
      const activity = result;
      const { message } = await sendWithCopies(
        {
          swarmId,
          recipient: owner,
          cc,
          sender: input.actorName,
          taskId: task.id,
          kind: "human_activity",
          body: activity.body,
          attributes: {
            kind: "human_activity",
            activity: activity.id,
            "activity-kind": activity.kind,
            "reply-to": activity.replyTo,
            "response-profile": activity.responseProfile,
          },
        },
        context,
      );
      if (message.deliveredAt || !message.lastError) return result;
      return { ...result, notificationWarning: message.lastError };
    },
  );

  // A Task id on a message is context for the reader. It never decides whether the message goes.
  server.handle(
    sendMessageRpc,
    async (input: RpcInput<typeof sendMessageRpc>, context: PluginHandlerContext) => {
      if (input.actorName && input.actorName !== input.senderName) {
        throw new Error(
          `Message sender ${input.senderName} does not match actor ${input.actorName}`,
        );
      }
      const swarm = actorSwarm(input, input.actorName ?? input.recipientName);
      const recipient = findAgent(swarm.id, input.recipientName);
      const recipientReference = agentQualifiedName(recipient);
      if (input.taskId) findTask(swarm.id, input.taskId);
      const { message, copies } = await sendWithCopies(
        {
          swarmId: swarm.id,
          recipient,
          cc: input.cc,
          sender: input.senderName,
          taskId: input.taskId,
          kind: "team",
          body: input.body,
        },
        context,
      );
      const status = mailboxMessageStatus(message);
      return {
        delivered: message.deliveredAt !== null,
        messageId: message.id,
        status,
        receipt: messageReceipt({
          recipient: recipientReference,
          messageId: message.id,
          status,
          error: message.lastError,
        }),
        cc: copies.map((copy) => ({
          recipient: copy.recipientName,
          messageId: copy.id,
          status: mailboxMessageStatus(copy),
        })),
      };
    },
  );

  server.handle(seatListRpc, async (input) => ({ seats: listSeats(input) }));
  // A seat with queued mail wakes on the flush, so a change takes effect without waiting for new
  // mail; the seats are read again so the reply shows any agent that replacement just bound.
  const afterFlush = async (seats: SeatView[], context: PluginHandlerContext) => {
    await flushMailbox(context);
    const ids = new Set(seats.map((seat) => seat.id));
    return listSeats({ includeRetired: true }).filter((seat) => ids.has(seat.id));
  };
  server.handle(seatUpdateRpc, async (input, context) => {
    const seats = await updateSeats(input, context);
    return { seats: input.dryRun ? seats : await afterFlush(seats, context) };
  });
  server.handle(seatResetRpc, async (input, context) => {
    const seats = await resetSeats(input, context);
    return { seats: input.dryRun ? seats : await afterFlush(seats, context) };
  });
  server.handle(seatRetireRpc, async (input, context) => {
    const seat = findSeat(input.swarmId, input.seat);
    const name = agentQualifiedName(seat);
    if (input.actorName) {
      const actor = findAgent(seat.swarmId!, input.actorName);
      if (actor.roleClass !== "planner" && seat.reportsTo !== agentQualifiedName(actor)) {
        throw new Error(`Agent ${agentQualifiedName(actor)} cannot retire seat ${name}`);
      }
    }
    await mutateSpec(seat.swarmId!, (state) => {
      const current = state.agents.find((candidate) => candidate.id === seat.id);
      if (!current || current.retired) throw new Error(`Seat ${name} is already retired`);
      const team = state.agents.filter(
        (candidate) =>
          candidate.swarmId === seat.swarmId && !candidate.retired && candidate.reportsTo === name,
      );
      if (team.length > 0) {
        throw new Error(
          `Retire the seats that report to ${name} first: ${team.map(agentQualifiedName).join(", ")}`,
        );
      }
      return [{ kind: "retire", seat: current, reason: `Seat ${name} was retired` }];
    });
    // Delivers the handover of the seat's open Tasks to the seat above it.
    await flushMailbox(context).catch((error) => {
      console.warn("[paseo-swarm] Task handover mail stays queued", error);
    });
    return { seat: seatView(store.read().agents.find((candidate) => candidate.id === seat.id)!) };
  });
  server.handle(seatHistoryReadRpc, async (input, context) => readSeatHistory(input, context));

  server.handle(mailboxReadRpc, async (input: RpcInput<typeof mailboxReadRpc>, context) => {
    await flushMailbox(context);
    const inSwarm = input.swarmId
      ? new Set(swarmSeats(input.swarmId, true).map((seat) => seat.id))
      : null;
    const messages = [];
    for (const message of store.read().messages.toReversed()) {
      if (messages.length === input.limit) break;
      if (inSwarm && !inSwarm.has(message.recipientAgentId)) continue;
      const status = mailboxMessageStatus(message);
      if (input.recipientName && message.recipientName !== input.recipientName) continue;
      if (input.senderName && message.senderName !== input.senderName) continue;
      if (input.status && status !== input.status) continue;
      messages.push(Object.assign({ status }, message));
    }
    return { messages };
  });
}

// The Task a child was last working on: the Task of the last Task-scoped message it received.
function lastAssignedTask(agent: AgentRecord): string | null {
  const messages = store.read().messages;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.recipientAgentId === agent.id && message.taskId) return message.taskId;
  }
  return null;
}

export async function notifyManager(
  agent: { id: string },
  turn: TurnSummary,
  context: PluginHandlerContext,
): Promise<void> {
  const managed = store.read().agents.find((candidate) => candidate.paseoAgentId === agent.id);
  if (!managed?.reportsTo) return;
  const manager = findAgent(swarmOf(managed).id, managed.reportsTo);
  const taskId = lastAssignedTask(managed);
  await sendThroughMailbox(
    {
      recipientAgentId: manager.id,
      recipientName: agentQualifiedName(manager),
      senderName: agentQualifiedName(managed),
      taskId,
      kind: "runtime",
      render: () =>
        turnDigestRow({
          agent: agentQualifiedName(managed),
          occupant: currentOccupant(managed).number,
          taskId,
          ...turn,
        }),
    },
    context,
  );
}

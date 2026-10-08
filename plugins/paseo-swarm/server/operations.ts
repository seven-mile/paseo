import type { RpcInput } from "@getpaseo/plugin";
import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { listPwaRoles, readPwa } from "./pwa";
import { initialPrompt, messagePrompt, messageReceipt, runtimeNotification } from "./prompts";
import { store } from "./state";
import { readPwaSource, requirePwaSource, writePwaSource } from "./source";
import { resolveActivityRefs } from "./refs";
import {
  appendActivityRpc,
  appendHumanActivityRpc,
  boardReadRpc,
  createAgentRpc,
  createTaskRpc,
  registerAgentRpc,
  sendMessageRpc,
  updateTaskRpc,
  pwaSourceReadRpc,
  pwaSourceSetRpc,
  pwaRolesReadRpc,
  prepareAgentRpc,
  bindPreparedAgentRpc,
} from "../shared/swarm";
import type { AgentRecord, Task } from "../shared/models";
import { agentQualifiedName } from "../shared/models";

const now = () => new Date().toISOString();
const id = (prefix: string) => `${prefix}-${randomUUID()}`;

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
  const parentSnapshot = input.parent
    ? (await context.paseo.agents.ref(input.parent.paseoAgentId).refresh())?.agent
    : null;
  if (input.parent && !parentSnapshot)
    throw new Error(`Unknown manager agent: ${input.parent.paseoAgentId}`);
  const workspaceIds = new Set([parentSnapshot?.workspaceId, input.workspaceId]);
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

function findAgent(reference: string, scopeName?: string): AgentRecord {
  const agents = store.read().agents.filter((candidate) => !candidate.retired);
  const qualified = agents.filter((candidate) => agentQualifiedName(candidate) === reference);
  if (qualified.length === 1) return qualified[0];

  if (scopeName) {
    const children = agents.filter((candidate) => candidate.reportsTo === scopeName);
    const scoped = children.filter(
      (candidate) => candidate.name === reference || candidate.aliases.includes(reference),
    );
    if (scoped.length === 1) return scoped[0];
  }

  const local = agents.filter(
    (candidate) => candidate.name === reference || candidate.aliases.includes(reference),
  );
  if (local.length === 1) return local[0];
  if (local.length > 1) throw new Error(`Ambiguous agent reference: ${reference}`);
  throw new Error(`Unknown active agent: ${reference}`);
}

function findAgentByPaseoId(paseoAgentId: string): AgentRecord | undefined {
  return store
    .read()
    .agents.find((candidate) => candidate.paseoAgentId === paseoAgentId && !candidate.retired);
}

function resolveTaskWorkers(workerNames: string[], manager: AgentRecord): string[] {
  return workerNames.map((workerName) => {
    const worker = findAgent(workerName, agentQualifiedName(manager));
    if (worker.roleClass !== "worker") {
      throw new Error(`Task worker must have role class worker: ${worker.name}`);
    }
    return agentQualifiedName(worker);
  });
}

function ensureUniqueName(
  name: string,
  qualifiedName: string,
  parent: AgentRecord | null,
  exceptPaseoAgentId?: string,
): void {
  const agents = store.read().agents;
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

function parentForCreate(input: { actorPaseoAgentId: string | null; reportsTo: string | null }): {
  actor: AgentRecord | null;
  parent: AgentRecord | null;
} {
  const actor = input.actorPaseoAgentId
    ? (findAgentByPaseoId(input.actorPaseoAgentId) ?? null)
    : null;
  if (input.actorPaseoAgentId && !actor) {
    throw new Error(`Unknown active Paseo actor: ${input.actorPaseoAgentId}`);
  }
  const parent = input.reportsTo
    ? findAgent(input.reportsTo, actor ? agentQualifiedName(actor) : undefined)
    : actor;
  return { actor, parent };
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
  if (actor.roleClass === "supervisor" && parent?.paseoAgentId !== actor.paseoAgentId) {
    throw new Error(
      `Agent ${actor.name} cannot create under ${parent ? agentQualifiedName(parent) : "no parent"}`,
    );
  }
}

function findTask(taskId: string): Task {
  const value = store.read().tasks.find((candidate) => candidate.id === taskId);
  if (!value) throw new Error(`Unknown Task: ${taskId}`);
  return value;
}

function rolePrompt(
  agent: Pick<AgentRecord, "name" | "qualifiedName" | "roleClass" | "role" | "reportsTo">,
  brief: string,
  projectId?: string,
): string {
  const pwa = readPwa(requirePwaSource(projectId), agent.role);
  assertRoleClass(pwa.roleClass, agent.roleClass, agent.role);
  return initialPrompt({ pwa, agent, brief });
}

function assertRoleClass(
  pwaRoleClass: AgentRecord["roleClass"],
  agentRoleClass: AgentRecord["roleClass"],
  role: string,
): void {
  if (pwaRoleClass !== agentRoleClass) {
    throw new Error(`Role ${role} belongs to role class ${pwaRoleClass}, not ${agentRoleClass}`);
  }
}

async function assertCreationWorkspace(
  actor: AgentRecord | null,
  workspaceId: string | null,
  context: PluginHandlerContext,
): Promise<void> {
  if (actor) {
    if (!workspaceId) throw new Error(`Caller has no workspace: ${actor.paseoAgentId}`);
    const allowedIds = new Set(
      store
        .read()
        .agents.filter(
          (candidate) =>
            !candidate.retired &&
            (candidate.paseoAgentId === actor.paseoAgentId ||
              candidate.reportsTo === agentQualifiedName(actor)),
        )
        .map((candidate) => candidate.paseoAgentId),
    );
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

function creationConfig(
  input: RpcInput<typeof createAgentRpc>,
  provisional: Parameters<typeof rolePrompt>[0],
  parent: AgentRecord | null,
  projectId: string | undefined,
) {
  return {
    config: {
      provider: input.provider,
      ...(input.modeId ? { modeId: input.modeId } : {}),
      ...(input.thinkingOptionId ? { thinkingOptionId: input.thinkingOptionId } : {}),
      ...(input.featureValues ? { featureValues: input.featureValues } : {}),
      systemPrompt: rolePrompt(provisional, input.brief, projectId),
    },
    title: input.title ?? input.name,
    ...(parent ? { parent: parent.paseoAgentId } : {}),
  };
}

async function creationPlacement(
  input: RpcInput<typeof createAgentRpc>,
  actor: AgentRecord | null,
  parent: AgentRecord | null,
  projectId: string | undefined,
  context: PluginHandlerContext,
) {
  const workspaceAgentId = actor?.paseoAgentId ?? parent?.paseoAgentId ?? null;
  const workspaceAgent = workspaceAgentId ? context.paseo.agents.ref(workspaceAgentId) : null;
  const parentSnapshot = workspaceAgent ? (await workspaceAgent.refresh())?.agent : null;
  const workspaceId = input.workspaceId ?? parentSnapshot?.workspaceId ?? null;
  await assertCreationWorkspace(actor, workspaceId, context);
  const cwd =
    parentSnapshot?.cwd ?? (projectId ? await projectRoot(projectId, context) : process.cwd());
  return { workspaceId, cwd };
}

export function registerOperations(server: Pick<PluginServerContext, "handle">): void {
  server.handle(boardReadRpc, async ({ projectId }, context) => {
    const availableIds = new Set((await availableAgents(context)).map((agent) => agent.id));
    const saved = store.read();
    const board = {
      ...saved,
      agents: saved.agents.filter((agent) => availableIds.has(agent.paseoAgentId)),
    };
    if (!projectId) return board;
    await projectRoot(projectId, context);
    const directory = readPwaSource(projectId);
    if (!directory) return { ...board, statuses: [] };
    const planner = listPwaRoles(directory).find((role) => role.roleClass === "planner");
    if (!planner) throw new Error(`The PWA directory must contain a planner role: ${directory}`);
    return { ...board, statuses: readPwa(directory, planner.role).statuses };
  });
  server.handle(pwaSourceReadRpc, async ({ projectId }, context) => {
    if (projectId) await projectRoot(projectId, context);
    return { path: readPwaSource(projectId) };
  });
  server.handle(pwaSourceSetRpc, async ({ path, projectId }, context) => {
    const root = projectId ? await projectRoot(projectId, context) : undefined;
    return { path: writePwaSource({ path, projectId, projectRoot: root }) };
  });
  server.handle(pwaRolesReadRpc, async ({ roleClass, path, projectId }, context) => {
    const root = projectId ? await projectRoot(projectId, context) : process.cwd();
    const directory = path ? resolve(root, path) : requirePwaSource(projectId);
    const roles = listPwaRoles(directory);
    for (const role of roles) readPwa(directory, role.role);
    return roles.filter((role) => !roleClass || role.roleClass === roleClass);
  });

  server.handle(registerAgentRpc, async (input: RpcInput<typeof registerAgentRpc>, context) => {
    const parent = input.reportsTo ? findAgent(input.reportsTo) : null;
    const snapshot = (await context.paseo.agents.ref(input.paseoAgentId).refresh())?.agent;
    if (!snapshot?.workspaceId) throw new Error(`Unknown agent workspace: ${input.paseoAgentId}`);
    if (input.workspaceId && input.workspaceId !== snapshot.workspaceId)
      throw new Error("Agent workspace does not match registration.");
    const projectId = await projectScope(
      { ...input, workspaceId: snapshot.workspaceId, parent },
      context,
    );
    assertRoleClass(
      readPwa(requirePwaSource(projectId), input.role).roleClass,
      input.roleClass,
      input.role,
    );
    const timestamp = now();
    let result!: AgentRecord;
    await store.update((state) => {
      const existing = state.agents.find((agent) => agent.paseoAgentId === input.paseoAgentId);
      const qualifiedName = parent ? `${agentQualifiedName(parent)}.${input.name}` : input.name;
      if (!existing) ensureUniqueName(input.name, qualifiedName, parent);
      if (
        existing &&
        (existing.name !== input.name ||
          existing.roleClass !== input.roleClass ||
          existing.role !== input.role ||
          agentQualifiedName(existing) !== qualifiedName)
      ) {
        throw new Error(`Agent identity and hierarchy are immutable: ${input.paseoAgentId}`);
      }
      result = existing ?? {
        id: id("agent"),
        paseoAgentId: input.paseoAgentId,
        name: input.name,
        qualifiedName,
        aliases: input.aliases,
        roleClass: input.roleClass,
        role: input.role,
        reportsTo: parent ? agentQualifiedName(parent) : null,
        workspaceId: snapshot.workspaceId ?? null,
        projectId,
        retired: false,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      if (existing)
        Object.assign(existing, {
          ...input,
          workspaceId: snapshot.workspaceId,
          projectId,
          qualifiedName,
          reportsTo: parent ? agentQualifiedName(parent) : null,
          retired: false,
          updatedAt: timestamp,
        });
      else state.agents.push(result);
    });
    return result;
  });

  server.handle(
    createAgentRpc,
    async (input: RpcInput<typeof createAgentRpc>, context: PluginHandlerContext) => {
      const { actor, parent } = parentForCreate(input);
      assertCanCreateAgent(actor, parent, input.roleClass);
      const projectId = await projectScope({ ...input, parent }, context);
      const qualifiedName = parent ? `${agentQualifiedName(parent)}.${input.name}` : input.name;
      ensureUniqueName(input.name, qualifiedName, parent);
      const { workspaceId, cwd } = await creationPlacement(
        input,
        actor,
        parent,
        projectId,
        context,
      );
      const provisional = {
        name: input.name,
        qualifiedName,
        roleClass: input.roleClass,
        role: input.role,
        reportsTo: parent ? agentQualifiedName(parent) : null,
      } as const;
      const paseoAgentId = randomUUID();
      const timestamp = now();
      const reservedAgent: AgentRecord = {
        id: id("agent"),
        paseoAgentId,
        name: input.name,
        qualifiedName,
        aliases: input.aliases,
        roleClass: input.roleClass,
        role: input.role,
        reportsTo: parent ? agentQualifiedName(parent) : null,
        workspaceId,
        projectId,
        retired: false,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const createConfig = creationConfig(input, provisional, parent, projectId);
      await store.update((state) => {
        state.agents.push(reservedAgent);
      });
      let created;
      try {
        let workspace = workspaceId ? context.paseo.workspaces.ref(workspaceId) : null;
        if (!workspace && (input.roleClass === "supervisor" || (!parent && projectId))) {
          workspace = await context.paseo.workspaces.create({
            source: { kind: "directory", path: cwd, ...(projectId ? { projectId } : {}) },
            title: input.title ?? input.name,
          });
        }
        created = workspace
          ? await workspace.agents.create({
              ...createConfig,
              agentId: paseoAgentId,
            })
          : await context.paseo.agents.create({
              ...createConfig,
              agentId: paseoAgentId,
              cwd,
            });
      } catch (error) {
        await store.update((state) => {
          state.agents = state.agents.filter((agent) => agent.paseoAgentId !== paseoAgentId);
        });
        throw error;
      }
      const snapshot = (await created.refresh())?.agent;
      let result = reservedAgent;
      await store.update((state) => {
        const current = state.agents.find((agent) => agent.paseoAgentId === paseoAgentId);
        if (!current) throw new Error(`Reserved Swarm agent disappeared: ${paseoAgentId}`);
        current.workspaceId = snapshot?.workspaceId ?? current.workspaceId;
        current.updatedAt = now();
        result = current;
      });
      await created.send(input.brief);
      return result;
    },
  );

  server.handle(prepareAgentRpc, async (input: RpcInput<typeof prepareAgentRpc>, context) => {
    const { actor, parent } = parentForCreate(input);
    assertCanCreateAgent(actor, parent, input.roleClass);
    const projectId = await projectScope({ ...input, parent }, context);
    const qualifiedName = parent ? `${agentQualifiedName(parent)}.${input.name}` : input.name;
    ensureUniqueName(input.name, qualifiedName, parent);
    const provisional = {
      name: input.name,
      qualifiedName,
      roleClass: input.roleClass,
      role: input.role,
      reportsTo: parent ? agentQualifiedName(parent) : null,
    } as const;
    const timestamp = now();
    const agent: AgentRecord = {
      id: id("agent"),
      paseoAgentId: randomUUID(),
      name: input.name,
      qualifiedName,
      aliases: input.aliases,
      roleClass: input.roleClass,
      role: input.role,
      reportsTo: parent ? agentQualifiedName(parent) : null,
      workspaceId: null,
      projectId,
      retired: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const systemPrompt = rolePrompt(provisional, input.brief, projectId);
    await store.update((state) => {
      state.agents.push(agent);
    });
    return { agentId: agent.paseoAgentId, systemPrompt, agent };
  });

  server.handle(
    bindPreparedAgentRpc,
    async (input: RpcInput<typeof bindPreparedAgentRpc>, context) => {
      const prepared = store
        .read()
        .agents.find((candidate) => candidate.paseoAgentId === input.agentId && !candidate.retired);
      if (!prepared) throw new Error(`Unknown prepared agent: ${input.agentId}`);
      const snapshot = (await context.paseo.agents.ref(input.agentId).refresh())?.agent;
      if (!snapshot || snapshot.workspaceId !== input.workspaceId)
        throw new Error("Agent workspace does not match binding.");
      const parent = prepared.reportsTo ? findAgent(prepared.reportsTo) : null;
      const projectId = await projectScope(
        { projectId: prepared.projectId, workspaceId: input.workspaceId, parent },
        context,
      );
      if (!prepared.projectId && projectId && readPwaSource(projectId) !== readPwaSource()) {
        throw new Error(
          "Prepare this agent with the selected project before binding its PWA directory.",
        );
      }
      let result!: AgentRecord;
      await store.update((state) => {
        const agent = state.agents.find(
          (candidate) => candidate.paseoAgentId === input.agentId && !candidate.retired,
        );
        if (!agent) throw new Error(`Unknown prepared agent: ${input.agentId}`);
        agent.workspaceId = input.workspaceId;
        agent.projectId = projectId;
        agent.updatedAt = now();
        result = agent;
      });
      return result;
    },
  );

  server.handle(createTaskRpc, async (input: RpcInput<typeof createTaskRpc>) => {
    const actor = findAgent(input.createdBy);
    const manager = findAgent(input.managerName, agentQualifiedName(actor));
    if (actor.roleClass === "worker") {
      throw new Error(`Worker ${actor.name} cannot create a Task`);
    }
    if (
      actor.roleClass !== "planner" &&
      agentQualifiedName(actor) !== agentQualifiedName(manager)
    ) {
      throw new Error(`Agent ${actor.name} cannot create a Task for ${input.managerName}`);
    }
    const workerNames = resolveTaskWorkers(input.workerNames, manager);
    let result!: Task;
    const timestamp = now();
    await store.update((state) => {
      if (state.tasks.some((task) => task.id === input.id)) {
        throw new Error(`Task id already exists: ${input.id}`);
      }
      result = {
        ...input,
        managerName: agentQualifiedName(manager),
        workerNames,
        createdBy: agentQualifiedName(actor),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      state.tasks.push(result);
    });
    return result;
  });

  server.handle(updateTaskRpc, async (input: RpcInput<typeof updateTaskRpc>) => {
    const currentTask = findTask(input.taskId);
    const actor = findAgent(input.actorName);
    if (
      actor.roleClass === "worker" ||
      (actor.roleClass !== "planner" &&
        currentTask.managerName !== agentQualifiedName(actor) &&
        currentTask.createdBy !== agentQualifiedName(actor))
    ) {
      throw new Error(`Agent ${input.actorName} cannot update Task ${input.taskId}`);
    }
    const manager = findAgent(currentTask.managerName);
    const workerNames =
      input.workerNames === undefined ? undefined : resolveTaskWorkers(input.workerNames, manager);
    let result!: Task;
    await store.update((state) => {
      const value = state.tasks.find((candidate) => candidate.id === input.taskId);
      if (!value) throw new Error(`Unknown Task: ${input.taskId}`);
      Object.assign(value, {
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.brief === undefined ? {} : { brief: input.brief }),
        ...(workerNames === undefined ? {} : { workerNames }),
        ...(input.data === undefined ? {} : { data: input.data }),
        updatedAt: now(),
      });
      result = value;
    });
    return result;
  });

  server.handle(appendActivityRpc, async (input: RpcInput<typeof appendActivityRpc>) => {
    const currentTask = findTask(input.taskId);
    const actor = findAgent(input.actorName);
    const actorReference = agentQualifiedName(actor);
    if (actor.roleClass === "worker") {
      throw new Error(`Worker ${input.actorName} cannot append Activity`);
    }
    if (currentTask.managerName !== actorReference && actor.roleClass !== "planner") {
      throw new Error(`Agent ${input.actorName} cannot append Activity to Task ${input.taskId}`);
    }
    let result!: ReturnType<typeof makeActivity>;
    await store.update((state) => {
      result = makeActivity({ ...input, actorKind: "agent" }, state);
      state.activities.push(result);
    });
    return result;
  });

  server.handle(
    appendHumanActivityRpc,
    async (input: RpcInput<typeof appendHumanActivityRpc>, context: PluginHandlerContext) => {
      const task = findTask(input.taskId);
      let result!: ReturnType<typeof makeActivity>;
      await store.update((state) => {
        result = makeActivity({ ...input, actorKind: "human" }, state);
        state.activities.push(result);
      });
      try {
        const manager = findAgent(task.managerName);
        await context.paseo.agents.ref(manager.paseoAgentId).send(
          messagePrompt({
            sender: input.actorName,
            recipient: agentQualifiedName(manager),
            message: [
              `A human added Activity ${result.id} to Task ${task.id}.`,
              `Kind: ${result.kind}.`,
              result.replyTo ? `Reply to: ${result.replyTo}.` : "",
              result.responseProfile ? `Response profile: ${result.responseProfile}.` : "",
              result.body,
            ]
              .filter(Boolean)
              .join("\n"),
            taskId: task.id,
          }),
          { activeTurnBehavior: "steer" },
        );
      } catch (error) {
        return {
          ...result,
          notificationWarning: error instanceof Error ? error.message : String(error),
        };
      }
      return result;
    },
  );

  server.handle(
    sendMessageRpc,
    async (input: RpcInput<typeof sendMessageRpc>, context: PluginHandlerContext) => {
      if (input.actorName && input.actorName !== input.senderName) {
        throw new Error(
          `Message sender ${input.senderName} does not match actor ${input.actorName}`,
        );
      }
      if (input.taskId) {
        const task = findTask(input.taskId);
        const actor = input.actorName ? findAgent(input.actorName) : null;
        if (!actor) throw new Error("Task-scoped messages require an authenticated agent");
        const actorReference = agentQualifiedName(actor);
        const recipientIsWorker = task.workerNames.includes(input.recipientName);
        const actorCanSend =
          actor.roleClass === "planner" ||
          task.managerName === actorReference ||
          task.workerNames.includes(actorReference);
        if (!actorCanSend || (!recipientIsWorker && input.recipientName !== task.managerName)) {
          throw new Error(`Agent ${actorReference} cannot send a message for Task ${task.id}`);
        }
      }
      await context.paseo.agents.ref(input.recipientPaseoAgentId).send(
        messagePrompt({
          sender: input.senderName,
          recipient: input.recipientName,
          message: input.body,
          taskId: input.taskId,
        }),
        { activeTurnBehavior: "steer" },
      );
      return {
        delivered: true as const,
        receipt: messageReceipt({
          recipient: input.recipientName,
          delivery: "accepted by Paseo for delivery",
        }),
      };
    },
  );
}

function makeActivity(
  input: {
    taskId: string;
    actorName: string;
    actorKind: "agent" | "human";
    replyTo: string | null;
    responseProfile: "decision" | "steering" | "discussion" | null;
    kind: string;
    body: string;
    data: Record<string, unknown>;
  },
  state: import("../shared/models").SwarmState,
) {
  return {
    id: id("activity"),
    taskId: input.taskId,
    actorName: input.actorName,
    actorKind: input.actorKind,
    replyTo: input.replyTo,
    responseProfile: input.responseProfile,
    kind: input.kind,
    body: input.body,
    data: input.data,
    refs: resolveActivityRefs(input.body, state),
    createdAt: now(),
  };
}

export async function notifyManager(
  agent: { id: string },
  status: "completed" | "canceled" | "failed",
  outcome: string,
  report: string | undefined,
  context: PluginHandlerContext,
): Promise<void> {
  const managed = store.read().agents.find((candidate) => candidate.paseoAgentId === agent.id);
  if (!managed?.reportsTo) return;
  const manager = findAgent(managed.reportsTo);
  await context.paseo.agents.ref(manager.paseoAgentId).send(
    runtimeNotification({
      agent: managed.name,
      manager: manager.name,
      status,
      outcome,
      report,
    }),
    { activeTurnBehavior: "steer" },
  );
}

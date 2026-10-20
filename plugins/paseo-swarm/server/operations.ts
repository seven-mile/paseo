import type { RpcInput } from "@getpaseo/plugin";
import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { discoverPwas, listPwaRoles, readPwa, readPwaStatuses } from "./pwa";
import { initialPrompt, messagePrompt, messageReceipt, runtimeNotification } from "./prompts";
import { store } from "./state";
import {
  readPwaSourceConfig,
  resolvePwaBinding,
  resolveLegacyPwaBinding,
  validatePwaBinding,
  writePwaSource,
} from "./source";
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
  resolveAgentConfigRpc,
  bindPreparedAgentRpc,
} from "../shared/swarm";
import type { AgentRecord, PwaBinding, SwarmState, Task } from "../shared/models";
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

function assertNativeParent(
  labels: Record<string, string> | undefined,
  parent: AgentRecord | null,
) {
  const parentId = labels?.["paseo.parent-agent-id"] ?? null;
  if (parentId !== (parent?.paseoAgentId ?? null)) {
    throw new Error("Agent parent does not match its Swarm reporting relationship.");
  }
}

function assertHierarchy(parent: AgentRecord | null, roleClass: AgentRecord["roleClass"]) {
  const requiredParent = { planner: null, supervisor: "planner", worker: "supervisor" }[roleClass];
  if ((parent?.roleClass ?? null) !== requiredParent)
    throw new Error("Choose a manager with the required role class.");
}

function assertParentBinding(
  parent: AgentRecord | null,
  binding: PwaBinding,
  effective?: PwaBinding,
) {
  if (!parent) return;
  const current =
    parent.pwaBinding ?? teamRoot(parent, store.read().agents)?.pwaBinding ?? effective;
  if (!current && binding.directory === binding.contentRoot) {
    // The async creation/bind boundary has resolved the current legacy root already.
    validatePwaBinding(binding);
    return;
  }
  if (
    !current ||
    current.projectId !== binding.projectId ||
    current.contentRoot !== binding.contentRoot ||
    current.directory !== binding.directory
  ) {
    throw new Error(
      "The manager's PWA binding changed after preparation. Existing team sources cannot be rebound; create a new team with the intended PWA.",
    );
  }
}

function assertCurrentParentBinding(
  state: SwarmState,
  parent: AgentRecord | null,
  binding: PwaBinding,
) {
  if (!parent) return;
  const current = state.agents.find(
    (agent) => agent.paseoAgentId === parent.paseoAgentId && !agent.retired,
  );
  if (!current)
    throw new Error(
      "The manager is no longer available. Choose an available manager or create a new team.",
    );
  assertParentBinding(current, binding);
}

function sameBinding(left: PwaBinding | undefined, right: PwaBinding | undefined) {
  return (
    left?.projectId === right?.projectId &&
    left?.contentRoot === right?.contentRoot &&
    left?.directory === right?.directory
  );
}

async function registrationBinding(
  input: RpcInput<typeof registerAgentRpc>,
  current: AgentRecord | undefined,
  parent: AgentRecord | null,
  projectId: string | undefined,
  context: PluginHandlerContext,
) {
  if (current && input.pwaBinding && !sameBinding(current.pwaBinding, input.pwaBinding))
    throw new Error(
      "An existing agent cannot be rebound to another PWA. Create a new team with the intended source.",
    );
  // A captured source stays valid if Project Settings changes while native creation is in flight.
  const binding = current
    ? current.pwaBinding
    : (input.pwaBinding ?? (await creationBinding(projectId, parent, input.pwaDirectory, context)));
  if (input.pwaDirectory && binding) {
    const selected = resolvePwaBinding({
      projectId,
      directory: input.pwaDirectory,
      contentRoot: binding.contentRoot,
    });
    if (selected.directory !== binding.directory)
      throw new Error(
        "An existing agent cannot be rebound to another PWA. Create a new team with the intended source.",
      );
  }
  if (current && input.pwaDirectory && !binding)
    throw new Error(
      "This agent has no saved PWA source. Restore its configured root PWA or create a new team with an explicit PWA.",
    );
  if (binding && binding.projectId !== projectId)
    throw new Error("Agent binding belongs to another project.");
  if (!current && binding) {
    validatePwaBinding(binding);
    assertRoleClass(
      readPwa(binding.directory, input.role, binding.contentRoot).roleClass,
      input.roleClass,
      input.role,
    );
  }
  return binding;
}

function findTask(taskId: string): Task {
  const value = store.read().tasks.find((candidate) => candidate.id === taskId);
  if (!value) throw new Error(`Unknown Task: ${taskId}`);
  return value;
}

function rolePrompt(
  agent: Pick<AgentRecord, "name" | "qualifiedName" | "roleClass" | "role" | "reportsTo">,
  brief: string,
  binding: PwaBinding,
): string {
  validatePwaBinding(binding);
  const pwa = readPwa(binding.directory, agent.role, binding.contentRoot);
  assertRoleClass(pwa.roleClass, agent.roleClass, agent.role);
  return initialPrompt({ pwa, agent, brief });
}

async function sourceConfig(projectId: string | undefined, context: PluginHandlerContext) {
  return readPwaSourceConfig(
    projectId,
    projectId ? await projectRoot(projectId, context) : undefined,
  );
}

async function effectiveBinding(
  agent: AgentRecord,
  projectId: string | undefined,
  context: PluginHandlerContext,
): Promise<PwaBinding> {
  const root = teamRoot(agent, store.read().agents);
  const binding = agent.pwaBinding ?? root?.pwaBinding;
  if (binding) return validatePwaBinding(binding);
  return resolveLegacyPwaBinding(
    projectId,
    projectId ? await projectRoot(projectId, context) : undefined,
  );
}

async function creationBinding(
  projectId: string | undefined,
  parent: AgentRecord | null,
  directory: string | undefined,
  context: PluginHandlerContext,
): Promise<PwaBinding> {
  if (parent) {
    let binding: PwaBinding;
    try {
      binding = await effectiveBinding(parent, projectId, context);
    } catch (error) {
      throw new Error(
        "The manager's PWA source is unavailable. Restore its configured root PWA or create a new team with an explicit PWA.",
        {
          cause: error,
        },
      );
    }
    if (binding.projectId !== projectId)
      throw new Error("The manager's PWA binding belongs to another project.");
    validatePwaBinding(binding);
    if (directory) {
      const selected = resolvePwaBinding({
        projectId,
        directory,
        contentRoot: binding.contentRoot,
      });
      if (selected.directory !== binding.directory)
        throw new Error("Children inherit their manager's PWA directory.");
    }
    return { ...binding };
  }
  if (!directory) {
    try {
      return resolveLegacyPwaBinding(
        projectId,
        projectId ? await projectRoot(projectId, context) : undefined,
      );
    } catch (error) {
      throw new Error("Choose a PWA directory explicitly.", { cause: error });
    }
  }
  const config = await sourceConfig(projectId, context);
  if (!config.path)
    throw new Error("No PWA content directory configured. Choose one in Project Settings → Swarm.");
  return resolvePwaBinding({ projectId, directory, contentRoot: config.path });
}

function teamRoot(agent: AgentRecord, agents: AgentRecord[]): AgentRecord | undefined {
  const visited = new Set<string>();
  let current: AgentRecord | undefined = agent;
  while (current && !visited.has(current.paseoAgentId)) {
    visited.add(current.paseoAgentId);
    if (current.roleClass === "planner" && !current.reportsTo) return current;
    current = agents.find((candidate) => agentQualifiedName(candidate) === current?.reportsTo);
  }
  return undefined;
}

function teamMembers(owner: AgentRecord, agents: AgentRecord[]): Set<string> {
  const members = new Set([agentQualifiedName(owner)]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const agent of agents) {
      const name = agentQualifiedName(agent);
      if (agent.reportsTo && members.has(agent.reportsTo) && !members.has(name)) {
        members.add(name);
        changed = true;
      }
    }
  }
  return members;
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
  ownAgentId?: string,
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
    if (ownAgentId) allowedIds.add(ownAgentId);
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
  binding: PwaBinding,
) {
  return {
    config: {
      provider: input.provider,
      ...(input.modeId ? { modeId: input.modeId } : {}),
      ...(input.thinkingOptionId ? { thinkingOptionId: input.thinkingOptionId } : {}),
      ...(input.featureValues ? { featureValues: input.featureValues } : {}),
      systemPrompt: rolePrompt(provisional, input.brief, binding),
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
  const workspaceAgentId = (actor ?? parent)?.paseoAgentId ?? null;
  const workspaceAgent = workspaceAgentId ? context.paseo.agents.ref(workspaceAgentId) : null;
  const parentSnapshot = workspaceAgent ? (await workspaceAgent.refresh())?.agent : null;
  if (
    input.roleClass === "supervisor" &&
    (actor ?? parent)?.roleClass === "planner" &&
    (!input.workspaceId || input.workspaceId === parentSnapshot?.workspaceId)
  ) {
    throw new Error("Prepare a separate workspace for the supervisor and pass its workspaceId.");
  }
  const workspaceId = input.workspaceId ?? parentSnapshot?.workspaceId ?? null;
  await assertCreationWorkspace(actor, workspaceId, context);
  const cwd =
    parentSnapshot?.cwd ?? (projectId ? await projectRoot(projectId, context) : process.cwd());
  return { workspaceId, cwd };
}

function configuredRootStatuses(directory: string): string[] {
  if (!statSync(directory).isDirectory())
    throw new Error(`Not a PWA content directory: ${directory}`);
  try {
    return readPwaStatuses(directory);
  } catch (error) {
    // A content parent need not contain a PWA; malformed present entries still report errors.
    if (
      !(
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT" &&
        "path" in error &&
        error.path === join(directory, "PWA.md")
      )
    )
      throw error;
    return [];
  }
}

async function projectBoardStatuses(projectId: string | undefined, context: PluginHandlerContext) {
  // Preserve the legacy configured-root workflow; team workflows are read only for team requests.
  try {
    const config = await sourceConfig(projectId, context);
    return { statuses: config.path ? configuredRootStatuses(config.path) : [] };
  } catch (error) {
    return { statuses: [], pwaError: error instanceof Error ? error.message : String(error) };
  }
}

function assertRegistrationAvailable(current: AgentRecord | undefined) {
  if (current && ((!current.workspaceId && current.pwaBinding) || current.creationError)) {
    throw new Error(
      "Finish the reserved agent through bind_workspace before registering it again.",
    );
  }
}

async function assertPreparedPwaCompatibility(
  prepared: AgentRecord,
  parent: AgentRecord | null,
  projectId: string | undefined,
  labels: Record<string, string> | undefined,
  context: PluginHandlerContext,
) {
  const preparedBinding = prepared.pwaBinding;
  if (
    (prepared.projectId !== undefined && prepared.projectId !== projectId) ||
    (preparedBinding && preparedBinding.projectId !== projectId)
  ) {
    throw new Error(
      "Prepare this agent with the selected project before binding its PWA directory.",
    );
  }
  // COMPAT(legacy-prepared-binding): added in v0.11.0-beta.4, remove after 2027-04-17
  // once the supported client floor includes parent labels and all older reservations settle.
  // Missing labels establish only the saved Swarm parent, not native ancestry.
  if (labels?.["paseo.parent-agent-id"] !== undefined) assertNativeParent(labels, parent);
  if (preparedBinding) {
    validatePwaBinding(preparedBinding);
  } else {
    // Old reservations also omitted PWA bindings; never infer one from the current source.
    if (
      !prepared.projectId &&
      projectId &&
      (await sourceConfig(projectId, context)).path !==
        (await sourceConfig(undefined, context)).path
    ) {
      throw new Error(
        "Prepare this agent with the selected project before binding its PWA directory.",
      );
    }
  }
}

export function registerOperations(server: Pick<PluginServerContext, "handle">): void {
  server.handle(boardReadRpc, async ({ projectId, teamName, unassigned }, context) => {
    const availableIds = new Set((await availableAgents(context)).map((agent) => agent.id));
    const saved = store.read();
    const agents = saved.agents.filter((agent) => !agent.retired);
    const visibleAgents = saved.agents.filter((agent) => availableIds.has(agent.paseoAgentId));
    if (projectId) await projectRoot(projectId, context);
    // Unscoped reads remain available for MCP identity and canonical Task references.
    if (!projectId && !teamName && !unassigned)
      return { ...saved, agents: visibleAgents, teamScopes: true };
    const memberships = new Map(agents.map((agent) => [agent.paseoAgentId, agent.projectId]));
    await Promise.all(
      agents
        .filter((agent) => !agent.projectId && agent.workspaceId)
        .map(async (agent) => {
          try {
            const workspace = await context.paseo.workspaces.ref(agent.workspaceId!).refresh();
            memberships.set(agent.paseoAgentId, workspace?.projectId);
          } catch {
            // Missing legacy placement stays explicitly unassigned; never infer from its name.
          }
        }),
    );
    const projectFor = (agent: AgentRecord) => memberships.get(agent.paseoAgentId);
    const orphaned = saved.tasks.filter((task) => {
      const manager = agents.find((agent) => agentQualifiedName(agent) === task.managerName);
      if (manager && projectFor(manager) && projectId && projectFor(manager) !== projectId)
        return false;
      const root = manager ? teamRoot(manager, agents) : undefined;
      return (
        !manager ||
        (projectId && !projectFor(manager)) ||
        !availableIds.has(manager.paseoAgentId) ||
        !root ||
        !availableIds.has(root.paseoAgentId)
      );
    });
    if (unassigned) {
      const ids = new Set(orphaned.map((task) => task.id));
      return {
        version: 1 as const,
        teamScopes: true,
        agents: visibleAgents.filter((agent) => !projectId || projectFor(agent) === projectId),
        tasks: orphaned,
        activities: saved.activities.filter((activity) => ids.has(activity.taskId)),
        statuses: [],
        unassignedTaskCount: orphaned.length,
      };
    }
    if (!teamName) {
      // Project reads retain full arrays for local filtering; scoped reads are explicit.
      return {
        ...saved,
        agents: visibleAgents,
        teamScopes: true,
        ...(await projectBoardStatuses(projectId, context)),
        unassignedTaskCount: orphaned.length,
      };
    }
    const owner = findAgent(teamName);
    if (owner.roleClass === "worker") throw new Error("Choose a planner or supervisor team.");
    if (projectId && projectFor(owner) !== projectId)
      throw new Error("The team belongs to another project.");
    const root = teamRoot(owner, agents);
    const members = teamMembers(owner, agents);
    const tasks = saved.tasks.filter((task) => members.has(task.managerName));
    const ids = new Set(tasks.map((task) => task.id));
    const board = {
      version: 1 as const,
      teamScopes: true,
      agents: visibleAgents.filter((agent) => members.has(agentQualifiedName(agent))),
      tasks,
      activities: saved.activities.filter((activity) => ids.has(activity.taskId)),
      unassignedTaskCount: orphaned.length,
    };
    try {
      if (!root) throw new Error("This team has no planner.");
      const binding = await effectiveBinding(root, projectId ?? projectFor(root), context);
      return {
        ...board,
        statuses: readPwaStatuses(binding.directory, binding.contentRoot),
      };
    } catch (error) {
      return {
        ...board,
        statuses: [],
        pwaError: error instanceof Error ? error.message : String(error),
      };
    }
  });
  server.handle(pwaSourceReadRpc, async ({ projectId, path }, context) => {
    const config = await sourceConfig(projectId, context);
    let previewPath = config.path;
    if (path !== undefined) {
      previewPath = resolve(
        projectId ? await projectRoot(projectId, context) : process.cwd(),
        path,
      );
      try {
        previewPath = realpathSync(previewPath);
      } catch {
        // Discovery returns the precise unreadable-root error, including for previews.
      }
    }
    return {
      path: previewPath,
      sourcePreview: true,
      agentConfigRead: true,
      ...(previewPath ? discoverPwas(previewPath) : { entries: [], complete: true, errors: [] }),
    };
  });
  server.handle(pwaSourceSetRpc, async ({ path, projectId }, context) => {
    const root = projectId ? await projectRoot(projectId, context) : undefined;
    const savedPath = writePwaSource({ path, projectId, projectRoot: root });
    return { path: savedPath };
  });
  server.handle(
    pwaRolesReadRpc,
    async ({ roleClass, path, projectId, parentName, actorPaseoAgentId }, context) => {
      const actor = actorPaseoAgentId ? findAgentByPaseoId(actorPaseoAgentId) : undefined;
      if (actorPaseoAgentId && !actor) throw new Error("Unknown active Swarm caller.");
      const parent = parentName
        ? findAgent(parentName, actor ? agentQualifiedName(actor) : undefined)
        : (actor ?? null);
      if (actor && roleClass) assertCanCreateAgent(actor, parent, roleClass);
      const scopedProject = await projectScope({ projectId, parent }, context);
      const binding = await creationBinding(scopedProject, parent, path, context);
      const roles = listPwaRoles(binding.directory, binding.contentRoot);
      return roles.filter((role) => !roleClass || role.roleClass === roleClass);
    },
  );
  server.handle(registerAgentRpc, async (input: RpcInput<typeof registerAgentRpc>, context) => {
    const parent = input.reportsTo ? findAgent(input.reportsTo) : null;
    const current = findAgentByPaseoId(input.paseoAgentId);
    assertRegistrationAvailable(current);
    if (!current) assertHierarchy(parent, input.roleClass);
    const snapshot = (await context.paseo.agents.ref(input.paseoAgentId).refresh())?.agent;
    if (!snapshot?.workspaceId) throw new Error(`Unknown agent workspace: ${input.paseoAgentId}`);
    if (input.workspaceId && input.workspaceId !== snapshot.workspaceId)
      throw new Error("Agent workspace does not match registration.");
    const projectId = await projectScope(
      { ...input, workspaceId: snapshot.workspaceId, parent },
      context,
    );
    const binding = await registrationBinding(input, current, parent, projectId, context);
    assertNativeParent(snapshot.labels, parent);
    if (!current) {
      await assertCreationWorkspace(parent, snapshot.workspaceId, context, input.paseoAgentId);
      const parentSnapshot = parent
        ? (await context.paseo.agents.ref(parent.paseoAgentId).refresh())?.agent
        : null;
      if (input.roleClass === "supervisor" && parentSnapshot?.workspaceId === snapshot.workspaceId)
        throw new Error(
          "Prepare a separate workspace for the supervisor and pass its workspaceId.",
        );
    }
    if (!current && binding)
      assertParentBinding(
        parent,
        binding,
        parent ? await effectiveBinding(parent, projectId, context) : undefined,
      );
    const timestamp = now();
    let result!: AgentRecord;
    await store.update((state) => {
      const existing = state.agents.find((agent) => agent.paseoAgentId === input.paseoAgentId);
      if (!current && binding) assertCurrentParentBinding(state, parent, binding);
      const qualifiedName = parent ? `${agentQualifiedName(parent)}.${input.name}` : input.name;
      if (!existing) ensureUniqueName(input.name, qualifiedName, parent);
      if (existing && !sameBinding(existing.pwaBinding, binding))
        throw new Error(
          "An existing agent cannot be rebound to another PWA. Create a new team with the intended source.",
        );
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
        pwaBinding: binding,
        retired: false,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      if (existing)
        Object.assign(existing, {
          aliases: input.aliases,
          workspaceId: snapshot.workspaceId,
          projectId,
          pwaBinding: binding,
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
      assertHierarchy(parent, input.roleClass);
      const projectId = await projectScope({ ...input, parent }, context);
      const binding = await creationBinding(projectId, parent, input.pwaDirectory, context);
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
        workspaceId: null,
        projectId,
        pwaBinding: binding,
        retired: false,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const createConfig = creationConfig(input, provisional, parent, binding);
      await store.update((state) => {
        assertCurrentParentBinding(state, parent, binding);
        ensureUniqueName(input.name, qualifiedName, parent);
        state.agents.push(reservedAgent);
      });
      let created;
      let canReleaseReservation = true;
      // CreationService owns existence/unknown-outcome detection; a failed refresh cannot prove absence.
      const onEvent: NonNullable<
        Parameters<PluginHandlerContext["paseo"]["agents"]["create"]>[0]["onEvent"]
      > = (snapshot) => {
        canReleaseReservation =
          snapshot.phase === "failed" &&
          snapshot.failedStage === "agent" &&
          snapshot.outcomeUnknown === false &&
          snapshot.agentId === paseoAgentId &&
          !snapshot.agent;
      };
      try {
        let workspace = workspaceId ? context.paseo.workspaces.ref(workspaceId) : null;
        // Supervisors already require an explicit independent workspace in creationPlacement.
        if (!workspace && !parent && projectId) {
          workspace = await context.paseo.workspaces.create({
            source: { kind: "directory", path: cwd, ...(projectId ? { projectId } : {}) },
            title: input.title ?? input.name,
          });
        }
        canReleaseReservation = false;
        created = workspace
          ? await workspace.agents.create({
              ...createConfig,
              onEvent,
              agentId: paseoAgentId,
            })
          : await context.paseo.agents.create({
              ...createConfig,
              onEvent,
              agentId: paseoAgentId,
              cwd,
            });
        const snapshot = (await created.refresh())?.agent;
        if (!snapshot?.workspaceId || (workspaceId && snapshot.workspaceId !== workspaceId))
          throw new Error("Created agent workspace does not match its placement.");
        assertNativeParent(snapshot.labels, parent);
        await projectScope({ projectId, workspaceId: snapshot.workspaceId, parent }, context);
        assertParentBinding(
          parent,
          binding,
          parent ? await effectiveBinding(parent, projectId, context) : undefined,
        );
        let result = reservedAgent;
        await store.update((state) => {
          assertCurrentParentBinding(state, parent, binding);
          const current = state.agents.find((agent) => agent.paseoAgentId === paseoAgentId);
          if (!current) throw new Error(`Reserved Swarm agent disappeared: ${paseoAgentId}`);
          current.workspaceId = snapshot?.workspaceId ?? current.workspaceId;
          current.updatedAt = now();
          result = current;
        });
        await created.send(input.brief);
        return result;
      } catch (error) {
        if (!created && canReleaseReservation) {
          await store.update((state) => {
            state.agents = state.agents.filter((agent) => agent.paseoAgentId !== paseoAgentId);
          });
          throw new Error(
            `Agent creation failed before a native agent was created. Name ${qualifiedName} is available for retry.`,
            { cause: error },
          );
        }
        await store.update((state) => {
          const reservation = state.agents.find((agent) => agent.paseoAgentId === paseoAgentId);
          if (reservation)
            reservation.creationError = error instanceof Error ? error.message : String(error);
        });
        throw new Error(
          `Agent creation failed. Reservation ${paseoAgentId} is retained for inspection; do not create a duplicate.`,
          { cause: error },
        );
      }
    },
  );

  server.handle(
    resolveAgentConfigRpc,
    async (input: RpcInput<typeof resolveAgentConfigRpc>, context) => {
      const { actor, parent } = parentForCreate(input);
      assertCanCreateAgent(actor, parent, input.roleClass);
      assertHierarchy(parent, input.roleClass);
      const projectId = await projectScope({ ...input, parent }, context);
      const pwaBinding = await creationBinding(projectId, parent, input.pwaDirectory, context);
      const qualifiedName = parent ? `${agentQualifiedName(parent)}.${input.name}` : input.name;
      ensureUniqueName(input.name, qualifiedName, parent);
      const systemPrompt = rolePrompt(
        {
          name: input.name,
          qualifiedName,
          roleClass: input.roleClass,
          role: input.role,
          reportsTo: parent ? agentQualifiedName(parent) : null,
        },
        input.brief,
        pwaBinding,
      );
      return {
        systemPrompt,
        parentAgentId: parent?.paseoAgentId ?? null,
        pwaBinding,
        ...(projectId ? { projectId } : {}),
      };
    },
  );

  server.handle(prepareAgentRpc, async (input: RpcInput<typeof prepareAgentRpc>, context) => {
    const { actor, parent } = parentForCreate(input);
    assertCanCreateAgent(actor, parent, input.roleClass);
    assertHierarchy(parent, input.roleClass);
    const projectId = await projectScope({ ...input, parent }, context);
    const binding = await creationBinding(projectId, parent, input.pwaDirectory, context);
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
      pwaBinding: binding,
      retired: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const systemPrompt = rolePrompt(provisional, input.brief, binding);
    await store.update((state) => {
      assertCurrentParentBinding(state, parent, binding);
      state.agents.push(agent);
    });
    return {
      agentId: agent.paseoAgentId,
      systemPrompt,
      parentAgentId: parent?.paseoAgentId ?? null,
      agent,
    };
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
      const preparedBinding = prepared.pwaBinding;
      await assertPreparedPwaCompatibility(prepared, parent, projectId, snapshot.labels, context);
      // Files may have changed since prepare. Never regenerate the prepared prompt here.
      const actor = parent;
      await assertCreationWorkspace(actor, input.workspaceId, context);
      if (prepared.roleClass === "supervisor" && parent?.roleClass === "planner") {
        const parentSnapshot = (await context.paseo.agents.ref(parent.paseoAgentId).refresh())
          ?.agent;
        if (parentSnapshot?.workspaceId === input.workspaceId)
          throw new Error(
            "Prepare a separate workspace for the supervisor and pass its workspaceId.",
          );
      }
      if (preparedBinding)
        assertParentBinding(
          parent,
          preparedBinding,
          parent ? await effectiveBinding(parent, projectId, context) : undefined,
        );
      let result!: AgentRecord;
      await store.update((state) => {
        if (preparedBinding) assertCurrentParentBinding(state, parent, preparedBinding);
        const agent = state.agents.find(
          (candidate) => candidate.paseoAgentId === input.agentId && !candidate.retired,
        );
        if (!agent) throw new Error(`Unknown prepared agent: ${input.agentId}`);
        agent.workspaceId = input.workspaceId;
        agent.projectId = projectId;
        delete agent.creationError;
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
      const recipient = findAgentByPaseoId(input.recipientPaseoAgentId);
      if (!recipient) {
        throw new Error(`Unknown active Swarm recipient: ${input.recipientPaseoAgentId}`);
      }
      const recipientReference = agentQualifiedName(recipient);
      if (recipientReference !== input.recipientName) {
        throw new Error(
          `Message recipient ${input.recipientName} does not match agent ${input.recipientPaseoAgentId}`,
        );
      }
      if (input.taskId) {
        const task = findTask(input.taskId);
        const actor = input.actorName ? findAgent(input.actorName) : null;
        if (!actor) throw new Error("Task-scoped messages require an authenticated agent");
        const actorReference = agentQualifiedName(actor);
        const recipientIsMember =
          task.managerName === recipientReference || task.workerNames.includes(recipientReference);
        const actorCanSend =
          actor.roleClass === "planner" ||
          task.managerName === actorReference ||
          task.workerNames.includes(actorReference);
        if (!actorCanSend || !recipientIsMember) {
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

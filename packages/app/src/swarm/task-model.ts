import { z } from "zod";

const responseProfileSchema = z.enum(["decision", "steering", "discussion"]);
export type SwarmResponseProfile = z.infer<typeof responseProfileSchema>;
export const responseProfiles: Array<{ value: SwarmResponseProfile; label: string }> = [
  { value: "decision", label: "Decision" },
  { value: "steering", label: "Steering" },
  { value: "discussion", label: "Discussion" },
];

const referenceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("agent"),
    paseoAgentId: z.string(),
    qualifiedName: z.string(),
    workspaceId: z.string().nullable(),
    uri: z.string().optional(),
    label: z.string().optional(),
  }),
  z.object({
    kind: z.literal("workspace"),
    workspaceId: z.string(),
    uri: z.string().optional(),
    label: z.string().optional(),
  }),
  z.object({
    kind: z.literal("task"),
    taskId: z.string(),
    workspaceId: z.string().optional(),
    uri: z.string().optional(),
    label: z.string().optional(),
  }),
  z.object({
    kind: z.literal("file"),
    workspaceId: z.string(),
    path: z.string(),
    uri: z.string().optional(),
    label: z.string().optional(),
  }),
]);
export type SwarmTaskReference = z.infer<typeof referenceSchema>;

const agentSchema = z.object({
  paseoAgentId: z.string(),
  name: z.string(),
  qualifiedName: z.string().optional(),
  aliases: z.array(z.string()).default([]),
  roleClass: z.enum(["planner", "supervisor", "worker"]),
  reportsTo: z.string().nullable(),
  workspaceId: z.string().nullable(),
  retired: z.boolean(),
});
const taskSchema = z.object({
  id: z.string(),
  title: z.string(),
  brief: z.string(),
  status: z.string(),
  managerName: z.string(),
  workerNames: z.array(z.string()),
  createdBy: z.string(),
  updatedAt: z.string(),
});
const activitySchema = z.object({
  id: z.string(),
  taskId: z.string(),
  actorName: z.string(),
  actorKind: z.enum(["agent", "human"]),
  replyTo: z.string().nullable(),
  responseProfile: responseProfileSchema.nullable(),
  kind: z.string(),
  body: z.string(),
  data: z.record(z.string(), z.unknown()),
  refs: z.array(referenceSchema),
  createdAt: z.string(),
});
export const swarmHumanActivityReceiptSchema = activitySchema.extend({
  notificationWarning: z.string().optional(),
});
export const swarmTaskBoardSchema = z.object({
  version: z.literal(1),
  statuses: z.array(z.string()).optional(),
  agents: z.array(agentSchema),
  tasks: z.array(taskSchema),
  activities: z.array(activitySchema),
});
export type SwarmTaskBoard = z.infer<typeof swarmTaskBoardSchema>;
export type SwarmTask = SwarmTaskBoard["tasks"][number];
export type SwarmActivity = SwarmTaskBoard["activities"][number];
export type SwarmTaskAgent = SwarmTaskBoard["agents"][number];

export function defaultSwarmTaskScope(
  board: SwarmTaskBoard,
  workspaceId: string,
  activeAgentId?: string,
) {
  const visited = new Set<string>();
  let active = board.agents.find((agent) => agent.paseoAgentId === activeAgentId);
  if (active?.workspaceId && active.workspaceId !== workspaceId) active = undefined;
  while (active && !visited.has(active.paseoAgentId)) {
    visited.add(active.paseoAgentId);
    if (!active.retired && active.roleClass !== "worker")
      return active.qualifiedName ?? active.name;
    active = active.reportsTo ? findSwarmTaskAgent(board.agents, active.reportsTo) : undefined;
  }
  const owners = board.agents.filter(
    (agent) => !agent.retired && agent.roleClass !== "worker" && agent.workspaceId === workspaceId,
  );
  return owners.length === 1 ? (owners[0].qualifiedName ?? owners[0].name) : "";
}

export function swarmTaskColumns(board: SwarmTaskBoard, tasks: readonly SwarmTask[]) {
  const declared = [...new Set(board.statuses ?? [])];
  const observed = [...new Set(tasks.map((task) => task.status))]
    .filter((status) => !declared.includes(status))
    .sort();
  return [...declared, ...observed].map((status) => ({
    status,
    tasks: tasks.filter((task) => task.status === status),
  }));
}

export function resolveSwarmTaskReference(
  uri: string,
  board: SwarmTaskBoard,
  workspaceIds: readonly string[],
): SwarmTaskReference | null {
  const match = /^paseo-swarm:\/\/(agent|workspace|task|file)\/([^?#]+)$/i.exec(uri);
  if (!match) return null;
  let segments: string[];
  try {
    segments = match[2].split("/").map(decodeURIComponent);
  } catch {
    return null;
  }
  if (segments.some((segment) => !segment)) return null;
  const kind = match[1].toLowerCase();
  if (kind === "agent" && segments.length === 1) {
    const agent = findSwarmTaskAgent(board.agents, segments[0]);
    if (!agent) return null;
    return {
      kind: "agent",
      paseoAgentId: agent.paseoAgentId,
      qualifiedName: agent.qualifiedName ?? agent.name,
      workspaceId: agent.workspaceId,
    };
  }
  if (kind === "task" && segments.length === 1) {
    const task = board.tasks.find((candidate) => candidate.id === segments[0]);
    if (!task) return null;
    const ownership = agentScope(board.agents, task.managerName, new Set(workspaceIds));
    if (ownership.workspaceId)
      return { kind: "task", taskId: task.id, workspaceId: ownership.workspaceId };
    return { kind: "task", taskId: task.id };
  }
  if (!workspaceIds.includes(segments[0])) return null;
  if (kind === "workspace" && segments.length === 1)
    return { kind: "workspace", workspaceId: segments[0] };
  if (kind !== "file" || segments.length < 2) return null;
  const path = segments.slice(1).join("/");
  if (!validReferencePath(path)) return null;
  return { kind: "file", workspaceId: segments[0], path };
}

function validReferencePath(path: string) {
  return (
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !/^[a-z]:/i.test(path) &&
    path.split("/").every((part) => part && part !== "." && part !== "..")
  );
}

const choiceSchema = z.object({
  type: z.literal("choice"),
  prompt: z.string(),
  options: z
    .array(z.object({ id: z.string(), label: z.string(), description: z.string().optional() }))
    .min(1),
  responseProfiles: z.array(responseProfileSchema).min(1).optional(),
});
export function activityChoice(activity: SwarmActivity) {
  const result = choiceSchema.safeParse(activity.data.action);
  return result.success ? result.data : null;
}

export function findSwarmTaskAgent(agents: readonly SwarmTaskAgent[], reference: string) {
  // A short name can be shared by separate teams; only an unambiguous lookup can navigate.
  const id = agents.find((agent) => agent.paseoAgentId === reference);
  if (id) return id;
  const exact = agents.find((agent) => agent.qualifiedName === reference);
  if (exact) return exact;
  const matches = agents.filter(
    (agent) => agent.name === reference || agent.aliases.includes(reference),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function agentScope(
  agents: readonly SwarmTaskAgent[],
  reference: string,
  knownWorkspaces: ReadonlySet<string>,
) {
  const agentIds = new Set<string>();
  let workspaceId: string | null = null;
  let agent = findSwarmTaskAgent(agents, reference);
  while (agent && !agentIds.has(agent.paseoAgentId)) {
    agentIds.add(agent.paseoAgentId);
    if (!workspaceId && agent.workspaceId && knownWorkspaces.has(agent.workspaceId))
      workspaceId = agent.workspaceId;
    agent = agent.reportsTo ? findSwarmTaskAgent(agents, agent.reportsTo) : undefined;
  }
  return { agentIds, workspaceId };
}

export function swarmTaskScopeOptions(
  board: SwarmTaskBoard,
  projectWorkspaceIds: readonly string[],
  knownWorkspaceIds: readonly string[],
) {
  const project = new Set(projectWorkspaceIds);
  const known = new Set(knownWorkspaceIds);
  const agents = board.agents.filter((agent) => {
    if (agent.retired || agent.roleClass === "worker") return false;
    const ownership = agentScope(board.agents, agent.qualifiedName ?? agent.name, known);
    return ownership.workspaceId !== null && project.has(ownership.workspaceId);
  });
  return [
    { value: "", label: "Project" },
    ...agents.map((agent) => ({
      value: agent.qualifiedName ?? agent.name,
      label: `${agent.roleClass === "planner" ? "Planner" : "Supervisor"} · ${agent.qualifiedName ?? agent.name}`,
    })),
  ];
}

export function scopedSwarmTasks(
  board: SwarmTaskBoard,
  scope: {
    projectWorkspaceIds: readonly string[];
    knownWorkspaceIds?: readonly string[];
    plannerName?: string;
    agentName?: string;
  },
): SwarmTask[] {
  const projectWorkspaces = new Set(scope.projectWorkspaceIds);
  const knownWorkspaces = new Set(scope.knownWorkspaceIds ?? scope.projectWorkspaceIds);
  const roots = [scope.plannerName, scope.agentName].filter((name): name is string =>
    Boolean(name),
  );
  const rootAgents = roots.map((name) => findSwarmTaskAgent(board.agents, name));
  if (rootAgents.some((agent) => !agent)) return [];
  return board.tasks
    .filter((task) => {
      // A manager's own known workspace wins before its ancestors' projects.
      const ownership = agentScope(board.agents, task.managerName, knownWorkspaces);
      return (
        ownership.workspaceId !== null &&
        projectWorkspaces.has(ownership.workspaceId) &&
        rootAgents.every(
          (root) =>
            root &&
            (ownership.agentIds.has(root.paseoAgentId) ||
              (root.roleClass === "worker" &&
                task.workerNames.some(
                  (name) =>
                    findSwarmTaskAgent(board.agents, name)?.paseoAgentId === root.paseoAgentId,
                ))),
        )
      );
    })
    .sort(
      (left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id),
    );
}

export function unansweredChoices(activities: readonly SwarmActivity[]) {
  const answered = new Set(
    activities
      .filter((activity) => activity.actorKind === "human" && activity.replyTo)
      .map((activity) => activity.replyTo),
  );
  return activities.filter((activity) => activityChoice(activity) && !answered.has(activity.id));
}

export interface HumanActivityInput {
  taskId: string;
  actorName: "human";
  kind: "human-note" | "human-response";
  body: string;
  replyTo: string | null;
  responseProfile: SwarmResponseProfile | null;
  data: { selectedOption?: string };
}

export function openSwarmReply(taskId: string, initialActivities: readonly SwarmActivity[]) {
  let activities = initialActivities;
  let closed = false;
  let submissionError: string | null = null;
  const listeners = new Set<() => void>();
  let state = {
    body: "",
    replyTo: null as string | null,
    selectedOption: null as string | null,
    responseProfile: "decision" as SwarmResponseProfile,
    pending: false,
    error: null as string | null,
    notificationWarning: null as string | null,
    canSubmit: false,
  };
  function replyError(): string | null {
    const target = activities.find((activity) => activity.id === state.replyTo);
    if (state.replyTo && !target) return "This reply is unavailable. Cancel the reply to continue.";
    const choice = target ? activityChoice(target) : null;
    const option = choice?.options.find((item) => item.id === state.selectedOption);
    if (
      state.selectedOption &&
      (!option || !unansweredChoices(activities).some((activity) => activity.id === state.replyTo))
    )
      return "This choice is no longer available. Cancel the reply or select an available choice.";
    if (
      state.replyTo &&
      choice?.responseProfiles &&
      !choice.responseProfiles.includes(state.responseProfile)
    )
      return "This response profile changed. Choose an available profile.";
    return null;
  }
  function payload(): HumanActivityInput | null {
    if (replyError()) return null;
    const target = activities.find((activity) => activity.id === state.replyTo);
    const choice = target ? activityChoice(target) : null;
    const option = choice?.options.find((item) => item.id === state.selectedOption);
    const body = [option ? `Selected: ${option.label}` : "", state.body.trim()]
      .filter(Boolean)
      .join("\n");
    if (!body) return null;
    return {
      taskId,
      actorName: "human",
      kind: state.replyTo ? "human-response" : "human-note",
      body,
      replyTo: state.replyTo,
      responseProfile: state.replyTo ? state.responseProfile : null,
      data: option ? { selectedOption: option.id } : {},
    };
  }
  function publish(next: typeof state) {
    if (closed) return;
    state = next;
    state = {
      ...state,
      error: replyError() ?? submissionError,
      canSubmit: !state.pending && payload() !== null,
    };
    for (const listener of listeners) listener();
  }
  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close() {
      closed = true;
      listeners.clear();
    },
    applyActivities(next: readonly SwarmActivity[]) {
      if (closed || next === activities) return;
      activities = next;
      publish(state);
    },
    setBody(body: string) {
      if (!state.pending) {
        submissionError = null;
        publish({ ...state, body });
      }
    },
    replyTo(activityId: string, selectedOption: string | null = null) {
      if (state.pending) return;
      const target = activities.find((activity) => activity.id === activityId);
      if (!target) return;
      const profiles = activityChoice(target)?.responseProfiles;
      submissionError = null;
      publish({
        ...state,
        replyTo: activityId,
        selectedOption,
        responseProfile: profiles?.[0] ?? "decision",
        error: null,
      });
    },
    setProfile(responseProfile: SwarmResponseProfile) {
      if (!state.pending) {
        submissionError = null;
        publish({ ...state, responseProfile });
      }
    },
    cancelReply() {
      if (!state.pending) {
        submissionError = null;
        publish({ ...state, replyTo: null, selectedOption: null });
      }
    },
    async submit(
      send: (input: HumanActivityInput) => Promise<{ notificationWarning?: string } | void>,
    ): Promise<boolean> {
      if (closed || state.pending) return false;
      const input = payload();
      if (!input) {
        submissionError = "Write Activity or select an available choice.";
        publish(state);
        return false;
      }
      submissionError = null;
      publish({ ...state, pending: true });
      try {
        const receipt = await send(input);
        publish({
          ...state,
          body: "",
          replyTo: null,
          selectedOption: null,
          pending: false,
          error: null,
          notificationWarning: receipt?.notificationWarning ?? null,
        });
        return !closed;
      } catch (cause) {
        submissionError = cause instanceof Error ? cause.message : String(cause);
        publish({
          ...state,
          pending: false,
        });
        return false;
      }
    },
  };
}

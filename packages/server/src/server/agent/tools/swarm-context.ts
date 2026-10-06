export interface SwarmAgent {
  paseoAgentId: string;
  name: string;
  qualifiedName?: string;
  roleClass?: string;
  role?: string;
  reportsTo: string | null;
  workspaceId: string | null;
  projectId?: string;
  retired: boolean;
}

export interface SwarmTask {
  id: string;
  title: string;
  brief: string;
  status: string;
  managerName: string;
  workerNames: string[];
  updatedAt: string;
  data?: Record<string, unknown>;
}

export interface SwarmActivity {
  id: string;
  taskId: string;
  actorName: string;
  actorKind: string;
  kind: string;
  body: string;
  replyTo: string | null;
  responseProfile: string | null;
  createdAt: string;
  data: Record<string, unknown>;
  refs: unknown[];
}

export interface SwarmBoard {
  agents?: SwarmAgent[];
  tasks?: SwarmTask[];
  activities?: SwarmActivity[];
}

export function pageSwarmItems<Item extends { id: string }>(
  items: Item[],
  cursor: string | undefined,
  limit: number,
): { items: Item[]; total: number; nextCursor: string | null } {
  const cursorIndex = cursor ? items.findIndex((item) => item.id === cursor) : -1;
  if (cursor && cursorIndex < 0) throw new Error(`Unknown cursor: ${cursor}`);
  const start = cursorIndex + 1;
  const page = items.slice(start, start + limit);
  return {
    items: page,
    total: items.length,
    nextCursor: start + page.length < items.length ? page.at(-1)!.id : null,
  };
}

export function summarizeSwarmTask(task: SwarmTask) {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    managerName: task.managerName,
    workerNames: task.workerNames,
    updatedAt: task.updatedAt,
  };
}

export function summarizeSwarmBoard(
  board: SwarmBoard,
  actor: SwarmAgent,
  input: { limit: number; taskCursor?: string; agentCursor?: string; status?: string },
) {
  const name = actor.qualifiedName ?? actor.name;
  const teamName = actor.roleClass === "worker" ? (actor.reportsTo ?? name) : name;
  const agents = (board.agents ?? [])
    .filter((agent) => {
      const qualifiedName = agent.qualifiedName ?? agent.name;
      return (
        !agent.retired &&
        (qualifiedName === name ||
          qualifiedName === actor.reportsTo ||
          qualifiedName === teamName ||
          agent.reportsTo === teamName)
      );
    })
    .map((agent) => ({
      id: agent.paseoAgentId,
      name: agent.name,
      qualifiedName: agent.qualifiedName ?? agent.name,
      roleClass: agent.roleClass,
      role: agent.role,
      reportsTo: agent.reportsTo,
      workspaceId: agent.workspaceId,
    }))
    .sort((left, right) => left.qualifiedName.localeCompare(right.qualifiedName));
  const tasks = (board.tasks ?? [])
    .filter(
      (task) =>
        (task.managerName === name ||
          task.managerName.startsWith(`${name}.`) ||
          task.workerNames.includes(name)) &&
        (!input.status || task.status === input.status),
    )
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((task) =>
      Object.assign(summarizeSwarmTask(task), {
        activityCount: (board.activities ?? []).filter((activity) => activity.taskId === task.id)
          .length,
      }),
    );
  const agentPage = pageSwarmItems(agents, input.agentCursor, input.limit);
  const taskPage = pageSwarmItems(tasks, input.taskCursor, input.limit);
  return {
    caller: name,
    agents: agentPage.items,
    tasks: taskPage.items,
    totalAgents: agentPage.total,
    totalTasks: taskPage.total,
    nextAgentCursor: agentPage.nextCursor,
    nextTaskCursor: taskPage.nextCursor,
  };
}

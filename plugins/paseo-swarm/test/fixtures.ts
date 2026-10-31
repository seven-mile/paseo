import { resolve } from "node:path";
import { agentQualifiedName, type Activity, type AgentRecord, type Task } from "../shared/models";
import { assemblePrompt } from "../server/seats";
import { store, type SwarmChange } from "../server/state";
import { swarmForProject, swarmOf } from "../server/swarms";

export const BUNDLED_PWA = resolve(__dirname, "../pwa/pr-workflow");

type Unplaced<T extends { swarmId: string }> = Omit<T, "swarmId"> & { swarmId?: string };

export interface Seeded {
  agents?: Array<Unplaced<AgentRecord>>;
  tasks?: Array<Unplaced<Task>>;
  activities?: Array<Unplaced<Activity>>;
}

// Seeded records with no swarm join the swarm of their project, copied from the bundled PR
// workflow PWA unless the test chose another source: seats by project, Tasks by their manager's
// seat, Activities by their Task. Seats with an agent hold the swarm's standing prompt, so delivery
// has no refresh to send first. Without stamp they hold no receipt, as seats registered before
// receipts were recorded.
export async function seed(
  { agents = [], tasks = [], activities = [] }: Seeded,
  { stamp = true } = {},
): Promise<void> {
  const previous = process.env.PASEO_SWARM_PWA_ROOT;
  process.env.PASEO_SWARM_PWA_ROOT ??= BUNDLED_PWA;
  const placedAgents: AgentRecord[] = [];
  try {
    for (const seat of agents) {
      const swarmId = seat.swarmId ?? (await swarmForProject(seat.projectId ?? undefined)).id;
      placedAgents.push({ ...seat, swarmId } as AgentRecord);
    }
  } finally {
    if (previous === undefined) delete process.env.PASEO_SWARM_PWA_ROOT;
  }
  const seats = [...store.read().agents, ...placedAgents];
  const fallback = () => placedAgents[0]?.swarmId ?? store.read().swarms[0]?.id;
  const placedTasks = tasks.map((task): Task => {
    const manager = seats.find((seat) => agentQualifiedName(seat) === task.managerName);
    return { ...task, swarmId: task.swarmId ?? manager?.swarmId ?? fallback() } as Task;
  });
  const placedActivities = activities.map((activity): Activity => {
    const task = placedTasks.find((candidate) => candidate.id === activity.taskId);
    return { ...activity, swarmId: activity.swarmId ?? task?.swarmId ?? fallback() } as Activity;
  });
  await store.commit(() => [
    ...placedAgents.map((record): SwarmChange => {
      const prompt =
        stamp && record.paseoAgentId !== null && !record.prompt
          ? assemblePrompt(record, swarmOf(record).source.files).received
          : record.prompt;
      return {
        op: "put",
        collection: "agents",
        record: { ...record, ...(prompt ? { prompt } : {}) },
      };
    }),
    ...placedTasks.map((record): SwarmChange => ({ op: "put", collection: "tasks", record })),
    ...placedActivities.map(
      (record): SwarmChange => ({ op: "put", collection: "activities", record }),
    ),
  ]);
}

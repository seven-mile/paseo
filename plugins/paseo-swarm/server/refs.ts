import {
  extractInlineSwarmLinks,
  formatSwarmUri,
  parseSwarmUri,
  type ActivityRef,
} from "../shared/refs";
import { agentQualifiedName, type SwarmState } from "../shared/models";

function workspaceExists(state: SwarmState, swarmId: string, workspaceId: string): boolean {
  return state.agents.some(
    (agent) => agent.swarmId === swarmId && agent.workspaceId === workspaceId,
  );
}

// Links in an Activity resolve within the Activity's swarm.
export function resolveActivityRefs(
  body: string,
  state: SwarmState,
  swarmId: string,
): ActivityRef[] {
  const refs: ActivityRef[] = [];
  const seen = new Set<string>();

  for (const link of extractInlineSwarmLinks(body)) {
    const target = parseSwarmUri(link.uri);
    if (!target) {
      throw new Error(`Invalid paseo-swarm reference: ${link.uri}`);
    }
    const uri = formatSwarmUri(target);
    if (seen.has(uri)) continue;
    seen.add(uri);

    switch (target.kind) {
      case "agent": {
        const agent = state.agents.find(
          (candidate) =>
            candidate.swarmId === swarmId && agentQualifiedName(candidate) === target.qualifiedName,
        );
        if (!agent) throw new Error(`Unknown agent reference: ${target.qualifiedName}`);
        if (agent.paseoAgentId === null) {
          throw new Error(
            `Seat ${target.qualifiedName} has no agent to link to until its first message`,
          );
        }
        refs.push({
          kind: "agent",
          uri,
          label: link.label,
          qualifiedName: agentQualifiedName(agent),
          paseoAgentId: agent.paseoAgentId,
          workspaceId: agent.workspaceId,
        });
        break;
      }
      case "workspace":
        if (!workspaceExists(state, swarmId, target.workspaceId)) {
          throw new Error(`Unknown workspace reference: ${target.workspaceId}`);
        }
        refs.push({ kind: "workspace", uri, label: link.label, workspaceId: target.workspaceId });
        break;
      case "task":
        if (!state.tasks.some((task) => task.swarmId === swarmId && task.id === target.taskId)) {
          throw new Error(`Unknown Task reference: ${target.taskId}`);
        }
        refs.push({ kind: "task", uri, label: link.label, taskId: target.taskId });
        break;
      case "file":
        if (!workspaceExists(state, swarmId, target.workspaceId)) {
          throw new Error(`Unknown workspace reference: ${target.workspaceId}`);
        }
        refs.push({
          kind: "file",
          uri,
          label: link.label,
          workspaceId: target.workspaceId,
          path: target.path,
        });
        break;
    }
  }

  return refs;
}

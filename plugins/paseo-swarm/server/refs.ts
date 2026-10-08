import {
  extractInlineSwarmLinks,
  formatSwarmUri,
  parseSwarmUri,
  type ActivityRef,
} from "../shared/refs";
import { agentQualifiedName, type SwarmState } from "../shared/models";

function workspaceExists(state: SwarmState, workspaceId: string): boolean {
  return state.agents.some((agent) => agent.workspaceId === workspaceId);
}

export function resolveActivityRefs(body: string, state: SwarmState): ActivityRef[] {
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
          (candidate) => agentQualifiedName(candidate) === target.qualifiedName,
        );
        if (!agent) throw new Error(`Unknown agent reference: ${target.qualifiedName}`);
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
        if (!workspaceExists(state, target.workspaceId)) {
          throw new Error(`Unknown workspace reference: ${target.workspaceId}`);
        }
        refs.push({ kind: "workspace", uri, label: link.label, workspaceId: target.workspaceId });
        break;
      case "task":
        if (!state.tasks.some((task) => task.id === target.taskId)) {
          throw new Error(`Unknown Task reference: ${target.taskId}`);
        }
        refs.push({ kind: "task", uri, label: link.label, taskId: target.taskId });
        break;
      case "file":
        if (!workspaceExists(state, target.workspaceId)) {
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

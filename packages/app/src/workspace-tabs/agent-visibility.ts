import type { Agent } from "@/stores/session-store";
import type { WorkspaceTabSnapshot } from "@/stores/workspace-layout-actions";
import { isWorkspaceRootAgent } from "@/subagents/policies";
import { seatIdOfAgent } from "@/swarm/seat-labels";
import { normalizeWorkspaceOpaqueId } from "@/utils/workspace-identity";
import type { WorkspaceTabTarget } from "./model";
import { workspaceTabTargetsEqual } from "./identity";

export interface WorkspaceAgentVisibility {
  activeAgentIds: Set<string>;
  autoOpenAgentIds: Set<string>;
  // Auto-open agents whose conversation opens in another tab than their own: a Swarm seat's.
  autoOpenTargetByAgentId: Map<string, WorkspaceTabTarget>;
}

function agentBelongsToWorkspace(agent: Agent, workspaceId: string): boolean {
  return normalizeWorkspaceOpaqueId(agent.workspaceId) === workspaceId;
}

export function deriveWorkspaceAgentVisibility(input: {
  sessionAgents: Map<string, Agent> | undefined;
  agentDetails?: Map<string, Agent> | undefined;
  workspaceId: string | null | undefined;
}): WorkspaceAgentVisibility {
  const { sessionAgents, agentDetails } = input;
  const workspaceId = normalizeWorkspaceOpaqueId(input.workspaceId);
  if ((!sessionAgents && !agentDetails) || !workspaceId) {
    return {
      activeAgentIds: new Set<string>(),
      autoOpenAgentIds: new Set<string>(),
      autoOpenTargetByAgentId: new Map(),
    };
  }

  const activeAgentIds = new Set<string>();
  const autoOpenAgentIds = new Set<string>();
  const autoOpenTargetByAgentId = new Map<string, WorkspaceTabTarget>();
  const agentsById = new Map<string, Agent>([
    ...(agentDetails?.entries() ?? []),
    ...(sessionAgents?.entries() ?? []),
  ]);
  for (const agent of sessionAgents?.values() ?? []) {
    if (!agentBelongsToWorkspace(agent, workspaceId)) {
      continue;
    }
    if (!agent.archivedAt) {
      activeAgentIds.add(agent.id);
      const parentAgent = agent.parentAgentId ? agentsById.get(agent.parentAgentId) : undefined;
      if (isWorkspaceRootAgent(agent, parentAgent)) {
        autoOpenAgentIds.add(agent.id);
        const seatId = seatIdOfAgent(agent);
        if (seatId) autoOpenTargetByAgentId.set(agent.id, { kind: "swarm_seat", seatId });
      }
    }
  }
  return { activeAgentIds, autoOpenAgentIds, autoOpenTargetByAgentId };
}

export function buildWorkspaceTabSnapshot(input: {
  agentVisibility: WorkspaceAgentVisibility;
  agentsHydrated: boolean;
  terminalsHydrated: boolean;
  knownTerminalIds: Iterable<string>;
  standaloneTerminalIds: Iterable<string>;
  hasActivePendingTerminalCreate: boolean;
  hasActivePendingDraftCreate: boolean;
}): WorkspaceTabSnapshot {
  return {
    agentsHydrated: input.agentsHydrated,
    terminalsHydrated: input.terminalsHydrated,
    activeAgentIds: input.agentVisibility.activeAgentIds,
    autoOpenAgentIds: input.agentVisibility.autoOpenAgentIds,
    autoOpenTargetByAgentId: input.agentVisibility.autoOpenTargetByAgentId,
    knownTerminalIds: input.knownTerminalIds,
    standaloneTerminalIds: input.standaloneTerminalIds,
    hasActivePendingTerminalCreate: input.hasActivePendingTerminalCreate,
    hasActivePendingDraftCreate: input.hasActivePendingDraftCreate,
  };
}

export function workspaceAgentVisibilityEqual(
  a: WorkspaceAgentVisibility,
  b: WorkspaceAgentVisibility,
): boolean {
  return (
    setsEqual(a.activeAgentIds, b.activeAgentIds) &&
    setsEqual(a.autoOpenAgentIds, b.autoOpenAgentIds) &&
    targetMapsEqual(a.autoOpenTargetByAgentId, b.autoOpenTargetByAgentId)
  );
}

function targetMapsEqual(
  a: Map<string, WorkspaceTabTarget>,
  b: Map<string, WorkspaceTabTarget>,
): boolean {
  if (a.size !== b.size) {
    return false;
  }
  for (const [agentId, target] of a) {
    const other = b.get(agentId);
    if (!other || !workspaceTabTargetsEqual(target, other)) {
      return false;
    }
  }
  return true;
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) {
    return false;
  }
  for (const item of a) {
    if (!b.has(item)) {
      return false;
    }
  }
  return true;
}

// Prune agent tabs that are no longer active once agents are hydrated.
// Archived agents get pruned so that archiving on one client closes the tab on all clients.
export function shouldPruneWorkspaceAgentTab(input: {
  agentId: string;
  agentsHydrated: boolean;
  activeAgentIds: Set<string>;
}): boolean {
  if (!input.agentId.trim()) {
    return false;
  }
  if (!input.agentsHydrated) {
    return false;
  }
  return !input.activeAgentIds.has(input.agentId);
}

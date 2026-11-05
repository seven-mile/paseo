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
  foreignAgentIds: Set<string>;
}

function isRootAgentOfSession(
  agent: Agent,
  sessionAgents: Map<string, Agent> | undefined,
  agentDetails: Map<string, Agent> | undefined,
): boolean {
  const parentAgent = agent.parentAgentId
    ? (sessionAgents?.get(agent.parentAgentId) ?? agentDetails?.get(agent.parentAgentId))
    : undefined;
  return isWorkspaceRootAgent(agent, parentAgent);
}

export function deriveWorkspaceAgentVisibility(input: {
  sessionAgents: Map<string, Agent> | undefined;
  agentDetails?: Map<string, Agent> | undefined;
  workspaceId: string | null | undefined;
}): WorkspaceAgentVisibility {
  const { sessionAgents, agentDetails } = input;
  const workspaceId = normalizeWorkspaceOpaqueId(input.workspaceId);
  if (!workspaceId) {
    return {
      activeAgentIds: new Set<string>(),
      autoOpenAgentIds: new Set<string>(),
      autoOpenTargetByAgentId: new Map(),
      foreignAgentIds: new Set<string>(),
    };
  }

  const activeAgentIds = new Set<string>();
  const autoOpenAgentIds = new Set<string>();
  const autoOpenTargetByAgentId = new Map<string, WorkspaceTabTarget>();
  const foreignAgentIds = new Set<string>();
  for (const agent of sessionAgents?.values() ?? []) {
    const ownerId = normalizeWorkspaceOpaqueId(agent.workspaceId);
    if (ownerId !== workspaceId) {
      if (ownerId) {
        foreignAgentIds.add(agent.id);
      }
      continue;
    }
    if (!agent.archivedAt) {
      activeAgentIds.add(agent.id);
      if (isRootAgentOfSession(agent, sessionAgents, agentDetails)) {
        autoOpenAgentIds.add(agent.id);
        const seatId = seatIdOfAgent(agent);
        if (seatId) autoOpenTargetByAgentId.set(agent.id, { kind: "swarm_seat", seatId });
      }
    }
  }
  for (const agent of agentDetails?.values() ?? []) {
    if (sessionAgents?.has(agent.id)) {
      continue;
    }
    const ownerId = normalizeWorkspaceOpaqueId(agent.workspaceId);
    if (ownerId && ownerId !== workspaceId) {
      foreignAgentIds.add(agent.id);
    }
  }
  return { activeAgentIds, autoOpenAgentIds, autoOpenTargetByAgentId, foreignAgentIds };
}

interface AgentMapsSnapshot {
  sessions: Record<
    string,
    { agents: Map<string, Agent>; agentDetails: Map<string, Agent> } | undefined
  >;
}

// Session-store selectors run on every store update, including every stream tick, which
// leaves the agent maps untouched. Reuse the previous result until either map changes, and
// keep it when a recompute yields the same sets so the hook's equality check stays O(1).
export function createWorkspaceAgentVisibilitySelector(input: {
  serverId: string;
  workspaceId: string | null | undefined;
}): (state: AgentMapsSnapshot) => WorkspaceAgentVisibility {
  let previousAgents: Map<string, Agent> | undefined;
  let previousAgentDetails: Map<string, Agent> | undefined;
  let previousVisibility: WorkspaceAgentVisibility | null = null;

  return (state) => {
    const session = state.sessions[input.serverId];
    const agents = session?.agents;
    const agentDetails = session?.agentDetails;
    if (previousVisibility && agents === previousAgents && agentDetails === previousAgentDetails) {
      return previousVisibility;
    }

    const visibility = deriveWorkspaceAgentVisibility({
      sessionAgents: agents,
      agentDetails,
      workspaceId: input.workspaceId,
    });
    previousAgents = agents;
    previousAgentDetails = agentDetails;
    if (!previousVisibility || !workspaceAgentVisibilityEqual(previousVisibility, visibility)) {
      previousVisibility = visibility;
    }
    return previousVisibility;
  };
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
    foreignAgentIds: input.agentVisibility.foreignAgentIds,
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
    a === b ||
    (setsEqual(a.activeAgentIds, b.activeAgentIds) &&
      setsEqual(a.autoOpenAgentIds, b.autoOpenAgentIds) &&
      setsEqual(a.foreignAgentIds, b.foreignAgentIds) &&
      targetMapsEqual(a.autoOpenTargetByAgentId, b.autoOpenTargetByAgentId))
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

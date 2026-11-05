import type { AgentAddress } from "./addresses.js";
export const PARENT_SERVER_ID_LABEL = "paseo.parent-server-id";
export const PARENT_AGENT_ID_LABEL = "paseo.parent-agent-id";
// Declared by whatever manages an agent's lifecycle, such as a plugin, so clients close its tab
// without archiving it. Clients read only the label; Stop and Archive stay explicit actions.
export const TAB_CLOSE_LABEL = "paseo.tab-close";
export const TAB_CLOSE_LAYOUT_ONLY = "layout-only";
const OPEN_AGENT_TAB_LABEL_PREFIX = "paseo.open-agent-tab.";

export function getOpenAgentTabLabel(clientId: string): string {
  return `${OPEN_AGENT_TAB_LABEL_PREFIX}${clientId}`;
}

export function isOpenAgentTabLabel(label: string): boolean {
  return label.startsWith(OPEN_AGENT_TAB_LABEL_PREFIX);
}

export interface AgentLabelSource {
  labels?: Record<string, unknown> | null;
}

export function getParentAgentIdFromLabels(labels: Record<string, unknown> | null | undefined) {
  const parentAgentId = labels?.[PARENT_AGENT_ID_LABEL];
  return typeof parentAgentId === "string" && parentAgentId.trim().length > 0
    ? parentAgentId.trim()
    : null;
}

export function closesTabLayoutOnly(labels: Record<string, unknown> | null | undefined): boolean {
  return labels?.[TAB_CLOSE_LABEL] === TAB_CLOSE_LAYOUT_ONLY;
}

export function isDelegatedAgent(agent: AgentLabelSource): boolean {
  return getParentAgentIdFromLabels(agent.labels) !== null;
}

export function hasOpenAgentTab(labels: Record<string, unknown> | null | undefined): boolean {
  return Object.entries(labels ?? {}).some(
    ([label, value]) => isOpenAgentTabLabel(label) && value === "true",
  );
}

// Absent parent server label means the same host.
export function getParentAddressFromLabels(
  labels: Record<string, unknown> | null | undefined,
  serverId: string,
): AgentAddress | null {
  const agentId = getParentAgentIdFromLabels(labels);
  if (!agentId) return null;
  const parentServerId = labels?.[PARENT_SERVER_ID_LABEL];
  return {
    serverId:
      typeof parentServerId === "string" && parentServerId.trim()
        ? parentServerId.trim()
        : serverId,
    agentId,
  };
}
export function parentAddressLabels(parent: AgentAddress): Record<string, string> {
  return { [PARENT_AGENT_ID_LABEL]: parent.agentId, [PARENT_SERVER_ID_LABEL]: parent.serverId };
}

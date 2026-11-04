import type { Agent } from "@/stores/session-store";

// Swarm labels every agent it starts with the seat it holds or held. The person talks to the seat,
// so the app opens the seat's tab for such an agent instead of the agent's own.
const SEAT_ID_LABEL = "paseo-swarm.seat-id";

export function seatIdOfAgent(agent: Partial<Pick<Agent, "labels">>): string | null {
  const seatId = agent.labels?.[SEAT_ID_LABEL]?.trim();
  return seatId ? seatId : null;
}

// The seat's agents that only its tab shows. Closing the seat tab hides them, so it stays closed
// until another agent takes the seat. An agent with its own tab open stays visible, or hiding it
// would close that tab too.
export function agentsShownOnlyBySeatTab(input: {
  agents: Iterable<Pick<Agent, "id" | "labels">>;
  seatId: string;
  openAgentIds: ReadonlySet<string>;
}): string[] {
  const agentIds: string[] = [];
  for (const agent of input.agents) {
    if (seatIdOfAgent(agent) === input.seatId && !input.openAgentIds.has(agent.id)) {
      agentIds.push(agent.id);
    }
  }
  return agentIds;
}

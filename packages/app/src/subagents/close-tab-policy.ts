import { closesTabLayoutOnly } from "@getpaseo/protocol/agent-labels";
import type { Agent } from "@/stores/session-store";

export type CloseAgentTabPolicy = { kind: "archive-on-close" } | { kind: "layout-only" };

export function resolveCloseAgentTabPolicy(
  agent: (Pick<Agent, "parentAgentId"> & Partial<Pick<Agent, "labels">>) | null | undefined,
): CloseAgentTabPolicy {
  if (agent?.parentAgentId || closesTabLayoutOnly(agent?.labels)) {
    return { kind: "layout-only" };
  }

  return { kind: "archive-on-close" };
}

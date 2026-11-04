import { describe, expect, it } from "vitest";
import type { Agent } from "@/stores/session-store";
import { deriveWorkspaceAgentVisibility } from "@/workspace-tabs/agent-visibility";
import { agentsShownOnlyBySeatTab, seatIdOfAgent } from "./seat-labels";

function agent(id: string, labels: Record<string, string> = {}): Agent {
  return { id, workspaceId: "ws-1", parentAgentId: null, archivedAt: null, labels } as Agent;
}

describe("seat labels", () => {
  it("opens a Swarm agent as its seat and other agents as themselves", () => {
    const agents = new Map([
      ["dev-1", agent("dev-1", { "paseo-swarm.seat-id": "seat-dev" })],
      ["plain", agent("plain")],
    ]);
    const visibility = deriveWorkspaceAgentVisibility({
      sessionAgents: agents,
      workspaceId: "ws-1",
    });
    expect([...visibility.autoOpenAgentIds].sort()).toEqual(["dev-1", "plain"]);
    expect([...visibility.autoOpenTargetByAgentId]).toEqual([
      ["dev-1", { kind: "swarm_seat", seatId: "seat-dev" }],
    ]);
    expect(seatIdOfAgent(agent("blank", { "paseo-swarm.seat-id": " " }))).toBeNull();
  });

  it("hides only the seat's agents that have no tab of their own", () => {
    expect(
      agentsShownOnlyBySeatTab({
        agents: [
          agent("dev-1", { "paseo-swarm.seat-id": "seat-dev" }),
          agent("dev-2", { "paseo-swarm.seat-id": "seat-dev" }),
          agent("lead-1", { "paseo-swarm.seat-id": "seat-lead" }),
          agent("plain"),
        ],
        seatId: "seat-dev",
        openAgentIds: new Set(["dev-2"]),
      }),
    ).toEqual(["dev-1"]);
  });
});

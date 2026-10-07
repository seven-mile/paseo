import { describe, expect, it } from "vitest";
import { i18n } from "@/i18n/i18next";
import {
  SwarmCreationError,
  filterSwarmParents,
  resolveSwarmParent,
  type SwarmParentChoice,
} from "./parent-selection";

const parents: SwarmParentChoice[] = [
  {
    name: "alpha",
    title: "alpha",
    displayName: "alpha",
    paseoAgentId: "agent-a",
    serverId: "host",
    workspaceId: "workspace-a",
  },
  {
    name: "beta",
    title: "beta",
    displayName: "beta",
    paseoAgentId: "agent-b",
    serverId: "host",
    workspaceId: "workspace-b",
  },
  {
    name: "remote",
    title: "remote",
    displayName: "remote",
    paseoAgentId: "agent-c",
    serverId: "remote",
    workspaceId: "workspace-a",
  },
  {
    name: "unbound",
    title: "unbound",
    displayName: "unbound",
    paseoAgentId: "agent-d",
    serverId: "host",
    workspaceId: null,
  },
];

describe("Swarm parent selection", () => {
  it("retains cached client error identity across language changes without classifying raw errors", async () => {
    const previousLanguage = i18n.language;
    try {
      await i18n.changeLanguage("en");
      const cached = new SwarmCreationError("swarm.creation.notInstalled");
      const english = i18n.t(cached.translationKey);
      const raw = new Error(english);
      await i18n.changeLanguage("zh-CN");
      expect(i18n.t(cached.translationKey)).not.toBe(english);
      expect(i18n.t(cached.translationKey)).not.toBe(cached.translationKey);
      expect(cached.translationKey).toBe("swarm.creation.notInstalled");
      expect(raw).not.toBeInstanceOf(SwarmCreationError);
      expect(raw.message).toBe(english);
    } finally {
      await i18n.changeLanguage(previousLanguage);
    }
  });

  it("offers only planners in the selected project and host", () => {
    expect(
      filterSwarmParents(parents, "supervisor", "host", ["host:workspace-a"]).map(
        (parent) => parent.name,
      ),
    ).toEqual(["alpha"]);
  });

  it("reconciles a stale parent when the project changes", () => {
    const available = filterSwarmParents(parents, "supervisor", "host", ["host:workspace-b"]);
    expect(resolveSwarmParent(available, "alpha")).toBe("beta");
  });

  it("clears the parent when the project has no planner", () => {
    expect(
      resolveSwarmParent(filterSwarmParents(parents, "supervisor", "host", []), "alpha"),
    ).toBeNull();
  });

  it("excludes other projects and unbound supervisors when creating a worker", () => {
    const available = filterSwarmParents(parents, "worker", "host", ["host:workspace-b"]);
    expect(available.map((parent) => parent.name)).toEqual(["beta"]);
    expect(resolveSwarmParent(available, "alpha")).toBe("beta");
  });

  it("allows supervisors to dispatch workers across workspaces in the selected project", () => {
    expect(
      filterSwarmParents(parents, "worker", "host", ["host:workspace-a", "host:workspace-b"]).map(
        (parent) => parent.name,
      ),
    ).toEqual(["alpha", "beta"]);
  });
});

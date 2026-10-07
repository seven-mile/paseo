import { describe, expect, it } from "vitest";
import { i18n } from "@/i18n/i18next";
import {
  getSwarmCreationLoadKey,
  getSwarmCreationValidationKey,
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
  it("renders local availability in the selected language while preserving raw query errors", async () => {
    const previousLanguage = i18n.language;
    try {
      await i18n.changeLanguage("en");
      const key = getSwarmCreationLoadKey("not-installed", []);
      expect(key).toBe("swarm.creation.notInstalled");
      const english = i18n.t(key ?? "");
      const raw = new Error(english);
      await i18n.changeLanguage("zh-CN");
      expect(i18n.t(key ?? "")).not.toBe(english);
      expect(getSwarmCreationLoadKey("not-installed", [])).toBe(key);
      expect(getSwarmCreationLoadKey("error", [])).toBeNull();
      expect(raw.message).toBe(english);
    } finally {
      await i18n.changeLanguage(previousLanguage);
    }
  });

  it.each([
    ["missing-project", "swarm.creation.chooseProject"],
    ["not-installed", "swarm.creation.notInstalled"],
    ["pending", "swarm.creation.waitRoles"],
    ["error", null],
    ["loaded", "swarm.creation.noRoles"],
  ] as const)("keeps %s separate from resolved form validation", (loadState, expected) => {
    expect(
      getSwarmCreationValidationKey({
        loadState,
        roleClass: "supervisor",
        roles: [],
        role: "engineer",
        parents,
        reportsTo: "alpha",
      }),
    ).toBe(expected);
  });

  it("validates role and current parent only after the target has loaded", () => {
    const input = {
      loadState: "loaded" as const,
      roleClass: "supervisor" as const,
      roles: [{ role: "engineer" }],
      role: "engineer",
      parents: filterSwarmParents(parents, "supervisor", "host", ["host:workspace-b"]),
      reportsTo: "beta",
    };
    expect(getSwarmCreationValidationKey(input)).toBeNull();
    expect(getSwarmCreationLoadKey(input.loadState, input.roles)).toBeNull();
    expect(getSwarmCreationValidationKey({ ...input, role: "removed-role" })).toBe(
      "swarm.creation.chooseRole",
    );
    expect(getSwarmCreationValidationKey({ ...input, reportsTo: "alpha" })).toBe(
      "swarm.creation.chooseManager",
    );
    expect(getSwarmCreationValidationKey({ ...input, roleClass: "worker", reportsTo: null })).toBe(
      "swarm.creation.chooseManager",
    );
    expect(
      getSwarmCreationValidationKey({ ...input, roleClass: "planner", reportsTo: null }),
    ).toBeNull();
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

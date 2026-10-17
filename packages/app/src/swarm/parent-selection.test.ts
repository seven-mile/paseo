import { describe, expect, it } from "vitest";
import { i18n } from "@/i18n/i18next";
import {
  getSwarmCreationLoadKey,
  getSwarmCreationValidationKey,
  filterSwarmParents,
  resolveSwarmParent,
  openSwarmPreparation,
  reconcileSwarmCreationDraft,
  swarmPwaSourceIdentity,
  type SwarmCreationDraft,
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

describe("prepared Swarm creation identity", () => {
  it("reuses the same prompt/UUID after native failure and rejects a changed submission", async () => {
    const reservation = openSwarmPreparation((id) => `Resolve ${id}`);
    const prepared = {
      agentId: "prepared-id",
      systemPrompt: "fixed prompt",
      parentAgentId: "native-parent",
    };
    let creates = 0;
    const create = async () => {
      creates += 1;
      return prepared;
    };
    expect(await reservation.prepare("host/project/parent/pwa/role/name/brief", create)).toBe(
      prepared,
    );
    expect(await reservation.prepare("host/project/parent/pwa/role/name/brief", create)).toBe(
      prepared,
    );
    await expect(reservation.prepare("different-brief", create)).rejects.toThrow(
      "Resolve prepared-id",
    );
    expect(creates).toBe(1);
  });
  it("shares an in-flight prepare and permits retry only when prepare itself failed", async () => {
    const reservation = openSwarmPreparation((id) => id);
    let resolve!: (value: { agentId: string; systemPrompt: string; parentAgentId: null }) => void;
    let creates = 0;
    const create = () => {
      creates += 1;
      return new Promise<{ agentId: string; systemPrompt: string; parentAgentId: null }>(
        (complete) => {
          resolve = complete;
        },
      );
    };
    const first = reservation.prepare("same", create);
    const duplicate = reservation.prepare("same", create);
    resolve({ agentId: "once", systemPrompt: "prompt", parentAgentId: null });
    expect(await first).toEqual(await duplicate);
    expect(creates).toBe(1);
    const retryable = openSwarmPreparation((id) => id);
    await expect(
      retryable.prepare("same", async () => {
        throw new Error("read failed");
      }),
    ).rejects.toThrow("read failed");
    expect(
      await retryable.prepare("same", async () => ({
        agentId: "retry",
        systemPrompt: "latest",
        parentAgentId: null,
      })),
    ).toMatchObject({ agentId: "retry" });
  });
});

describe("creation hydration and inherited source identity", () => {
  it("keeps the explicit parent on first Project hydration, then resets on real Project changes", () => {
    const initial: SwarmCreationDraft = {
      key: "host:pending:worker",
      serverId: "host",
      roleClass: "worker",
      hasProject: false,
      hasResolvedProject: false,
      directory: undefined,
      role: "",
      parent: "chosen.supervisor",
    };
    const hydrated = reconcileSwarmCreationDraft(initial, {
      key: "host:project-a:worker",
      serverId: "host",
      roleClass: "worker",
      hasProject: true,
    });
    expect(hydrated.parent).toBe("chosen.supervisor");
    expect(
      resolveSwarmParent(
        [
          { ...parents[0], name: "first.supervisor" },
          { ...parents[1], name: "chosen.supervisor" },
        ],
        hydrated.parent,
      ),
    ).toBe("chosen.supervisor");
    expect(reconcileSwarmCreationDraft(hydrated, hydrated)).toBe(hydrated);
    const edited = { ...hydrated, role: "reviewer", directory: "team-a" };
    const changed = reconcileSwarmCreationDraft(edited, {
      key: "host:project-b:worker",
      serverId: "host",
      roleClass: "worker",
      hasProject: true,
    });
    expect(changed).toMatchObject({
      parent: null,
      role: "",
      directory: undefined,
      hasResolvedProject: true,
    });
    const temporarilyMissing = reconcileSwarmCreationDraft(edited, {
      ...initial,
      key: "host:missing:worker",
    });
    expect(
      reconcileSwarmCreationDraft(temporarilyMissing, { ...changed, key: "host:project-c:worker" })
        .parent,
    ).toBeNull();
    expect(
      reconcileSwarmCreationDraft(initial, {
        ...initial,
        serverId: "other",
        key: "other:pending:worker",
      }).parent,
    ).toBeNull();
  });

  it("reuses child reservation after unrelated Project root changes but rejects a changed parent binding", async () => {
    const binding = {
      projectId: "project",
      contentRoot: "/bound-content",
      directory: "/bound-content/team",
    };
    const before = swarmPwaSourceIdentity("worker", "/discovery-a", "team", binding);
    const after = swarmPwaSourceIdentity("worker", "/discovery-b", "other-default", binding);
    expect(after).toBe(before);
    const reservation = openSwarmPreparation((id) => `Resolve ${id}`);
    const prepared = { agentId: "preserved-child", systemPrompt: "fixed", parentAgentId: "parent" };
    const result = await reservation.prepare(before, async () => prepared);
    expect(
      await reservation.prepare(after, async () => {
        throw new Error("must reuse prepared identity");
      }),
    ).toBe(result);
    const moved = swarmPwaSourceIdentity("worker", "/discovery-b", "team", {
      ...binding,
      directory: "/bound-content/moved",
    });
    await expect(reservation.prepare(moved, async () => prepared)).rejects.toThrow(
      "Resolve preserved-child",
    );
    expect(swarmPwaSourceIdentity("planner", "/discovery-a", "team", undefined)).not.toBe(
      swarmPwaSourceIdentity("planner", "/discovery-b", "team", undefined),
    );
    expect(swarmPwaSourceIdentity("planner", "/discovery-a", "team", undefined)).not.toBe(
      swarmPwaSourceIdentity("planner", "/discovery-a", "other-team", undefined),
    );
  });
});

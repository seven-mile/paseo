import { describe, expect, it } from "vitest";
import { readSwarmAgentCreationConfig } from "./pwa-form-model";
import { i18n } from "@/i18n/i18next";
import {
  getSwarmCreationLoadKey,
  getSwarmCreationValidationKey,
  filterSwarmParents,
  resolveSwarmParent,
  openSwarmCreationFormDraft,
  resolveSwarmCheckoutSelection,
  changeSwarmCreationParent,
  reconcileSwarmCreationDraft,
  resolveSwarmPwaSelection,
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
});

describe("effective inherited PWA selection", () => {
  const root = {
    path: "/root",
    discoveryAvailable: true,
    complete: true,
    errors: [],
    entries: [
      { directory: ".", title: "Legacy root", roles: [], statuses: [] },
      { directory: "team", title: "Team", roles: [], statuses: [] },
    ],
  };
  it("uses only the valid root for an unbound parent, never a default or first team", () => {
    expect(resolveSwarmPwaSelection(root, "worker", parents[0], "team")).toMatchObject({
      canReadRoles: true,
      inheritedDirectory: "/root",
    });
    expect(
      resolveSwarmPwaSelection(
        { ...root, entries: root.entries.slice(1) },
        "worker",
        parents[0],
        "team",
      ),
    ).toMatchObject({ canReadRoles: true, inheritedDirectory: undefined });
    expect(
      resolveSwarmPwaSelection(
        { ...root, entries: [], discoveryAvailable: false },
        "worker",
        parents[0],
        "",
      ),
    ).toMatchObject({ canReadRoles: true, inheritedDirectory: "/root" });
    expect(
      resolveSwarmPwaSelection(
        { ...root, entries: [], rootError: "Read failed" },
        "worker",
        parents[0],
        "",
      ),
    ).toMatchObject({ canReadRoles: true });
  });
  it("keeps a complete explicit binding ahead of unrelated Project root/default changes", () => {
    const parent = {
      ...parents[0],
      pwaBinding: { projectId: "p", contentRoot: "/bound", directory: "/bound/team" },
    };
    expect(resolveSwarmPwaSelection(root, "worker", parent, "team")).toMatchObject({
      inheritedDirectory: "/bound/team",
      canReadRoles: true,
    });
  });
});

it("delegates inherited source readability to the roles RPC without offering rebind", () => {
  const source = {
    path: "/root",
    discoveryAvailable: true,
    complete: false,
    errors: [{ directory: "unvisited", error: "budget exceeded" }],
    entries: [{ directory: "other", title: "Other", roles: [], statuses: [] }],
  };
  const selection = resolveSwarmPwaSelection(source, "worker", parents[0], "other");
  expect(selection).toMatchObject({
    canReadRoles: true,
    inherited: true,
    inheritedDirectory: undefined,
  });
  expect(
    resolveSwarmPwaSelection({ ...source, complete: true }, "worker", parents[0], "other"),
  ).toEqual(selection);
  expect(resolveSwarmPwaSelection(source, "worker", undefined, "other").canReadRoles).toBe(false);
});

describe("Swarm wizard draft remount lifetime", () => {
  it("keeps explicit edits across subscribers and preserves role on the same parent only", () => {
    const form = openSwarmCreationFormDraft("supervisor");
    const selection: SwarmCreationDraft = {
      key: "host:project:supervisor",
      serverId: "host",
      roleClass: "supervisor",
      hasProject: true,
      hasResolvedProject: true,
      directory: "team-a",
      role: "legacy-supervisor",
      parent: "qa-planner",
    };
    let publications = 0;
    const unsubscribe = form.subscribe(() => {
      publications += 1;
    });
    form.setName("qa-created-supervisor");
    form.setSelection(selection);
    unsubscribe();
    const remounted = form.getSnapshot();
    expect(remounted).toEqual({
      name: "qa-created-supervisor",
      selection,
      manualHost: null,
      projectSelection: null,
      isolation: null,
      checkout: null,
    });
    expect(publications).toBe(2);
    const sameParent = changeSwarmCreationParent(remounted.selection!, "qa-planner");
    expect(sameParent).toBe(selection);
    form.setSelection(sameParent);
    expect(form.getSnapshot()).toBe(remounted);
    form.setSelection(changeSwarmCreationParent(selection, "other-planner"));
    expect(form.getSnapshot()).toMatchObject({
      name: "qa-created-supervisor",
      selection: { parent: "other-planner", role: "", directory: "team-a" },
    });
    expect(openSwarmCreationFormDraft("supervisor").getSnapshot()).toEqual({
      name: "supervisor",
      selection: null,
      manualHost: null,
      projectSelection: null,
      isolation: null,
      checkout: null,
    });
  });
});

it("retains isolation and checkout only for the real creation target", () => {
  const form = openSwarmCreationFormDraft("worker");
  const targetB = JSON.stringify(["other-host", "/work/b"]);
  const targetA = JSON.stringify(["host", "/work/a"]);
  const branch = {
    kind: "branch",
    name: "feature",
    refName: "refs/heads/feature",
    accessibilityLabel: "feature",
  } as const;
  form.setHost({ routeServerId: "host", serverId: "other-host" });
  form.setIsolation("worktree");
  form.dispatchCheckout(targetB, { type: "picker-selected", item: branch });
  const remounted = form.getSnapshot();
  expect(remounted.manualHost).toEqual({ routeServerId: "host", serverId: "other-host" });
  expect(remounted.isolation).toBe("worktree");
  expect(resolveSwarmCheckoutSelection(remounted.checkout, targetB).selectedItem).toBe(branch);
  expect(resolveSwarmCheckoutSelection(remounted.checkout, targetA).selectedItem).toBeNull();
  form.dispatchCheckout(targetB, { type: "target-changed" });
  expect(
    resolveSwarmCheckoutSelection(form.getSnapshot().checkout, targetB).selectedItem,
  ).toBeNull();
  expect(openSwarmCreationFormDraft("worker").getSnapshot().checkout).toBeNull();
});

describe("human Swarm creation configuration and registration", () => {
  it("reads without reserving an identity and retries registration with the captured source", async () => {
    const calls: Array<{ method: string; input: unknown }> = [];
    let source = "/root/a";
    let fail = true;
    const invoke = async (method: string, input: unknown) => {
      calls.push({ method, input });
      if (method === "swarm.agent.config.read")
        return {
          systemPrompt: "original P",
          parentAgentId: "real-parent",
          projectId: "project",
          pwaBinding: { projectId: "project", contentRoot: "/root", directory: source },
        };
      if (fail) throw new Error("registration unavailable");
      return {};
    };
    const config = await readSwarmAgentCreationConfig(invoke, {
      projectId: "project",
      roleClass: "worker",
      name: "reviewer",
      role: "reviewer",
      reportsTo: "planner.supervisor",
      brief: "original brief",
    });
    expect(config.systemPrompt).toBe("original P");
    expect(config.parentAgentId).toBe("real-parent");
    expect(calls.map((call) => call.method)).toEqual(["swarm.agent.config.read"]);
    const created = { agentId: "native-created-id", workspaceId: "native-workspace" };
    await expect(config.register(created)).rejects.toThrow("registration unavailable");
    source = "/root/b";
    fail = false;
    await config.register(created);
    expect(calls.map((call) => call.method)).toEqual([
      "swarm.agent.config.read",
      "swarm.agent.register",
      "swarm.agent.register",
    ]);
    expect(calls[1].input).toEqual(calls[2].input);
    expect(calls[2].input).toMatchObject({
      paseoAgentId: "native-created-id",
      workspaceId: "native-workspace",
      pwaBinding: { directory: "/root/a" },
      reportsTo: "planner.supervisor",
    });
  });
});

it("does not attempt registration when read-only configuration fails", async () => {
  const methods: string[] = [];
  await expect(
    readSwarmAgentCreationConfig(
      async (method) => {
        methods.push(method);
        throw new Error("PWA unavailable");
      },
      {
        projectId: "project",
        roleClass: "planner",
        name: "planner",
        role: "planner",
        reportsTo: null,
        pwaDirectory: "second",
        brief: "brief",
      },
    ),
  ).rejects.toThrow("PWA unavailable");
  expect(methods).toEqual(["swarm.agent.config.read"]);
});

export type SwarmCreationLoadState =
  | "missing-project"
  | "not-installed"
  | "pending"
  | "error"
  | "loaded";

export function getSwarmCreationLoadKey(
  loadState: SwarmCreationLoadState,
  roles: readonly { role: string }[],
) {
  switch (loadState) {
    case "missing-project":
      return "swarm.creation.chooseProject";
    case "not-installed":
      return "swarm.creation.notInstalled";
    case "pending":
      return "swarm.creation.waitRoles";
    case "error":
      return null;
    case "loaded":
      return roles.length === 0 ? "swarm.creation.noRoles" : null;
  }
}

export function getSwarmCreationValidationKey(input: {
  loadState: SwarmCreationLoadState;
  roleClass: "planner" | "supervisor" | "worker";
  roles: readonly { role: string }[];
  role: string;
  parents: readonly SwarmParentChoice[];
  reportsTo: string | null;
}) {
  const loadKey = getSwarmCreationLoadKey(input.loadState, input.roles);
  if (loadKey || input.loadState !== "loaded") return loadKey;
  if (!input.roles.some((choice) => choice.role === input.role)) return "swarm.creation.chooseRole";
  if (
    input.roleClass !== "planner" &&
    !input.parents.some((choice) => choice.name === input.reportsTo)
  )
    return "swarm.creation.chooseManager";
  return null;
}

export interface SwarmParentChoice {
  name: string;
  title: string;
  displayName: string;
  paseoAgentId: string;
  serverId: string;
  workspaceId: string | null;
  pwaBinding?: { projectId?: string; contentRoot: string; directory: string };
}

export function filterSwarmParents(
  parents: readonly SwarmParentChoice[],
  roleClass: "planner" | "supervisor" | "worker",
  serverId: string,
  workspaceKeys: readonly string[],
) {
  return parents.filter(
    (parent) =>
      parent.serverId === serverId &&
      (roleClass === "planner" ||
        (parent.workspaceId !== null &&
          workspaceKeys.includes(`${serverId}:${parent.workspaceId}`))),
  );
}

export function resolveSwarmParent(parents: readonly SwarmParentChoice[], selected: string | null) {
  return parents.some((parent) => parent.name === selected) ? selected : (parents[0]?.name ?? null);
}

export interface SwarmCreationDraftContext {
  key: string;
  serverId: string;
  roleClass: "planner" | "supervisor" | "worker";
  hasProject: boolean;
}

export interface SwarmCreationDraft extends SwarmCreationDraftContext {
  hasResolvedProject: boolean;
  directory: string | null | undefined;
  role: string;
  parent: string | null;
}

export function reconcileSwarmCreationDraft(
  draft: SwarmCreationDraft,
  context: SwarmCreationDraftContext,
): SwarmCreationDraft {
  if (draft.key === context.key) return draft;
  const initialHydration =
    !draft.hasResolvedProject &&
    context.hasProject &&
    draft.serverId === context.serverId &&
    draft.roleClass === context.roleClass;
  return {
    ...context,
    hasResolvedProject: draft.hasResolvedProject || context.hasProject,
    directory: undefined,
    role: "",
    parent: initialHydration ? draft.parent : null,
  };
}

export function swarmPwaSourceIdentity(
  roleClass: SwarmCreationDraftContext["roleClass"],
  sourcePath: string | null | undefined,
  directory: string,
  parentBinding: SwarmParentChoice["pwaBinding"],
) {
  if (roleClass === "planner") return JSON.stringify(["planner", sourcePath, directory]);
  return JSON.stringify([
    "inherited",
    parentBinding?.projectId,
    parentBinding?.contentRoot,
    parentBinding?.directory,
  ]);
}

export interface SwarmPreparedAgent {
  agentId: string;
  systemPrompt: string;
  parentAgentId: string | null;
}

// A failed native create/bind keeps the prepared prompt and identity for this form lifetime.
export function openSwarmPreparation(onConflict: (agentId: string) => string) {
  let reservation: { key: string; result: SwarmPreparedAgent } | null = null;
  let pending: { key: string; result: Promise<SwarmPreparedAgent> } | null = null;
  return {
    async prepare(
      key: string,
      create: () => Promise<SwarmPreparedAgent>,
    ): Promise<SwarmPreparedAgent> {
      if (reservation) {
        if (reservation.key === key) return reservation.result;
        throw new Error(onConflict(reservation.result.agentId));
      }
      if (pending) {
        if (pending.key === key) return pending.result;
        const prepared = await pending.result;
        throw new Error(onConflict(prepared.agentId));
      }
      const result = create();
      pending = { key, result };
      try {
        const prepared = await result;
        reservation = { key, result: prepared };
        return prepared;
      } finally {
        pending = null;
      }
    },
  };
}

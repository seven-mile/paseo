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

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
      (roleClass !== "supervisor" ||
        (parent.workspaceId !== null &&
          workspaceKeys.includes(`${serverId}:${parent.workspaceId}`))),
  );
}

export function resolveSwarmParent(parents: readonly SwarmParentChoice[], selected: string | null) {
  return parents.some((parent) => parent.name === selected) ? selected : (parents[0]?.name ?? null);
}

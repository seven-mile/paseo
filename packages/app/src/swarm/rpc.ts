import { useInstalledPlugin } from "@/plugins/registry";
import { useCallback } from "react";

export type SwarmRoleClass = "planner" | "supervisor" | "worker";

export interface SwarmRoleOption {
  role: string;
  roleClass: SwarmRoleClass;
  title: string;
  description: string;
}

export interface SwarmAgentSummary {
  paseoAgentId: string;
  name: string;
  qualifiedName?: string;
  roleClass: SwarmRoleClass;
  reportsTo: string | null;
  workspaceId: string | null;
  retired: boolean;
}

export function useSwarmRpc(serverId: string) {
  const plugin = useInstalledPlugin(serverId, "paseo-swarm");
  const invoke = useCallback(
    async <T>(method: string, input: unknown): Promise<T> => {
      if (!plugin) throw new Error("Paseo Swarm plugin is not installed on this host");
      return (await plugin.invoke(method, input)) as T;
    },
    [plugin],
  );
  return { plugin, invoke };
}

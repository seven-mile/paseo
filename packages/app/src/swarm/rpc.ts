import { useInstalledPlugin } from "@/plugins/registry";
import { useCallback } from "react";

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

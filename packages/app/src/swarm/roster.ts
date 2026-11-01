import { z } from "zod";
import { useFetchQuery } from "@/data/query";
import type { InstalledPlugin } from "@/plugins/types";

const configSchema = z.object({
  provider: z.string().optional(),
  modeId: z.string().optional(),
  thinkingOptionId: z.string().optional(),
});

const occupantSchema = z.object({
  number: z.number(),
  config: configSchema.optional(),
  boundAt: z.string().optional(),
});

// The fields of a Swarm seat the app reads. The plugin's seat schema is the source; fields added
// after the first Swarm release are optional, since an older host omits them.
export const rosterSeatSchema = z.object({
  id: z.string(),
  swarmId: z.string().optional(),
  // Null until the seat's first message starts its agent.
  paseoAgentId: z.string().nullable(),
  name: z.string(),
  qualifiedName: z.string().optional(),
  roleClass: z.enum(["planner", "supervisor", "worker"]),
  role: z.string().optional(),
  reportsTo: z.string().nullable(),
  workspaceId: z.string().nullable(),
  retired: z.boolean(),
  agentConfig: configSchema.optional(),
  occupant: occupantSchema.optional(),
  pastOccupants: z
    .array(
      occupantSchema.extend({
        paseoAgentId: z.string(),
        retiredAt: z.string(),
        reason: z.string(),
      }),
    )
    .optional(),
  // Why the seat's agent will be replaced when mail next wakes it.
  pending: z.object({ kind: z.string(), reason: z.string() }).nullable().optional(),
  // The agent the seat is bringing in before it binds it.
  arrivingAgentId: z.string().nullable().optional(),
});
export type RosterSeat = z.infer<typeof rosterSeatSchema>;

export const rosterSchema = z.object({
  agents: z.array(rosterSeatSchema),
  swarms: z
    .array(z.object({ id: z.string(), name: z.string(), projectId: z.string().nullable() }))
    .optional(),
});
export type Roster = z.infer<typeof rosterSchema>;

// Every seat of every swarm on the host, reserved seats included. The sidebar and seat tabs share
// this query, so they agree on each seat's occupant.
export function useSwarmRoster(plugin: InstalledPlugin | null) {
  return useFetchQuery(
    {
      queryKey: ["swarm", "roster", plugin?.serverId ?? ""],
      queryFn: async () => {
        if (!plugin) throw new Error("Paseo Swarm plugin is not installed on this host");
        return rosterSchema.parse(
          await plugin.invoke("swarm.board.read", { includeReserved: true }),
        );
      },
      enabled: plugin !== null,
      refetchInterval: 3000,
      dataShape: "value",
      staleTimeMs: 2500,
    },
    plugin?.queryClient,
  );
}

export function useSwarmSeat(plugin: InstalledPlugin | null, seatId: string) {
  const query = useSwarmRoster(plugin);
  return {
    seat: query.data?.agents.find((agent) => agent.id === seatId) ?? null,
    isPending: query.isPending,
    error: query.error,
  };
}

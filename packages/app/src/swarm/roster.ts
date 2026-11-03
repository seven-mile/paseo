import { useMemo } from "react";
import { z } from "zod";
import { useFetchQuery } from "@/data/query";
import type { InstalledPlugin } from "@/plugins/types";
import { SWARM_POLL_MS, selectSwarmValue, swarmConditionalQuery } from "./sync";

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

// A seat as the roster lists it. The plugin's seat summary is the source.
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
  // Why the seat's agent will be replaced when mail next wakes it.
  pending: z.object({ kind: z.string(), reason: z.string() }).nullable().optional(),
});
export type RosterSeat = z.infer<typeof rosterSeatSchema>;

// One seat with its occupants, as its seat tab reads it.
export const swarmSeatSchema = rosterSeatSchema.extend({
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
  // The agent the seat is bringing in before it binds it.
  arrivingAgentId: z.string().nullable().optional(),
});
export type SwarmSeat = z.infer<typeof swarmSeatSchema>;

export const rosterSchema = z.object({
  agents: z.array(rosterSeatSchema),
  swarms: z.array(z.object({ id: z.string(), name: z.string(), projectId: z.string().nullable() })),
  // Swarm features the host supports; absent on older hosts.
  features: z.array(z.string()).optional(),
});
export type Roster = z.infer<typeof rosterSchema>;

export function swarmRosterKey(serverId: string) {
  return ["swarm", "roster", serverId];
}

export function swarmSeatKey(serverId: string, seatId: string) {
  return ["swarm", "seat", serverId, seatId];
}

function requirePlugin(plugin: InstalledPlugin | null): InstalledPlugin {
  if (!plugin) throw new Error("Paseo Swarm plugin is not installed on this host");
  return plugin;
}

// The seats that are not retired, in every swarm on the host.
export function useSwarmRoster(plugin: InstalledPlugin) {
  const rosterKey = useMemo(() => swarmRosterKey(plugin.serverId), [plugin.serverId]);
  return useFetchQuery(
    {
      queryKey: rosterKey,
      queryFn: swarmConditionalQuery({
        queryClient: plugin.queryClient,
        queryKey: rosterKey,
        schema: rosterSchema,
        read: (etag) => plugin.invoke("swarm.roster.read", etag ? { etag } : {}),
      }),
      select: selectSwarmValue<Roster>,
      refetchInterval: SWARM_POLL_MS,
      dataShape: "value",
      staleTimeMs: SWARM_POLL_MS - 500,
    },
    plugin.queryClient,
  );
}

const seatReadSchema = z.object({ seat: swarmSeatSchema.nullable() });
type SeatRead = z.infer<typeof seatReadSchema>;

// One seat and its occupants, retired seats included. A poll whose etag still holds costs a few
// hundred bytes, so a seat tab can follow its occupant without reading the roster.
export function useSwarmSeat(plugin: InstalledPlugin | null, seatId: string) {
  const serverId = plugin?.serverId ?? "";
  const seatKey = useMemo(() => swarmSeatKey(serverId, seatId), [seatId, serverId]);
  const query = useFetchQuery(
    {
      queryKey: seatKey,
      queryFn: swarmConditionalQuery({
        queryClient: plugin?.queryClient,
        queryKey: seatKey,
        schema: seatReadSchema,
        read: (etag) =>
          requirePlugin(plugin).invoke("swarm.seat.read", { seatId, ...(etag ? { etag } : {}) }),
      }),
      select: selectSwarmValue<SeatRead>,
      enabled: plugin !== null && seatId.length > 0,
      refetchInterval: SWARM_POLL_MS,
      dataShape: "value",
      staleTimeMs: SWARM_POLL_MS - 500,
    },
    plugin?.queryClient,
  );
  return {
    seat: query.data?.seat ?? null,
    isPending: query.isPending,
    error: query.error,
  };
}

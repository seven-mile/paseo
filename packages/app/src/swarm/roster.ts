import { useMemo } from "react";
import { z } from "zod";
import { useFetchQuery } from "@/data/query";
import type { InstalledPlugin } from "@/plugins/types";
import { deliveredArtifactSchema } from "./artifact-model";
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

const handoverOccupantSchema = z.object({
  number: z.number(),
  paseoAgentId: z.string(),
  config: configSchema.optional(),
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
  // Every handover, oldest first. Daemons from before the log leave it out.
  handovers: z
    .array(
      z.object({
        at: z.string(),
        from: handoverOccupantSchema,
        to: handoverOccupantSchema,
        reason: z.string(),
        returning: z.boolean(),
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

// A delivery the seat addressed to the person, so its conversation shows the result without the
// seat repeating it.
const seatDeliverySchema = z.object({
  activityId: z.string(),
  swarmId: z.string(),
  taskId: z.string(),
  taskTitle: z.string(),
  as: z.enum(["to", "cc"]),
  taskState: z.string().optional(),
  body: z.string(),
  // The artifacts it carried; absent when none, and on hosts from before artifacts.
  artifacts: z.array(deliveredArtifactSchema).optional(),
  createdAt: z.string(),
});
// A delivery made without a Task, listed apart by the host.
const seatDirectDeliverySchema = seatDeliverySchema
  .omit({ taskId: true, taskTitle: true, taskState: true })
  .extend({ taskId: z.null() });
export type SeatDelivery =
  | z.infer<typeof seatDeliverySchema>
  | z.infer<typeof seatDirectDeliverySchema>;

const seatReadSchema = z.object({
  seat: swarmSeatSchema.nullable(),
  // Absent on hosts from before addressing.
  deliveries: z.array(seatDeliverySchema).optional(),
  // Absent on hosts from before deliveries without a Task.
  directDeliveries: z.array(seatDirectDeliverySchema).optional(),
});
type SeatRead = z.infer<typeof seatReadSchema>;
const NO_DELIVERIES: SeatDelivery[] = [];

// Both lists, newest first.
function seatDeliveries(read: SeatRead | undefined): SeatDelivery[] {
  if (!read?.directDeliveries?.length) return read?.deliveries ?? NO_DELIVERIES;
  return [...(read.deliveries ?? []), ...read.directDeliveries].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
}

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
  const deliveries = useMemo(() => seatDeliveries(query.data), [query.data]);
  return {
    seat: query.data?.seat ?? null,
    deliveries,
    isPending: query.isPending,
    error: query.error,
  };
}

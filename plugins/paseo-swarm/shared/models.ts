import { z } from "zod";
import { activityRefSchema } from "./refs";

export const roleClassSchema = z.enum(["planner", "supervisor", "worker"]);
export type RoleClass = z.infer<typeof roleClassSchema>;
export const responseProfileSchema = z.enum(["decision", "steering", "discussion"]);
export type ResponseProfile = z.infer<typeof responseProfileSchema>;

const metadataSchema = z.record(z.string(), z.unknown());
export const slugNameSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

// The agent config a seat wants its Paseo agent to run: the provider and settings that
// swarm_seat_create takes. `provider` is "provider" or "provider/model". A field left out is
// not compared, so a seat can pin only its provider. server/seat-policy.ts decides what a
// difference from the running agent costs.
export const agentConfigSchema = z.object({
  provider: z.string().min(1).optional(),
  modeId: z.string().min(1).optional(),
  thinkingOptionId: z.string().min(1).optional(),
  featureValues: z.record(z.string(), z.unknown()).optional(),
});
export type AgentConfig = z.infer<typeof agentConfigSchema>;

// The Paseo agent currently bound to a seat, stamped with the config Swarm last gave it: what it
// booted with, plus seat edits applied in place since. Changes made in the agent's own chat are
// drift and never reach the stamp.
export const occupantSchema = z.object({
  number: z.number().int().positive(),
  config: agentConfigSchema,
  generation: z.number().int().nonnegative(),
  boundAt: z.string(),
});
export type Occupant = z.infer<typeof occupantSchema>;

const receivedPromptSchema = z.object({
  revision: z.string(),
  pwaRevision: z.string(),
  receivedAt: z.string(),
});

// Its standing prompt is kept so that, brought back, it gets the current one only if it differs.
export const pastOccupantSchema = occupantSchema.extend({
  paseoAgentId: z.string(),
  retiredAt: z.string(),
  reason: z.string(),
  prompt: receivedPromptSchema.optional(),
});
export type PastOccupant = z.infer<typeof pastOccupantSchema>;

// One side of a handover: the occupant and the config Swarm had stamped on it at the time.
const handoverOccupantSchema = z.object({
  number: z.number().int().positive(),
  paseoAgentId: z.string(),
  config: agentConfigSchema,
});

// A handover moves a seat from one occupant to the next. The log is only appended to. The
// occupant fields cannot stand in for it: pastOccupants keeps one entry per agent, so a returning
// occupant's earlier stint and the order of stints are gone.
export const handoverSchema = z.object({
  at: z.string(),
  from: handoverOccupantSchema,
  to: handoverOccupantSchema,
  reason: z.string(),
  // The incoming occupant held the seat before, so it remembers its own earlier turns.
  returning: z.boolean(),
});
export type Handover = z.infer<typeof handoverSchema>;

// An agent record is a seat: its id, name, role, Tasks and mailbox outlive the Paseo agent
// in paseoAgentId, which is the current occupant and changes when the occupant goes stale.
// A reserved seat has no occupant yet; its first mail starts one.
export const agentRecordSchema = z.object({
  id: z.string(),
  swarmId: z.string(),
  paseoAgentId: z.string().nullable(),
  name: slugNameSchema,
  qualifiedName: z.string().optional(),
  aliases: z.array(z.string()),
  roleClass: roleClassSchema,
  role: z.string(),
  reportsTo: z.string().nullable(),
  workspaceId: z.string().nullable(),
  projectId: z.string().optional(),
  // The standing prompt the agent last received, at creation or through a refresh.
  prompt: receivedPromptSchema.optional(),
  // Desired state. Reset bumps generation, so no agent from before the reset is reused.
  agentConfig: agentConfigSchema.optional(),
  generation: z.number().int().nonnegative().optional(),
  // Absent on a reserved seat, and on records made before seats, which read as occupant 1 with an
  // unknown config.
  occupant: occupantSchema.optional(),
  pastOccupants: z.array(pastOccupantSchema).optional(),
  // Oldest first. Absent on records made before the log; handoverLog derives what it can.
  handovers: z.array(handoverSchema).optional(),
  retired: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AgentRecord = z.infer<typeof agentRecordSchema>;

export function agentQualifiedName(agent: Pick<AgentRecord, "name" | "qualifiedName">): string {
  return agent.qualifiedName ?? agent.name;
}

export function currentOccupant(agent: Pick<AgentRecord, "occupant" | "createdAt">): Occupant {
  return agent.occupant ?? { number: 1, config: {}, generation: 0, boundAt: agent.createdAt };
}

// The seat's handovers, oldest first. A record made before the log gets the handovers its
// occupant fields still show: Swarm stamps the outgoing occupant's retiredAt with the incoming
// one's boundAt, so each past occupant pairs with the one that replaced it, unless that one has
// since been replaced in turn by a return.
export function handoverLog(
  seat: Pick<
    AgentRecord,
    "handovers" | "paseoAgentId" | "occupant" | "pastOccupants" | "createdAt"
  >,
): Handover[] {
  if (seat.handovers) return seat.handovers;
  const past = seat.pastOccupants ?? [];
  const occupants: Array<Occupant & { paseoAgentId: string }> = [
    ...past,
    ...(seat.paseoAgentId ? [{ ...currentOccupant(seat), paseoAgentId: seat.paseoAgentId }] : []),
  ];
  return past
    .flatMap((outgoing): Handover[] => {
      const incoming = occupants.find(
        (occupant) =>
          occupant.paseoAgentId !== outgoing.paseoAgentId &&
          occupant.boundAt === outgoing.retiredAt,
      );
      if (!incoming) return [];
      return [
        {
          at: outgoing.retiredAt,
          from: handoverSide(outgoing),
          to: handoverSide(incoming),
          reason: outgoing.reason,
          returning: incoming.number < outgoing.number,
        },
      ];
    })
    .sort((a, b) => a.at.localeCompare(b.at));
}

export function handoverSide(
  occupant: Pick<Occupant, "number" | "config"> & { paseoAgentId: string },
): Handover["from"] {
  return { number: occupant.number, paseoAgentId: occupant.paseoAgentId, config: occupant.config };
}

// "claude/opus" belongs to provider "claude". Modes, thinking options and feature values are
// defined per provider, so they mean nothing to another one.
export function providerFamily(provider: string): string {
  return provider.split("/")[0];
}

// How a Task's commitment ended. Absent while the Task is open. Swarm reads only this to know a
// Task is finished; status is the PWA's vocabulary, which Swarm never interprets. done comes from a
// delivery that completes the Task; the others are dispositions that need no result.
export const taskResolutionSchema = z.enum(["done", "wont-do", "duplicate", "superseded"]);
export type TaskResolution = z.infer<typeof taskResolutionSchema>;

// A Task id is unique within its swarm. managerName is the owner: the one seat responsible for
// the Task day to day. The owner and every seat above it may change it. createdBy is provenance
// and workerNames a record of who works on it; neither grants anything.
export const taskSchema = z.object({
  id: slugNameSchema,
  swarmId: z.string(),
  title: z.string(),
  brief: z.string(),
  status: z.string(),
  managerName: z.string(),
  workerNames: z.array(z.string()),
  createdBy: z.string(),
  data: metadataSchema,
  resolution: taskResolutionSchema.optional(),
  duplicateOf: slugNameSchema.optional(),
  // The Task that replaced this one, when it was closed as superseded and the replacement is known.
  supersededBy: slugNameSchema.optional(),
  resolvedAt: z.string().optional(),
  // Who closed it: the owner's delivery, or the seat that closed it without a result.
  resolvedBy: z.string().optional(),
  // When the brief was last written. Human notes after it are instructions the owner has not yet
  // folded into the brief. Absent on Tasks from before it was recorded.
  briefUpdatedAt: z.string().optional(),
  // Who asked for the work: "human" or a seat. createdBy is who wrote the record, which differs
  // when work already underway is recorded later. Absent on older Tasks, which read as createdBy.
  requester: z.string().optional(),
  // The seat whose brief the owner has not confirmed yet: set when a seat other than the owner
  // records the Task without assigning it or rewrites its brief, and cleared when the owner writes
  // the brief or delivers.
  briefUnconfirmedBy: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Task = z.infer<typeof taskSchema>;

// The name a person goes by in an audience. It has no mailbox: the app shows what reaches it.
export const HUMAN = "human";

// Who a write reached, and why: requester, owner, manager (the owner's manager) and asker are
// defaults and system-added recipients; named is the sender's own list.
export const audienceEntrySchema = z.object({
  name: z.string(),
  as: z.enum(["to", "cc"]),
  why: z.enum(["requester", "owner", "manager", "asker", "named"]),
});
export type AudienceEntry = z.infer<typeof audienceEntrySchema>;

// What a delivery carried: an artifact it linked, and the artifact's content when it was delivered.
// A reader compares the hash with the artifact's current one to see whether it changed since.
export const deliveredArtifactSchema = z.object({
  id: slugNameSchema,
  contentHash: z.string(),
});
export type DeliveredArtifact = z.infer<typeof deliveredArtifactSchema>;

export const activitySchema = z.object({
  id: z.string(),
  swarmId: z.string(),
  // Null on deliveries made without a Task during the artifacts playtest. Nothing writes one now;
  // those records still parse, stay off the board and the seat read, and show in an artifact's
  // citations.
  taskId: slugNameSchema.nullable(),
  actorName: z.string(),
  actorKind: z.preprocess((value) => value ?? "agent", z.enum(["agent", "human"])),
  // Which occupant of the actor's seat wrote it, so a degraded agent's records can be found.
  actorOccupant: z.number().int().positive().optional(),
  replyTo: z.string().nullable().default(null),
  responseProfile: responseProfileSchema.nullable().default(null),
  kind: z.string(),
  body: z.string(),
  data: metadataSchema,
  refs: z.array(activityRefSchema).default([]),
  // Who the write reached. Absent when it reached no one, and on Activities from before addressing.
  audience: z.array(audienceEntrySchema).optional(),
  // The artifacts a delivery linked. Absent on other Activities and on deliveries that link none.
  artifacts: z.array(deliveredArtifactSchema).optional(),
  createdAt: z.string(),
});
export type Activity = z.infer<typeof activitySchema>;

// A result its author maintains and readers come back to, declared by the author with
// swarm_artifact_publish. The author keeps writing it in its own workspace; Swarm keeps a copy of
// the file and the attachments it needs in the swarm's artifacts directory, which outlives the
// worktrees that produced it. Readers always open that copy.
export const artifactSchema = z.object({
  id: slugNameSchema,
  swarmId: z.string(),
  title: z.string(),
  authorName: z.string(),
  // The Task it was made for, when there was one. Provenance only: the artifact can serve other
  // Tasks and outlive them, and a Task's result still comes from its deliveries.
  taskId: slugNameSchema.optional(),
  // Where the author maintains it: a file and the files or directories it needs, relative to the
  // author's workspace. The copy keeps these paths under the artifact's id, so relative links
  // between them still resolve.
  source: z.object({
    workspaceId: z.string(),
    path: z.string(),
    attachments: z.array(z.string()),
  }),
  // The hash of the copied content, and when it last changed.
  contentHash: z.string(),
  changedAt: z.string(),
  publishedAt: z.string(),
  updatedAt: z.string(),
});
export type Artifact = z.infer<typeof artifactSchema>;

// An Activity that asks the human to choose: data.action holds the question and its options.
export const choiceActionSchema = z.object({
  type: z.literal("choice"),
  prompt: z.string(),
  options: z
    .array(z.object({ id: z.string(), label: z.string(), description: z.string().optional() }))
    .min(1),
  responseProfiles: z.array(responseProfileSchema).min(1).optional(),
});

// The choices of one Task that no human Activity has replied to yet.
export function unansweredChoices<
  T extends Pick<Activity, "id" | "actorKind" | "replyTo" | "data">,
>(activities: readonly T[]): T[] {
  const answered = new Set(
    activities
      .filter((activity) => activity.actorKind === "human" && activity.replyTo)
      .map((activity) => activity.replyTo),
  );
  return activities.filter(
    (activity) =>
      choiceActionSchema.safeParse(activity.data.action).success && !answered.has(activity.id),
  );
}

export const messageKindSchema = z.enum(["team", "runtime", "human_activity"]);
export type MessageKind = z.infer<typeof messageKindSchema>;

export const mailboxMessageSchema = z.object({
  id: z.string(),
  recipientAgentId: z.string(),
  recipientName: z.string(),
  senderName: z.string(),
  taskId: z.string().nullable(),
  kind: messageKindSchema,
  prompt: z.string(),
  createdAt: z.string(),
  attempts: z.number().int().nonnegative(),
  lastError: z.string().nullable(),
  deliveredAt: z.string().nullable(),
  deliveredToPaseoAgentId: z.string().nullable(),
  consumedAt: z.string().nullable(),
  failedAt: z.string().nullable(),
  // Turn rows delivered together as one digest share this id, which is also the daemon messageId.
  batchId: z.string().optional(),
});
export type MailboxMessage = z.infer<typeof mailboxMessageSchema>;

export const mailboxStatusSchema = z.enum(["queued", "delivered", "consumed", "failed"]);
export type MailboxStatus = z.infer<typeof mailboxStatusSchema>;

export function mailboxMessageStatus(
  message: Pick<MailboxMessage, "deliveredAt" | "consumedAt" | "failedAt">,
): MailboxStatus {
  if (message.consumedAt) return "consumed";
  if (message.deliveredAt) return "delivered";
  if (message.failedAt) return "failed";
  return "queued";
}

// The PWA files a swarm last accepted, keyed by path within its directory: PWA.md and
// roles/<role>.md. Prompts are assembled from these, never from the directory, so an edit there
// reaches no agent until the swarm accepts it.
export const swarmSourceSchema = z.object({
  revision: z.string(),
  files: z.record(z.string(), z.string()),
});
export type SwarmSource = z.infer<typeof swarmSourceSchema>;

// A swarm instance: a directory that describes it, attached to one Paseo project. The id is
// minted here and is the swarm's identity; the directory is where it is found and can move.
export const swarmRecordSchema = z.object({
  id: z.string(),
  name: z.string(),
  directory: z.string(),
  // Null for a swarm of seats made with no project, before swarms.
  projectId: z.string().nullable(),
  source: swarmSourceSchema,
  // The Paseo workspace that shows the swarm's artifacts directory, made at the first publish.
  artifactsWorkspaceId: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SwarmRecord = z.infer<typeof swarmRecordSchema>;

// A seat change written to swarm.yaml and the accepted seats together. An add carries the new
// seat; an agent change carries the seat with its new agentConfig; a retirement carries the seat
// and the reason its queued mail fails with.
export const seatChangeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("add"), seat: agentRecordSchema }),
  z.object({ kind: z.literal("agent"), seat: agentRecordSchema }),
  z.object({ kind: z.literal("retire"), seat: agentRecordSchema, reason: z.string() }),
]);
export type SeatChange = z.infer<typeof seatChangeSchema>;

// A seat change in flight: committed before swarm.yaml is written and cleared with the accepted
// changes, so a crash between the two is recovered from the file's hash. `conflict` is set when
// the file matches neither side; the swarm then takes no seat change until the user resolves it.
export const specIntentSchema = z.object({
  id: z.string(),
  swarmId: z.string(),
  oldHash: z.string(),
  newHash: z.string(),
  changes: z.array(seatChangeSchema),
  conflict: z.string().nullable(),
  createdAt: z.string(),
});
export type SpecIntent = z.infer<typeof specIntentSchema>;

// version is the board's wire format, which clients read; the store's own format is the version
// of its snapshot (server/state.ts).
export const stateSchema = z.object({
  version: z.literal(1),
  swarms: z.array(swarmRecordSchema).default([]),
  agents: z.array(agentRecordSchema),
  tasks: z.array(taskSchema),
  activities: z.array(activitySchema),
  messages: z.array(mailboxMessageSchema).default([]),
  intents: z.array(specIntentSchema).default([]),
  artifacts: z.array(artifactSchema).default([]),
});
export type SwarmState = z.infer<typeof stateSchema>;
// What the board shows; the mailbox is read through its own RPC.
export type SwarmBoard = Pick<SwarmState, "version" | "agents" | "tasks" | "activities">;

export function emptyState(): SwarmState {
  return {
    version: 1,
    swarms: [],
    agents: [],
    tasks: [],
    activities: [],
    messages: [],
    intents: [],
    artifacts: [],
  };
}

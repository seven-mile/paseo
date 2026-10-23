import { z } from "zod";
import { activityRefSchema } from "./refs";

export const roleClassSchema = z.enum(["planner", "supervisor", "worker"]);
export type RoleClass = z.infer<typeof roleClassSchema>;
export const responseProfileSchema = z.enum(["decision", "steering", "discussion"]);
export type ResponseProfile = z.infer<typeof responseProfileSchema>;

const metadataSchema = z.record(z.string(), z.unknown());
export const slugNameSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

// The agent config a seat wants its Paseo agent to run: the provider and settings that
// swarm_agent_create takes. `provider` is "provider" or "provider/model". A field left out is
// not compared, so a seat can pin only its provider. server/seat-policy.ts decides what a
// difference from the running agent costs.
export const agentConfigSchema = z.object({
  provider: z.string().min(1).optional(),
  modeId: z.string().min(1).optional(),
  thinkingOptionId: z.string().min(1).optional(),
  featureValues: z.record(z.string(), z.unknown()).optional(),
});
export type AgentConfig = z.infer<typeof agentConfigSchema>;

// The Paseo agent currently bound to a seat, stamped with the config it runs: what it booted with,
// plus changes made in place since, from a seat edit or from its own chat.
export const occupantSchema = z.object({
  number: z.number().int().positive(),
  config: agentConfigSchema,
  generation: z.number().int().nonnegative(),
  boundAt: z.string(),
});
export type Occupant = z.infer<typeof occupantSchema>;

export const pastOccupantSchema = occupantSchema.extend({
  paseoAgentId: z.string(),
  retiredAt: z.string(),
  reason: z.string(),
});
export type PastOccupant = z.infer<typeof pastOccupantSchema>;

// An agent record is a seat: its id, name, role, Tasks and mailbox outlive the Paseo agent
// in paseoAgentId, which is the current occupant and changes when the occupant goes stale.
export const agentRecordSchema = z.object({
  id: z.string(),
  paseoAgentId: z.string(),
  name: slugNameSchema,
  qualifiedName: z.string().optional(),
  aliases: z.array(z.string()),
  roleClass: roleClassSchema,
  role: z.string(),
  reportsTo: z.string().nullable(),
  workspaceId: z.string().nullable(),
  projectId: z.string().optional(),
  // The standing prompt the agent last received, at creation or through a refresh.
  prompt: z
    .object({ revision: z.string(), pwaRevision: z.string(), receivedAt: z.string() })
    .optional(),
  // Desired state. Reset bumps generation, so no agent from before the reset is reused.
  agentConfig: agentConfigSchema.optional(),
  generation: z.number().int().nonnegative().optional(),
  // Absent on records made before seats; read as occupant 1 with an unknown config.
  occupant: occupantSchema.optional(),
  pastOccupants: z.array(pastOccupantSchema).optional(),
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

// "claude/opus" belongs to provider "claude". Modes, thinking options and feature values are
// defined per provider, so they mean nothing to another one.
export function providerFamily(provider: string): string {
  return provider.split("/")[0];
}

export const taskSchema = z.object({
  id: slugNameSchema,
  title: z.string(),
  brief: z.string(),
  status: z.string(),
  managerName: z.string(),
  workerNames: z.array(z.string()),
  createdBy: z.string(),
  data: metadataSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Task = z.infer<typeof taskSchema>;

export const activitySchema = z.object({
  id: z.string(),
  taskId: slugNameSchema,
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
  createdAt: z.string(),
});
export type Activity = z.infer<typeof activitySchema>;

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

export const stateSchema = z.object({
  version: z.literal(1),
  agents: z.array(agentRecordSchema),
  tasks: z.array(taskSchema),
  activities: z.array(activitySchema),
  messages: z.array(mailboxMessageSchema).default([]),
});
export type SwarmState = z.infer<typeof stateSchema>;
// What the board shows; the mailbox is read through its own RPC.
export type SwarmBoard = Omit<SwarmState, "messages">;

export function emptyState(): SwarmState {
  return { version: 1, agents: [], tasks: [], activities: [], messages: [] };
}

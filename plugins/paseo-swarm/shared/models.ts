import { z } from "zod";
import { activityRefSchema } from "./refs";

export const roleClassSchema = z.enum(["planner", "supervisor", "worker"]);
export type RoleClass = z.infer<typeof roleClassSchema>;
export const responseProfileSchema = z.enum(["decision", "steering", "discussion"]);
export type ResponseProfile = z.infer<typeof responseProfileSchema>;

const metadataSchema = z.record(z.string(), z.unknown());
export const slugNameSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

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
  retired: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AgentRecord = z.infer<typeof agentRecordSchema>;

export function agentQualifiedName(agent: Pick<AgentRecord, "name" | "qualifiedName">): string {
  return agent.qualifiedName ?? agent.name;
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

// Remote effects a Swarm member must get human approval for. The gate classifies shell commands
// into these; a PWA can narrow the set with its `approvals` frontmatter list.
export const approvalActionSchema = z.enum([
  "push",
  "pr_create",
  "pr_ready",
  "pr_merge",
  "mr_create",
  "mr_merge",
]);
export type ApprovalAction = z.infer<typeof approvalActionSchema>;

// pending: waiting on a human. approved: allowed after the command gave up waiting; the next
// identical command consumes it. consumed: a command ran on it. denied: refused, with feedback.
export const approvalStatusSchema = z.enum(["pending", "approved", "consumed", "denied"]);
export type ApprovalStatus = z.infer<typeof approvalStatusSchema>;

export const approvalSchema = z.object({
  id: z.string(),
  // Roster id and Paseo agent of the member whose command is held.
  agentId: z.string(),
  paseoAgentId: z.string(),
  agentName: z.string(),
  taskId: z.string().nullable(),
  action: approvalActionSchema,
  command: z.array(z.string()),
  cwd: z.string(),
  // Same agent, action, directory and arguments: a rerun matches the approval it waited on.
  fingerprint: z.string(),
  status: approvalStatusSchema,
  // The permission raised on the agent, so answering either surface clears the other.
  permissionId: z.string().nullable(),
  feedback: z.string().nullable(),
  createdAt: z.string(),
  resolvedAt: z.string().nullable(),
});
export type Approval = z.infer<typeof approvalSchema>;

export const stateSchema = z.object({
  version: z.literal(1),
  agents: z.array(agentRecordSchema),
  tasks: z.array(taskSchema),
  activities: z.array(activitySchema),
  messages: z.array(mailboxMessageSchema).default([]),
  approvals: z.array(approvalSchema).default([]),
});
export type SwarmState = z.infer<typeof stateSchema>;
// What the board shows; the mailbox and approvals reach it through their own views.
export type SwarmBoard = Omit<SwarmState, "messages" | "approvals">;

export function emptyState(): SwarmState {
  return { version: 1, agents: [], tasks: [], activities: [], messages: [], approvals: [] };
}

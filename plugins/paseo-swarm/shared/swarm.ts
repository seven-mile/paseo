import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import {
  activitySchema,
  agentRecordSchema,
  mailboxMessageSchema,
  mailboxStatusSchema,
  responseProfileSchema,
  roleClassSchema,
  slugNameSchema,
  taskSchema,
} from "./models";

// A seat with the work its next mail carries out first, or null when its agent fits the seat. The
// kind is what happens to the agent, or refresh when only its standing prompt is out of date; the
// reason says when a refresh follows the change.
export const seatSchema = agentRecordSchema.extend({
  pending: z
    .object({
      kind: z.enum(["start", "adjust", "revive", "replace", "refresh"]),
      reason: z.string(),
    })
    .nullable(),
});

// What `up` does to a swarm's accepted state, or would do. Refusals stop the whole plan.
export const rosterPlanSchema = z.object({
  reserve: z.array(z.object({ seat: z.string(), role: z.string() })),
  // Retired seats the file names again; they come back with their Tasks and history.
  restore: z.array(z.object({ seat: z.string(), changes: z.array(z.string()) })),
  update: z.array(z.object({ seat: z.string(), changes: z.array(z.string()) })),
  // Each retiring seat with the Tasks that name it and the mail that will fail.
  retire: z.array(
    z.object({ seat: z.string(), tasks: z.array(z.string()), queuedMessages: z.number() }),
  ),
  // PWA files that changed, and the occupants whose standing prompt changes with them.
  source: z.object({ files: z.array(z.string()), prompts: z.array(z.string()) }).nullable(),
  refusals: z.array(z.string()),
});
export type RosterPlan = z.infer<typeof rosterPlanSchema>;

const swarmSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  directory: z.string(),
  projectId: z.string().nullable(),
  revision: z.string(),
});

const swarmScopeSchema = {
  swarmId: z.string().min(1).optional(),
  projectId: z.string().min(1).optional(),
};

// Accepts the swarm directory, or with dryRun shows what accepting it would do (`swarm diff`). A
// plan with refusals is not applied, and up fails with them.
export const directoryUpRpc = defineRpc({
  name: "swarm.directory.up",
  input: z.object({ ...swarmScopeSchema, dryRun: z.boolean().default(false) }),
  output: z.object({ swarm: swarmSummarySchema, plan: rosterPlanSchema }),
});

// Unapplied directory changes, and the occupant work each seat's next mail carries out.
export const statusReadRpc = defineRpc({
  name: "swarm.status.read",
  input: z.object(swarmScopeSchema),
  output: z.object({
    swarm: swarmSummarySchema,
    unapplied: rosterPlanSchema.nullable(),
    // Why the directory cannot be accepted as it stands.
    invalid: z.string().nullable(),
    // A seat change a crash left half written, which `recover` resolves.
    recovery: z.string().nullable(),
    seats: z.array(seatSchema),
  }),
});

export const directoryRecoverRpc = defineRpc({
  name: "swarm.directory.recover",
  input: z.object({ ...swarmScopeSchema, keep: z.enum(["file", "intent"]) }),
  output: z.object({ swarm: swarmSummarySchema, seats: z.array(z.string()) }),
});

export const boardReadRpc = defineRpc({
  name: "swarm.board.read",
  input: z.object({
    projectId: z.string().min(1).optional(),
    swarmId: z.string().min(1).optional(),
  }),
  output: z.object({
    version: z.literal(1),
    agents: z.array(seatSchema),
    tasks: z.array(taskSchema),
    activities: z.array(activitySchema),
    statuses: z.array(z.string()).optional(),
  }),
});

export const pwaSourceReadRpc = defineRpc({
  name: "swarm.pwa_source.read",
  input: z.object({ projectId: z.string().min(1).optional() }),
  output: z.object({ path: z.string().nullable() }),
});

export const pwaSourceSetRpc = defineRpc({
  name: "swarm.pwa_source.set",
  input: z.object({ path: z.string().min(1), projectId: z.string().min(1).optional() }),
  output: z.object({ path: z.string() }),
});

export const pwaRolesReadRpc = defineRpc({
  name: "swarm.pwa_roles.read",
  input: z.object({
    swarmId: z.string().min(1).optional(),
    roleClass: roleClassSchema.optional(),
    path: z.string().min(1).optional(),
    projectId: z.string().min(1).optional(),
  }),
  output: z.array(
    z.object({
      role: z.string(),
      roleClass: roleClassSchema,
      title: z.string(),
      description: z.string(),
    }),
  ),
});

// Reserves a seat. It has no agent until its first mail arrives, which starts one with the seat's
// agentConfig, so provider is "provider/model".
export const createSeatRpc = defineRpc({
  name: "swarm.seat.create",
  input: z.object({
    swarmId: z.string().min(1).optional(),
    projectId: z.string().min(1).optional(),
    name: slugNameSchema,
    aliases: z.array(z.string()).default([]),
    roleClass: z.enum(["planner", "supervisor", "worker"]),
    role: z.string().min(1),
    reportsTo: z.string().nullable().default(null),
    title: z.string().optional(),
    provider: z.string().min(1),
    modeId: z.string().optional(),
    thinkingOptionId: z.string().optional(),
    featureValues: z.record(z.string(), z.unknown()).optional(),
    // The seat that asks, when an agent asks; it becomes the manager unless reportsTo says otherwise.
    actorName: z.string().nullable().default(null),
    workspaceId: z.string().nullable().default(null),
  }),
  output: seatSchema,
});

export const refreshPromptRpc = defineRpc({
  name: "swarm.agent.refresh_prompt",
  input: z.object({ paseoAgentId: z.string().min(1) }),
  output: z.object({
    revision: z.string(),
    previousRevision: z.string().nullable(),
    changed: z.boolean(),
    prompt: z.string(),
  }),
});

export const createTaskRpc = defineRpc({
  name: "swarm.task.create",
  input: z.object({
    swarmId: z.string().min(1).optional(),
    id: slugNameSchema,
    title: z.string().min(1),
    brief: z.string().min(1),
    status: z.string().min(1),
    managerName: z.string().min(1),
    workerNames: z.array(z.string()).default([]),
    createdBy: z.string().min(1),
    data: z.record(z.string(), z.unknown()).default({}),
  }),
  output: taskSchema,
});

export const updateTaskRpc = defineRpc({
  name: "swarm.task.update",
  input: z.object({
    swarmId: z.string().min(1).optional(),
    taskId: slugNameSchema,
    actorName: z.string(),
    status: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
    brief: z.string().min(1).optional(),
    workerNames: z.array(z.string()).optional(),
    data: z.record(z.string(), z.unknown()).optional(),
  }),
  output: taskSchema,
});

export const appendActivityRpc = defineRpc({
  name: "swarm.activity.append",
  input: z.object({
    swarmId: z.string().min(1).optional(),
    taskId: slugNameSchema,
    actorName: z.string(),
    replyTo: z.string().nullable().default(null),
    responseProfile: responseProfileSchema.nullable().default(null),
    kind: z.string().min(1),
    body: z.string().min(1),
    data: z.record(z.string(), z.unknown()).default({}),
  }),
  output: activitySchema,
});

export const appendHumanActivityRpc = defineRpc({
  name: "swarm.activity.append_human",
  input: z.object({
    projectId: z.string().min(1).optional(),
    swarmId: z.string().min(1).optional(),
    taskId: slugNameSchema,
    actorName: z.string().min(1).default("human"),
    replyTo: z.string().nullable().default(null),
    responseProfile: responseProfileSchema.nullable().default(null),
    kind: z.string().min(1),
    body: z.string().min(1),
    data: z.record(z.string(), z.unknown()).default({}),
  }),
  output: activitySchema.extend({ notificationWarning: z.string().optional() }),
});

export const sendMessageRpc = defineRpc({
  name: "swarm.message.send",
  input: z.object({
    swarmId: z.string().min(1).optional(),
    taskId: slugNameSchema.nullable().default(null),
    actorName: z.string().nullable().default(null),
    senderName: z.string().min(1),
    recipientName: z.string().min(1),
    body: z.string().min(1),
  }),
  output: z.object({
    delivered: z.boolean(),
    messageId: z.string(),
    status: mailboxStatusSchema,
    receipt: z.string(),
  }),
});

export const mailboxReadRpc = defineRpc({
  name: "swarm.mailbox.read",
  input: z.object({
    swarmId: z.string().min(1).optional(),
    recipientName: z.string().min(1).optional(),
    senderName: z.string().min(1).optional(),
    status: mailboxStatusSchema.optional(),
    limit: z.number().int().positive().max(500).default(100),
  }),
  output: z.object({
    messages: z.array(mailboxMessageSchema.extend({ status: mailboxStatusSchema })),
  }),
});

export const seatListRpc = defineRpc({
  name: "swarm.seat.list",
  input: z.object({
    swarmId: z.string().min(1).optional(),
    projectId: z.string().min(1).optional(),
    includeRetired: z.boolean().default(false),
    // Only the seat this Paseo agent occupies, or is arriving in while its session opens. With
    // includeRetired, else the seat it occupied before that seat retired or replaced it.
    paseoAgentId: z.string().min(1).optional(),
  }),
  output: z.object({ seats: z.array(seatSchema) }),
});

// Seats are named by roster id or qualified name. Fields set to null are cleared.
const seatReferencesSchema = z.array(z.string().min(1)).min(1);

export const seatUpdateRpc = defineRpc({
  name: "swarm.seat.update",
  input: z.object({
    swarmId: z.string().min(1).optional(),
    seats: seatReferencesSchema,
    agentConfig: z.object({
      provider: z.string().min(1).nullable().optional(),
      modeId: z.string().min(1).nullable().optional(),
      thinkingOptionId: z.string().min(1).nullable().optional(),
      featureValues: z.record(z.string(), z.unknown()).nullable().optional(),
    }),
    dryRun: z.boolean().default(false),
  }),
  output: z.object({ seats: z.array(seatSchema) }),
});

export const seatResetRpc = defineRpc({
  name: "swarm.seat.reset",
  input: z.object({
    swarmId: z.string().min(1).optional(),
    seats: seatReferencesSchema,
    // Withdraws a Reset that has not taken effect yet.
    cancel: z.boolean().default(false),
    dryRun: z.boolean().default(false),
  }),
  output: z.object({ seats: z.array(seatSchema) }),
});

// Retires a seat that has no active team: it leaves swarm.yaml, and its queued mail fails.
export const seatRetireRpc = defineRpc({
  name: "swarm.seat.retire",
  input: z.object({
    swarmId: z.string().min(1).optional(),
    seat: z.string().min(1),
    // Set when an agent retires: planners retire any seat, others the seats that report to them.
    actorName: z.string().min(1).optional(),
  }),
  output: z.object({ seat: seatSchema }),
});

export const seatHistoryReadRpc = defineRpc({
  name: "swarm.seat.history.read",
  input: z.object({
    swarmId: z.string().min(1).optional(),
    seat: z.string().min(1),
    // Set when an agent reads: planners read any seat, others their own and the seats under them.
    actorName: z.string().min(1).optional(),
    // An occupant number; defaults to the current occupant.
    occupant: z.number().int().positive().optional(),
    before: z.string().min(1).optional(),
    limit: z.number().int().positive().max(200).default(40),
  }),
  output: z.object({
    seat: z.string(),
    occupant: z.number().int().positive(),
    paseoAgentId: z.string(),
    entries: z.array(z.object({ type: z.string(), text: z.string() })),
    nextBefore: z.string().nullable(),
  }),
});

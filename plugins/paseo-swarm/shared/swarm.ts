import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import {
  activitySchema,
  agentRecordSchema,
  artifactSchema,
  audienceEntrySchema,
  mailAttachmentSchema,
  mailboxMessageSchema,
  mailboxStatusSchema,
  responseProfileSchema,
  roleClassSchema,
  slugNameSchema,
  taskResolutionSchema,
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
  // The agent the seat is bringing in, until it binds it. Absent from older hosts.
  arrivingAgentId: z.string().nullable().optional(),
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
  // The swarm's name, when swarm.yaml gives it a new one. Absent from older hosts.
  name: z.object({ from: z.string(), to: z.string() }).nullable().optional(),
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

// The directory commands also take the CLI's working directory, on a local daemon only, to find
// the swarm when neither swarmId nor projectId names it.
const directoryScopeSchema = {
  ...swarmScopeSchema,
  cwd: z.string().min(1).optional(),
};

// Accepts the swarm directory, or with dryRun shows what accepting it would do (`swarm diff`). A
// plan with refusals is not applied, and up fails with them.
export const directoryUpRpc = defineRpc({
  name: "swarm.directory.up",
  input: z.object({ ...directoryScopeSchema, dryRun: z.boolean().default(false) }),
  output: z.object({ swarm: swarmSummarySchema, plan: rosterPlanSchema }),
});

// Unapplied directory changes, and the occupant work each seat's next mail carries out.
export const statusReadRpc = defineRpc({
  name: "swarm.status.read",
  input: z.object(directoryScopeSchema),
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
  input: z.object({ ...directoryScopeSchema, keep: z.enum(["file", "intent"]) }),
  output: z.object({ swarm: swarmSummarySchema, seats: z.array(z.string()) }),
});

// Every record of the board. Agent tools read it in process; its answer grows with every Activity,
// so app surfaces, which poll across the network, use the conditional reads below.
export const boardReadRpc = defineRpc({
  name: "swarm.board.read",
  input: z.object({
    projectId: z.string().min(1).optional(),
    swarmId: z.string().min(1).optional(),
    // COMPAT(boardReservedSeats): added in v0.11.0, remove after 2027-01-26. Clients that read a
    // null paseoAgentId ask for seats with no agent yet; older clients would fail to parse them.
    includeReserved: z.boolean().optional(),
  }),
  output: z.object({
    version: z.literal(1),
    agents: z.array(seatSchema),
    tasks: z.array(taskSchema),
    activities: z.array(activitySchema),
    statuses: z.array(z.string()).optional(),
    // The swarms the board covers, so a client can tell teams with the same names apart.
    swarms: z
      .array(z.object({ id: z.string(), name: z.string(), projectId: z.string().nullable() }))
      .optional(),
    // SWARM_FEATURES; absent on hosts from before the list.
    features: z.array(z.string()).optional(),
  }),
});

// The reads clients poll. Each answers with the etag of what it would return; a request that
// already holds that etag gets data null instead of the same records again. A view is bounded by
// what one surface shows, so a change re-sends that surface's records, never the whole board.
const etagInputSchema = { etag: z.string().min(1).optional() };
const conditionalOutput = <T extends z.ZodTypeAny>(data: T) =>
  z.object({ etag: z.string(), data: data.nullable() });

const swarmRefSchema = z.object({
  id: z.string(),
  name: z.string(),
  projectId: z.string().nullable(),
  // The workspace that shows the swarm's artifact copies, which readers don't edit.
  artifactsWorkspaceId: z.string().optional(),
});

// Swarm features this host supports. A client offers a feature only when its name is listed;
// absent on hosts from before the list. "cc": messages and human notes take a cc list.
// "addressing": writes report their audience, and the seat read lists deliveries to the human.
// "board": the Task list reads its current view and a searchable history.
// "close": the human closes open Tasks as done without a delivery (swarm.tasks.close).
export const SWARM_FEATURES = ["cc", "addressing", "board", "close", "artifacts", "attachments"];
const featuresSchema = z.array(z.string()).optional();

// What a list or a link needs of a seat: no prompt receipts, occupant history or agent config.
export const seatSummarySchema = seatSchema.pick({
  id: true,
  swarmId: true,
  paseoAgentId: true,
  name: true,
  qualifiedName: true,
  aliases: true,
  roleClass: true,
  role: true,
  reportsTo: true,
  workspaceId: true,
  retired: true,
  pending: true,
});

// A Task as a list shows it: no brief or data, and how many of its choices wait for a human.
export const taskSummarySchema = taskSchema
  .pick({
    id: true,
    swarmId: true,
    title: true,
    status: true,
    managerName: true,
    workerNames: true,
    createdBy: true,
    updatedAt: true,
    resolution: true,
    resolvedAt: true,
    resolvedBy: true,
    duplicateOf: true,
    supersededBy: true,
  })
  .extend({ attention: z.number().int().nonnegative() });

// The seats that are not retired, in every swarm: the sidebar roster.
export const rosterReadRpc = defineRpc({
  name: "swarm.roster.read",
  input: z.object(etagInputSchema),
  output: conditionalOutput(
    z.object({
      agents: z.array(seatSummarySchema),
      swarms: z.array(swarmRefSchema),
      features: featuresSchema,
    }),
  ),
});

// The Task list of one swarm, or of every swarm when the request names none. Activities are read
// per Task.
// The board's views. current: open Tasks, Tasks done in the last few days, and any Task with a
// choice waiting for a human, whatever its age or resolution. history: every other closed Task,
// newest first, matching query. Without a view the list has every Task, as older clients expect.
export const DELIVERED_WINDOW_MS = 3 * 24 * 60 * 60_000;
export const TASK_HISTORY_PAGE = 50;

export const tasksReadRpc = defineRpc({
  name: "swarm.tasks.read",
  input: z.object({
    ...swarmScopeSchema,
    ...etagInputSchema,
    view: z.enum(["current", "history"]).optional(),
    query: z.string().optional(),
    limit: z.number().int().positive().max(200).optional(),
  }),
  output: conditionalOutput(
    z.object({
      agents: z.array(seatSummarySchema),
      tasks: z.array(taskSummarySchema),
      // The planner role's declared statuses, when the request scopes one swarm.
      statuses: z.array(z.string()),
      swarms: z.array(swarmRefSchema),
      features: featuresSchema,
    }),
  ),
});

// A delivery the seat addressed to the human, as its conversation lists it.
// Where readers open an artifact: its copy in the swarm's artifacts workspace. The link is the
// paseo-swarm://file link to that copy, which deliveries and documents use.
export const artifactLocationSchema = z.object({
  workspaceId: z.string(),
  path: z.string(),
  link: z.string(),
});

// An artifact a delivery carried, as its reader opens it now.
export const deliveredArtifactViewSchema = z.object({
  id: z.string(),
  title: z.string(),
  location: artifactLocationSchema.nullable(),
  // The artifact changed since this delivery.
  changed: z.boolean(),
});

export const seatDeliverySchema = z.object({
  activityId: z.string(),
  swarmId: z.string(),
  taskId: z.string(),
  taskTitle: z.string(),
  as: z.enum(["to", "cc"]),
  taskState: z.string().optional(),
  body: z.string(),
  // Absent when the delivery carried none, and on hosts from before artifacts.
  artifacts: z.array(deliveredArtifactViewSchema).optional(),
  createdAt: z.string(),
});

// One seat with its occupants, retired seats included: a seat tab. Data is a null seat when no
// seat has this id.
export const seatReadRpc = defineRpc({
  name: "swarm.seat.read",
  input: z.object({ seatId: z.string().min(1), ...etagInputSchema }),
  output: conditionalOutput(
    z.object({
      seat: seatSchema.nullable(),
      // The newest deliveries this seat addressed to the human. Absent from older hosts.
      deliveries: z.array(seatDeliverySchema).optional(),
    }),
  ),
});

export const TASK_ACTIVITY_PAGE = 100;
export const MAX_TASK_ACTIVITIES = 1000;

// One Task with its latest `limit` Activities, oldest first. Unanswered choices from before
// them are included too, so a person can always answer them.
export const taskReadRpc = defineRpc({
  name: "swarm.task.read",
  input: z.object({
    swarmId: z.string().min(1),
    taskId: z.string().min(1),
    limit: z.number().int().positive().max(MAX_TASK_ACTIVITIES).default(TASK_ACTIVITY_PAGE),
    ...etagInputSchema,
  }),
  output: conditionalOutput(
    z.object({
      task: taskSchema,
      // A delivery lists the artifacts it carried as readers open them now. Absent from older
      // hosts and from deliveries that carried none.
      activities: z.array(
        activitySchema.extend({
          deliveredArtifacts: z.array(deliveredArtifactViewSchema).optional(),
        }),
      ),
      // Activities before the oldest one returned, other than unanswered choices.
      olderCount: z.number().int().nonnegative(),
      // Tasks closed as a duplicate of this one or superseded by it. Absent from older hosts.
      absorbed: z
        .array(z.object({ id: z.string(), title: z.string(), resolution: z.string() }))
        .optional(),
    }),
  ),
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
    // Required, except on a record (assign: false), which may leave it to the owner. The Task then
    // stores an empty brief until the owner writes one.
    brief: z.string().min(1).optional(),
    status: z.string().min(1),
    managerName: z.string().min(1),
    workerNames: z.array(z.string()).default([]),
    createdBy: z.string().min(1),
    data: z.record(z.string(), z.unknown()).default({}),
    // Who asked for the work: "human" or a seat. Defaults to createdBy.
    requester: z.string().min(1).optional(),
    // false records work the owner already has: it gets a record notice, not an assignment.
    assign: z.boolean().default(true),
  }),
  output: taskSchema.extend({ audience: z.array(audienceEntrySchema).optional() }),
});

// The owner and every seat above it may update a Task. A new managerName reassigns it; a
// resolution other than done closes it without a result, and null reopens it.
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
    managerName: z.string().min(1).optional(),
    resolution: taskResolutionSchema.nullable().optional(),
    duplicateOf: slugNameSchema.optional(),
    // With resolution superseded: the Task that replaces this one.
    supersededBy: slugNameSchema.optional(),
    reason: z.string().min(1).optional(),
    // The briefUpdatedAt the writer read. A brief rewrite by anyone but the owner needs it, and a
    // rewrite is refused when the brief changed after it.
    briefBasedOn: z.string().min(1).optional(),
  }),
  // Who the change reached: the owner when another seat made it, a new owner, and the requester
  // when the Task closes without a result.
  output: taskSchema.extend({ audience: z.array(audienceEntrySchema).optional() }),
});

// Who a write goes to. Omit both for the defaults; give either and the two lists are the whole
// audience, so to: [] records without telling anyone. Names are seats, or "human".
const audienceInputSchema = {
  to: z.array(z.string().min(1)).optional(),
  cc: z.array(z.string().min(1)).optional(),
};

// The one way a result is recorded: a delivery Activity, with the Task's status and state changed
// in the same commit. taskState is the Task's state after the delivery: done closes it, open keeps
// it open or reopens it. revises names an earlier delivery this one corrects. A retry of the same
// submission returns the earlier delivery and notifies no one again.
export const deliverTaskRpc = defineRpc({
  name: "swarm.task.deliver",
  input: z.object({
    swarmId: z.string().min(1).optional(),
    taskId: slugNameSchema,
    actorName: z.string().min(1),
    result: z.string().min(1),
    taskState: z.enum(["done", "open"]),
    status: z.string().min(1).optional(),
    revises: z.string().min(1).nullable().default(null),
    ...audienceInputSchema,
  }),
  output: z.object({ task: taskSchema, activity: activitySchema, duplicate: z.boolean() }),
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
    ...audienceInputSchema,
  }),
  output: activitySchema,
});

// The human closes open Tasks as done without a delivery: accepting work as it stands, or clearing
// Tasks finished before Swarm recorded results. Each gets a change Activity with the reason. Owners
// hear of it unless quiet, which is for clearing old Tasks. Closing never interrupts a turn.
export const closeTasksRpc = defineRpc({
  name: "swarm.tasks.close",
  input: z.object({
    swarmId: z.string().min(1),
    taskIds: z.array(slugNameSchema).min(1).max(500),
    reason: z.string().min(1),
    quiet: z.boolean().default(false),
  }),
  output: z.object({
    closed: z.array(slugNameSchema),
    // Tasks that were already closed, left as they are.
    skipped: z.array(slugNameSchema),
  }),
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
    // Seats that get a copy for awareness. The Task's owner is always the recipient.
    cc: z.array(z.string().min(1)).default([]),
  }),
  output: activitySchema.extend({ notificationWarning: z.string().optional() }),
});

export const sendMessageRpc = defineRpc({
  name: "swarm.message.send",
  input: z
    .object({
      swarmId: z.string().min(1).optional(),
      taskId: slugNameSchema.nullable().default(null),
      actorName: z.string().nullable().default(null),
      senderName: z.string().min(1),
      recipientName: z.string().min(1),
      // Seats that get a copy for awareness: the copy names the recipient, so it asks nothing of them.
      cc: z.array(z.string().min(1)).default([]),
      // Empty only when the message carries images or attachments.
      body: z.string(),
      // Sent with the body to the recipient. A Cc seat's copy lists them instead, with a file path
      // for each image. Hosts list "attachments" in their features; older ones drop these fields.
      images: z
        .array(z.object({ data: z.string().min(1), mimeType: z.string().min(1) }))
        .default([]),
      attachments: z.array(mailAttachmentSchema).default([]),
    })
    .refine(
      (input) => input.body.length > 0 || input.images.length > 0 || input.attachments.length > 0,
      { message: "A message needs a body, an image, or an attachment", path: ["body"] },
    ),
  output: z.object({
    delivered: z.boolean(),
    messageId: z.string(),
    status: mailboxStatusSchema,
    receipt: z.string(),
    // Absent from hosts before Cc.
    cc: z
      .array(
        z.object({ recipient: z.string(), messageId: z.string(), status: mailboxStatusSchema }),
      )
      .optional(),
    // Absent from hosts before addressing.
    audience: z.array(audienceEntrySchema).optional(),
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

// A delivery that carried an artifact: who it reached, and whether the artifact changed since.
export const artifactDeliverySchema = z.object({
  activityId: z.string(),
  taskId: z.string().nullable(),
  actorName: z.string(),
  audience: z.array(audienceEntrySchema),
  changed: z.boolean(),
  createdAt: z.string(),
});

export const artifactViewSchema = artifactSchema.extend({
  location: artifactLocationSchema.nullable(),
  taskTitle: z.string().nullable(),
  deliveries: z.array(artifactDeliverySchema),
});

// Declares a file in the author's workspace as a maintained result, or updates one the author
// published before. Publishing records the declaration and copies the content; it tells no one.
export const publishArtifactRpc = defineRpc({
  name: "swarm.artifact.publish",
  input: z.object({
    swarmId: z.string().min(1).optional(),
    actorName: z.string().min(1),
    // The artifact to update; absent to publish a new one, or the one the path already holds.
    artifactId: slugNameSchema.optional(),
    path: z.string().min(1),
    title: z.string().min(1),
    attachments: z.array(z.string().min(1)).max(100).default([]),
    taskId: slugNameSchema.nullable().optional(),
  }),
  output: z.object({ artifact: artifactViewSchema, created: z.boolean() }),
});

export const readArtifactRpc = defineRpc({
  name: "swarm.artifact.read",
  input: z.object({
    swarmId: z.string().min(1).optional(),
    actorName: z.string().min(1).optional(),
    artifactId: slugNameSchema,
  }),
  output: artifactViewSchema,
});

// A swarm's artifacts, most recently changed first, for the Artifacts view.
export const artifactsReadRpc = defineRpc({
  name: "swarm.artifacts.read",
  input: z.object({ ...swarmScopeSchema, ...etagInputSchema }),
  output: conditionalOutput(z.object({ artifacts: z.array(artifactViewSchema) })),
});

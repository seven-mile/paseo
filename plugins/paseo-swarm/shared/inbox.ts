import { z } from "zod";
import { approvalActionSchema, responseProfileSchema, type Activity } from "./models";

// A choice Activity asks a human to pick an option. With a default and a deadline it stops
// blocking: when the deadline passes, Swarm records the default as the decision.
export const choiceActionSchema = z.object({
  type: z.literal("choice"),
  prompt: z.string().min(1),
  options: z
    .array(
      z.object({ id: z.string().min(1), label: z.string(), description: z.string().optional() }),
    )
    .min(1),
  responseProfiles: z.array(responseProfileSchema).min(1).optional(),
  defaultOptionId: z.string().min(1).optional(),
  // Accepted from agents on append and replaced by the absolute deadline it implies.
  timeoutMinutes: z.number().positive().optional(),
  deadline: z.string().optional(),
});
export type ChoiceAction = z.infer<typeof choiceActionSchema>;

export function activityChoice(activity: Pick<Activity, "data">): ChoiceAction | null {
  const result = choiceActionSchema.safeParse(activity.data.action);
  return result.success ? result.data : null;
}

export const DEFAULT_DECISION_KIND = "default-decision";

// A human reply answers a choice; so does the default Swarm records at the deadline.
export function answersChoice(activity: Pick<Activity, "actorKind" | "kind" | "replyTo">): boolean {
  return (
    activity.replyTo !== null &&
    (activity.actorKind === "human" || activity.kind === DEFAULT_DECISION_KIND)
  );
}

export function unansweredChoices<T extends Activity>(activities: readonly T[]): T[] {
  const answered = new Set(
    activities.filter(answersChoice).map((activity) => activity.replyTo as string),
  );
  return activities.filter((activity) => activityChoice(activity) && !answered.has(activity.id));
}

const inboxBase = {
  id: z.string(),
  taskId: z.string().nullable(),
  agentName: z.string().nullable(),
  paseoAgentId: z.string().nullable(),
  title: z.string(),
  createdAt: z.string(),
};

// Everything waiting on a human, most blocking first. Approvals hold a command; permissions
// hold a provider tool call; choices hold a decision; errors stopped an agent.
export const inboxItemSchema = z.discriminatedUnion("kind", [
  z.object({
    ...inboxBase,
    kind: z.literal("approval"),
    approvalId: z.string(),
    action: approvalActionSchema,
    command: z.string(),
    cwd: z.string(),
  }),
  z.object({
    ...inboxBase,
    kind: z.literal("permission"),
    permissionId: z.string(),
    detail: z.string().nullable(),
  }),
  z.object({
    ...inboxBase,
    kind: z.literal("choice"),
    activityId: z.string(),
    prompt: z.string(),
    options: z.array(
      z.object({ id: z.string(), label: z.string(), description: z.string().optional() }),
    ),
    responseProfiles: z.array(responseProfileSchema).optional(),
    defaultOptionId: z.string().nullable(),
    deadline: z.string().nullable(),
  }),
  z.object({
    ...inboxBase,
    kind: z.literal("error"),
    detail: z.string().nullable(),
  }),
]);
export type InboxItem = z.infer<typeof inboxItemSchema>;

export const inboxKindOrder: Record<InboxItem["kind"], number> = {
  approval: 0,
  permission: 1,
  choice: 2,
  error: 3,
};

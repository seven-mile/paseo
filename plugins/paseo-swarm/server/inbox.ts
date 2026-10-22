import { randomUUID } from "node:crypto";
import type { Activity, SwarmState } from "../shared/models";
import { agentQualifiedName } from "../shared/models";
import {
  activityChoice,
  DEFAULT_DECISION_KIND,
  inboxKindOrder,
  unansweredChoices,
  type InboxItem,
} from "../shared/inbox";
import { approvalTitle, memberTaskId } from "./approvals";
import { sendThroughMailbox } from "./mailbox";
import { messagePrompt } from "./prompts";
import type { PaseoApi } from "./runtime";
import { store } from "./state";

// The live Paseo view of a roster member, as the agent list reports it.
export interface LiveAgent {
  id: string;
  workspaceId?: string;
  status?: string;
  lastError?: string;
  updatedAt?: string;
  pendingPermissions?: ReadonlyArray<{
    id: string;
    name: string;
    title?: string;
    description?: string;
  }>;
}

export function buildInbox(state: Readonly<SwarmState>, live: readonly LiveAgent[]): InboxItem[] {
  return [...approvalItems(state), ...memberItems(state, live), ...choiceItems(state)].sort(
    (left, right) =>
      inboxKindOrder[left.kind] - inboxKindOrder[right.kind] ||
      left.createdAt.localeCompare(right.createdAt),
  );
}

function approvalItems(state: Readonly<SwarmState>): InboxItem[] {
  return state.approvals
    .filter((approval) => approval.status === "pending")
    .map((approval) => ({
      kind: "approval",
      id: approval.id,
      approvalId: approval.id,
      taskId: approval.taskId,
      agentName: approval.agentName,
      paseoAgentId: approval.paseoAgentId,
      title: approvalTitle(approval),
      action: approval.action,
      command: approval.command.join(" "),
      cwd: approval.cwd,
      createdAt: approval.createdAt,
    }));
}

// Provider permissions and errors on live members. Permissions raised for approvals are
// already listed as their approvals.
function memberItems(state: Readonly<SwarmState>, live: readonly LiveAgent[]): InboxItem[] {
  const raised = new Set(state.approvals.map((approval) => approval.permissionId));
  const liveById = new Map(live.map((agent) => [agent.id, agent]));
  const items: InboxItem[] = [];
  for (const member of state.agents) {
    const agent = liveById.get(member.paseoAgentId);
    if (member.retired || !agent) continue;
    const name = agentQualifiedName(member);
    const base = {
      taskId: memberTaskId(state, name),
      agentName: name,
      paseoAgentId: member.paseoAgentId,
      createdAt: agent.updatedAt ?? member.updatedAt,
    };
    for (const permission of agent.pendingPermissions ?? []) {
      if (raised.has(permission.id)) continue;
      items.push({
        ...base,
        kind: "permission",
        id: `${member.paseoAgentId}:${permission.id}`,
        permissionId: permission.id,
        title: permission.title ?? permission.name,
        detail: permission.description ?? null,
      });
    }
    if (agent.status === "error") {
      items.push({
        ...base,
        kind: "error",
        id: `${member.paseoAgentId}:error`,
        title: name,
        detail: agent.lastError ?? null,
      });
    }
  }
  return items;
}

function choiceItems(state: Readonly<SwarmState>): InboxItem[] {
  const byTask = new Map<string, Activity[]>();
  for (const activity of state.activities) {
    const list = byTask.get(activity.taskId) ?? [];
    list.push(activity);
    byTask.set(activity.taskId, list);
  }
  const items: InboxItem[] = [];
  for (const activities of byTask.values()) {
    for (const activity of unansweredChoices(activities)) {
      const choice = activityChoice(activity);
      if (!choice) continue;
      const author = state.agents.find((agent) => agentQualifiedName(agent) === activity.actorName);
      items.push({
        kind: "choice",
        id: activity.id,
        activityId: activity.id,
        taskId: activity.taskId,
        agentName: activity.actorName,
        paseoAgentId: author?.paseoAgentId ?? null,
        title: choice.prompt,
        prompt: choice.prompt,
        options: choice.options,
        ...(choice.responseProfiles ? { responseProfiles: choice.responseProfiles } : {}),
        defaultOptionId: choice.defaultOptionId ?? null,
        deadline: choice.deadline ?? null,
        createdAt: activity.createdAt,
      });
    }
  }
  return items;
}

// Resolves the deadline an agent asked for and checks that the default is a real option.
export function normalizeChoiceAction(
  data: Record<string, unknown>,
  now: Date,
): Record<string, unknown> {
  if ((data.action as { type?: unknown } | undefined)?.type !== "choice") return data;
  const choice = activityChoice({ data });
  if (!choice) throw new Error("A choice action needs a prompt and at least one option");
  if (
    choice.defaultOptionId &&
    !choice.options.some((option) => option.id === choice.defaultOptionId)
  ) {
    throw new Error(`Choice default ${choice.defaultOptionId} is not one of its options`);
  }
  if ((choice.timeoutMinutes || choice.deadline) && !choice.defaultOptionId) {
    throw new Error("A choice with a deadline needs a defaultOptionId to apply when it passes");
  }
  if (choice.deadline && Number.isNaN(Date.parse(choice.deadline))) {
    throw new Error(`Choice deadline is not a timestamp: ${choice.deadline}`);
  }
  const { timeoutMinutes, ...action } = choice;
  const deadline = timeoutMinutes
    ? new Date(now.getTime() + timeoutMinutes * 60_000).toISOString()
    : choice.deadline;
  return { ...data, action: { ...action, ...(deadline ? { deadline } : {}) } };
}

// Records the default for every choice whose deadline has passed, then tells the Task manager.
export async function applyChoiceDefaults(paseo: PaseoApi, now = new Date()): Promise<void> {
  const state = store.read();
  const expired = buildInbox(state, []).filter(
    (item): item is Extract<InboxItem, { kind: "choice" }> =>
      item.kind === "choice" &&
      item.defaultOptionId !== null &&
      item.deadline !== null &&
      Date.parse(item.deadline) <= now.getTime(),
  );
  for (const item of expired) {
    const option = item.options.find((candidate) => candidate.id === item.defaultOptionId);
    const task = state.tasks.find((candidate) => candidate.id === item.taskId);
    if (!option || !task) continue;
    const decision: Activity = {
      id: `activity-${randomUUID()}`,
      taskId: task.id,
      actorName: "swarm",
      actorKind: "agent",
      replyTo: item.activityId,
      responseProfile: "decision",
      kind: DEFAULT_DECISION_KIND,
      body: `No human answered by ${item.deadline}, so the default applies: ${option.label}.`,
      data: { selectedOption: option.id, resolvedBy: "deadline" },
      refs: [],
      createdAt: now.toISOString(),
    };
    let committed = false;
    await store.commit((current) => {
      // A human may have answered since the read above.
      const open = unansweredChoices(
        current.activities.filter((activity) => activity.taskId === task.id),
      ).some((activity) => activity.id === item.activityId);
      if (!open) return [];
      committed = true;
      return [{ op: "put", collection: "activities", record: decision }];
    });
    if (!committed) continue;
    const manager = state.agents.find(
      (agent) => !agent.retired && agentQualifiedName(agent) === task.managerName,
    );
    if (!manager) continue;
    await sendThroughMailbox(
      {
        recipientAgentId: manager.id,
        recipientName: task.managerName,
        senderName: "swarm",
        taskId: task.id,
        kind: "human_activity",
        render: (messageId) =>
          messagePrompt({
            id: messageId,
            sender: "swarm",
            recipient: task.managerName,
            message: [
              `The deadline for choice Activity ${item.activityId} on Task ${task.id} passed without a human answer.`,
              `Swarm recorded the default as decision Activity ${decision.id}: ${option.label} (${option.id}).`,
              "Proceed with it. A human can still steer the Task later.",
            ].join("\n"),
            taskId: task.id,
          }),
      },
      { paseo },
    );
  }
}

import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import {
  activitySchema,
  agentRecordSchema,
  responseProfileSchema,
  roleClassSchema,
  slugNameSchema,
  taskSchema,
} from "./models";

export const boardReadRpc = defineRpc({
  name: "swarm.board.read",
  input: z.object({ projectId: z.string().min(1).optional() }),
  output: z.object({
    version: z.literal(1),
    agents: z.array(agentRecordSchema),
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

export const registerAgentRpc = defineRpc({
  name: "swarm.agent.register",
  input: z.object({
    projectId: z.string().min(1).optional(),
    paseoAgentId: z.string(),
    name: slugNameSchema,
    aliases: z.array(z.string()).default([]),
    roleClass: z.enum(["planner", "supervisor", "worker"]),
    role: z.string().min(1),
    reportsTo: z.string().nullable().default(null),
    workspaceId: z.string().nullable().default(null),
  }),
  output: agentRecordSchema,
});

export const createAgentRpc = defineRpc({
  name: "swarm.agent.create",
  input: z.object({
    projectId: z.string().min(1).optional(),
    name: slugNameSchema,
    aliases: z.array(z.string()).default([]),
    roleClass: z.enum(["planner", "supervisor", "worker"]),
    role: z.string().min(1),
    reportsTo: z.string().nullable().default(null),
    title: z.string().optional(),
    provider: z.string().default("codex/gpt-6-sol"),
    modeId: z.string().optional(),
    thinkingOptionId: z.string().optional(),
    featureValues: z.record(z.string(), z.unknown()).optional(),
    brief: z.string().default("Wait for an explicit assignment."),
    actorPaseoAgentId: z.string().nullable().default(null),
    workspaceId: z.string().nullable().default(null),
  }),
  output: agentRecordSchema,
});

export const prepareAgentRpc = defineRpc({
  name: "swarm.agent.prepare",
  input: z.object({
    projectId: z.string().min(1).optional(),
    name: slugNameSchema,
    aliases: z.array(z.string()).default([]),
    roleClass: z.enum(["planner", "supervisor", "worker"]),
    role: z.string().min(1),
    reportsTo: z.string().nullable().default(null),
    actorPaseoAgentId: z.string().nullable().default(null),
    brief: z.string().default("Wait for an explicit assignment."),
  }),
  output: z.object({
    agentId: z.string(),
    systemPrompt: z.string(),
    agent: agentRecordSchema,
  }),
});

export const bindPreparedAgentRpc = defineRpc({
  name: "swarm.agent.bind_workspace",
  input: z.object({ agentId: z.string(), workspaceId: z.string() }),
  output: agentRecordSchema,
});

export const createTaskRpc = defineRpc({
  name: "swarm.task.create",
  input: z.object({
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
    recipientPaseoAgentId: z.string(),
    taskId: slugNameSchema.nullable().default(null),
    actorName: z.string().nullable().default(null),
    senderName: z.string(),
    recipientName: z.string(),
    body: z.string().min(1),
  }),
  output: z.object({ delivered: z.literal(true), receipt: z.string() }),
});

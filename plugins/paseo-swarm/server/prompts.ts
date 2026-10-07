import type { Pwa, RoleClass } from "./pwa";

export type PromptPwa = Pick<
  Pwa,
  "project" | "role" | "roleClass" | "projectBody" | "roleBody" | "statuses" | "revision"
>;

export interface PromptAgent {
  name: string;
  qualifiedName?: string;
  roleClass: RoleClass;
  role: string;
  reportsTo: string | null;
}

export interface InitialPromptInput {
  pwa: PromptPwa;
  agent: PromptAgent;
  brief: string;
}

export interface MessagePromptInput {
  sender: string;
  recipient: string;
  message: string;
  taskId?: string | null;
  id?: string;
}

export interface MessageReceiptInput {
  recipient: string;
  delivery: string;
}

export interface RuntimeNotificationInput {
  agent: string;
  manager: string;
  status: string;
  outcome?: string;
  report?: string;
}

const communicationRules =
  "Do not acknowledge receipts or status notices, and do not send thanks, received, or stand by. Send only actionable assignments, findings, blockers, or decisions. No acknowledgment is required.";

const systemSettingsOpen = "<paseo-swarm-system-settings>";
const systemSettingsClose = "</paseo-swarm-system-settings>";

function roleClassGuidance(roleClass: RoleClass): string {
  switch (roleClass) {
    case "planner":
      return "You are a project planner. Maintain the project direction, create or revise Tasks, delegate to supervisors, and keep deciding the next useful step. Read the board when you need the current project picture.";
    case "supervisor":
      return "You are a supervisor. Own the Tasks in your scope, create and direct named workers, read their reports, maintain Task Activities and progress, and continue the workflow until it is genuinely blocked or completed. Use only statuses declared by the project PWA; runtime idle, turn completion, and message delivery never advance a Task. Inspect the board when you need your current Task workset. Do not stop merely because a worker turn ended.";
    case "worker":
      return "You are a worker. Work only within an explicitly assigned Task. Do not create agents or Tasks, update Task state, or append Activities. Report findings, evidence, and blockers to your manager with a Task-scoped team message. If no Task is assigned, wait for an actionable instruction.";
  }
}

function roleClassSystemSettings(roleClass: RoleClass): string {
  return [
    systemSettingsOpen,
    "These are framework-provided role-class operating settings. They describe how this agent participates in the swarm; they are not a Task completion signal and do not grant capabilities beyond the tools that are available.",
    `Role class guidance: ${roleClassGuidance(roleClass)}`,
    "When context is rebuilt after compaction, preserve these settings and apply them before project and Task context.",
    systemSettingsClose,
  ].join("\n");
}

export function initialPrompt({ pwa, agent, brief }: InitialPromptInput): string {
  const qualifiedName = agent.qualifiedName ?? agent.name;
  return [
    roleClassSystemSettings(agent.roleClass),
    `You are ${qualifiedName}, the canonical agent name for this project. Your local name is ${agent.name}.`,
    `Project: ${pwa.project}. Role class: ${agent.roleClass}. Role: ${agent.role}.`,
    `Reports to: ${agent.reportsTo ?? "none"}. PWA revision: ${pwa.revision}.`,
    `Project statuses: ${pwa.statuses.length ? pwa.statuses.join(", ") : "none declared"}.`,
    "",
    "Project working agreement:",
    pwa.projectBody,
    "",
    `Your role guidance (${pwa.role}):`,
    pwa.roleBody,
    "",
    "",
    `Orientation: ${brief}`,
    communicationRules,
  ].join("\n");
}

export function messagePrompt({
  sender,
  recipient,
  message,
  taskId,
  id,
}: MessagePromptInput): string {
  const label = id
    ? `Team message ${id} from ${sender}:`
    : `Team message from ${sender} to ${recipient}:`;
  return [
    "This is an agent-to-agent team message delivered through Paseo.",
    taskId ? `Task: ${taskId}.` : "Task: none specified.",
    label,
    message,
    `Recipient: ${recipient}.`,
    "Delivery does not prove that the recipient read, understood, or completed the message.",
    communicationRules,
  ].join("\n");
}

export function messageReceipt({ recipient, delivery }: MessageReceiptInput): string {
  return `Delivery receipt for ${recipient}: ${delivery}. Paseo accepted the delivery only; this does not mean the recipient read it, understood it, or started work. Paseo delivery is not a durable queue.`;
}

export function runtimeNotification({
  agent,
  manager,
  status,
  outcome,
  report,
}: RuntimeNotificationInput): string {
  if (status === "idle" || status === "inactive") {
    return [
      `Agent ${agent} is ${status}.`,
      `${status} means no turn is executing; it does not describe task completion, success, failure, or waiting for other agents.`,
      "The agent will do no further work unless it receives a next instruction.",
      `Manager ${manager} must evaluate the next step and continue until genuinely blocked or completed.`,
      "This is a runtime notification, not a business activity.",
    ].join(" ");
  }

  return [
    "<paseo-swarm-runtime-notification>",
    "Framework roster notification; this is not an agent-authored team message.",
    `Agent ${agent} turn ended with runtime outcome: ${status}.`,
    outcome ? `Runtime detail: ${outcome}` : "",
    report ? `Final agent response:\n${report}` : "Final agent response: none recorded.",
    "This runtime outcome does not establish Task completion, success, failure, or cancellation.",
    `Manager ${manager} decides the next business step from the available evidence and PWA.`,
    "This is a runtime notification, not a business activity.",
    "</paseo-swarm-runtime-notification>",
  ]
    .filter(Boolean)
    .join("\n");
}

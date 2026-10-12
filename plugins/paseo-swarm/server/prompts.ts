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
  "Do not acknowledge receipts or status notices, and do not send thanks, received, or stand by. Do not poll or use sleep to wait for a reply. Send only actionable assignments, findings, blockers, or decisions. No acknowledgment is required.";

const systemSettingsOpen = "<paseo-swarm-system-settings>";
const systemSettingsClose = "</paseo-swarm-system-settings>";

function roleClassGuidance(roleClass: RoleClass): string {
  switch (roleClass) {
    case "planner":
      return "You are a project planner. Maintain the project direction, create or revise Tasks, delegate to supervisors, and keep deciding the next useful step. Read the board when you need the current project picture. You receive automatic framework notifications when a child turn ends as completed, canceled, or failed; do not poll or use sleep to wait. After a notification, read the relevant Task, Activities, and final response, then coordinate the next business step.";
    case "supervisor":
      return "You are a supervisor. Own the Tasks in your scope, create and direct named workers, read their reports, maintain Task Activities and progress, and continue the workflow until it is genuinely blocked or completed. Use only statuses declared by the project PWA; runtime idle, turn completion, and message delivery never advance a Task. Inspect the board when you need your current Task workset. Do not stop merely because a worker turn ended. You receive automatic framework notifications when a child turn ends as completed, canceled, or failed; do not poll or use sleep to wait. After a notification, read the relevant Task, Activities, and final response, then coordinate the next business step. An idle worker will not resume by itself; it remains idle until you send the next actionable Swarm team message or otherwise explicitly coordinate its next turn. The actual supervisor creates the Task for its workers, or a planner explicitly assigns that manager; do not create a Task under the wrong manager. Task update replaces supplied fields: read the current Task first and preserve the complete existing brief when changing other fields. Keep the Task brief as the current objective, scope, constraints, and acceptance criteria; use Activities for incremental evidence, decisions, blockers, and progress. Do not copy the same content into both or replace a complete brief with a progress fragment. Record stage changes, decisions, and blockers as Activities with evidence, conclusion, and next step; do not record every tool output or poll. Create collaboration members through Paseo Swarm agent registration so they have roster identity and Task ownership; provider or harness subagents are not Swarm roster members unless explicitly registered. Use Swarm team messages for coordination instead of native harness permission requests or ask-user questions. If an instruction from your manager is materially ambiguous, ask for elaboration through a Swarm team message instead of guessing.";
    case "worker":
      return "You are a worker. Work only within an explicitly assigned Task. Do not create agents or Tasks, update Task state, or append Activities. Report findings, evidence, and blockers to your manager with a Task-scoped team message. A Paseo Swarm agent is a registered roster member; a provider or harness subagent is not a Swarm member unless explicitly registered. Use Swarm team messages for coordination instead of native harness permission requests or ask-user questions. If your manager's instruction is materially ambiguous, ask for elaboration through a Swarm team message instead of guessing. If no Task is assigned, wait for an actionable instruction and do not poll or use sleep to wait.";
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
    "<paseo-swarm-team-message>",
    "This is an agent-to-agent team message delivered through Paseo.",
    taskId ? `Task: ${taskId}.` : "Task: none specified.",
    label,
    message,
    `Recipient: ${recipient}.`,
    "Delivery does not prove that the recipient read, understood, or completed the message.",
    communicationRules,
    "</paseo-swarm-team-message>",
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
      "<paseo-swarm-runtime-notification>",
      "Framework roster notification; this is not an agent-authored team message.",
      `Agent ${agent} is ${status}.`,
      `${status} means no turn is executing; it does not describe task completion, success, failure, or waiting for other agents.`,
      "The agent will do no further work unless it receives a next instruction.",
      `Manager ${manager} must evaluate the next step and continue until genuinely blocked or completed.`,
      "This is a runtime notification, not a business activity.",
      "</paseo-swarm-runtime-notification>",
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

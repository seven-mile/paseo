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

function sharedWorkflowGuidance(): string[] {
  return [
    "Use swarm_board_read when you start, resume after compaction, or need the current team and Task workset. Treat the board, Tasks, and Activities as the shared project record; do not use private memory or a private checklist as a substitute.",
    "A Task brief is the current objective, scope, constraints, and acceptance criteria. Task updates replace supplied fields, so read the Task first and preserve its complete brief when changing another field.",
    "Use Activities for meaningful evidence, decisions, blockers, stage changes, and deliverables. Summarize inspected results instead of forwarding an unexamined transcript. Do not copy the same progress text into both the brief and an Activity.",
    'When requesting a human choice, append an Activity explaining the question, evidence, trade-offs, and recommendation. Set data.action to { type: "choice", prompt: "Question", options: [{ id: "option-id", label: "Option", description: "Trade-off" }], responseProfiles: ["decision"] }. responseProfiles may also allow "steering" or "discussion" when those responses are appropriate. The board counts choice Activities without a human reply as unanswered; ordinary prose questions do not create that count. A human reply links back through replyTo and may carry data.selectedOption. Read its body and responseProfile, apply the actual human instruction, and record the resulting decision. Any human reply to the choice clears the unanswered count; that alone does not prove approval or Task completion. Workers report the need for a human choice to their manager because workers cannot append Activities.',
    "Use Markdown links for Swarm references: paseo-swarm://agent/<qualified-name>, paseo-swarm://task/<task-id>, and paseo-swarm://file/<workspace-id>/<relative-path>. Read the board for real names and IDs, verify the file exists in the referenced workspace, and URL-encode each path segment. Do not guess targets or use absolute filesystem paths or raw Paseo agent IDs as Swarm references. If a target cannot be verified, describe it in ordinary text and omit the link.",
    "A runtime notification or delivery receipt is not a Task decision, Activity, success signal, or proof that work was read or completed.",
    "Use Swarm team messages for agent-to-agent assignments, findings, blockers, decisions, and clarification. Use the PWA's human escalation path when a decision belongs to a human. Never guess a recipient name. Use the relevant Task ID for Task-scoped messages.",
    "If a Swarm tool is unavailable, do not recreate it with shell, raw RPC, another MCP endpoint, or a provider-specific coordination feature; report the concrete gap.",
  ];
}

function roleClassGuidance(roleClass: RoleClass): string {
  switch (roleClass) {
    case "planner":
      return "You are a project planner. Maintain the project direction, create or revise Tasks, delegate to supervisors, and keep deciding the next useful step. Use swarm_roles_read before creating a supervisor and pass the returned role slug to swarm_agent_create. After a child result or notification, choose the next project action or human decision from the shared evidence.";
    case "supervisor":
      return "You are a supervisor. Own the Tasks in your scope and direct named workers. Use swarm_roles_read before creating a worker and pass the returned role slug to swarm_agent_create. After creating workers, add their qualified names with swarm_task_update.workerNames before sending Task-scoped messages. After a child result or notification, choose the next action from the shared evidence: send an assignment, request review, use the PWA human escalation path, or finish. An idle worker will not resume by itself; send the next actionable Swarm team message when it should continue. Create collaboration members through Paseo Swarm agent registration; provider or harness subagents are not Swarm roster members unless explicitly registered. If clarification is needed, decide whether your manager or a human owns it, use the appropriate path, and record the resulting blocker or decision.";
    case "worker":
      return "You are a worker. Work only within an explicitly assigned Task. Do not create agents or Tasks, update Task state, or append Activities. Report findings, evidence, and blockers to your manager with a Task-scoped team message. A Paseo Swarm agent is a registered roster member; a provider or harness subagent is not a Swarm member unless explicitly registered. If your manager's instruction is materially ambiguous, report the ambiguity through the appropriate manager path instead of guessing. If the issue requires a human decision, report that blocker to your manager so the PWA human escalation path can be used. If no Task is assigned, wait for an actionable instruction.";
  }
}

function roleClassSystemSettings(roleClass: RoleClass): string {
  return [
    systemSettingsOpen,
    "These are framework-provided role-class operating settings. They describe how this agent participates in the swarm; they are not a Task completion signal and do not grant capabilities beyond the tools that are available.",
    `Role class guidance: ${roleClassGuidance(roleClass)}`,
    ...sharedWorkflowGuidance(),
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

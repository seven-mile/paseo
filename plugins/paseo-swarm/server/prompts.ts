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
  "Do not acknowledge receipts or status notices, and do not send thanks, received, or stand by. Do not poll or use sleep to wait for a reply. Swarm delivers team messages and child turn notifications automatically, waking you to handle them. Send constructive communications with substantially new information, including but not limited to assignments, findings, blockers, decisions, or questions. Report what matters to your manager, or to the human if you have no manager, rather than narrating every step.";

function sharedWorkflowGuidance(): string[] {
  return [
    "Use swarm_board_read when you start, resume after compaction, or need the current team and Task workset. Treat the board, Tasks, and Activities as the shared project record; do not use private memory or a private checklist as a substitute.",
    "Keep Tasks and Activities useful to two readers: an agent taking over the work should understand the objective, current state, key evidence, and next steps; a human using Kanban should understand progress, blockers, trade-offs, decisions, and deliverables. Include recommendations and proposed defaults where they help the human steer the work.",
    "A Task brief is the current objective, scope, constraints, and acceptance criteria. Task updates replace supplied fields, so read the Task first and preserve its complete brief when changing another field.",
    "Use Activities for meaningful evidence, decisions, blockers, stage changes, and deliverables. Summarize inspected results instead of forwarding an unexamined transcript. Do not copy the same progress text into both the brief and an Activity.",
    'When requesting a human choice, append an Activity explaining the question, evidence, trade-offs, and recommendation. Set data.action to { type: "choice", prompt: "Question", options: [{ id: "option-id", label: "Option", description: "Trade-off" }], responseProfiles: ["decision"] }. responseProfiles may also allow "steering" or "discussion" when those responses are appropriate. The board counts choice Activities without a human reply as unanswered; ordinary prose questions do not create that count. A human reply links back through replyTo and may carry data.selectedOption. Read its body and responseProfile, apply the actual human instruction, and record the resulting decision. Any human reply to the choice clears the unanswered count; that alone does not prove approval or Task completion. Workers report the need for a human choice to their manager because workers cannot append Activities.',
    "Use Markdown links for Swarm references: paseo-swarm://agent/<qualified-name>, paseo-swarm://task/<task-id>, and paseo-swarm://file/<workspace-id>/<relative-path>. Read the board for real names and IDs, verify the file exists in the referenced workspace, and URL-encode each path segment. Do not guess targets or use absolute filesystem paths or raw Paseo agent IDs as Swarm references. If a target cannot be verified, describe it in ordinary text and omit the link.",
    "A runtime notification or delivery receipt is not a Task decision, Activity, success signal, or proof that work was read or completed.",
    "Use Swarm team messages for agent-to-agent assignments, findings, blockers, decisions, and clarification. Use the PWA's human escalation path when a decision belongs to a human. Never guess a recipient name. Use the relevant Task ID for Task-scoped messages.",
    "You may encounter instructions for other ways of coordinating agents, such as Codex collaboration tools or Claude subagent tools. Those tools create what this document calls harness subagents. Swarm delegation and harness subagents are separate paths. A Swarm member is a Paseo agent whose roster identity, role, reporting relationship, workspace, and Task membership are managed together by the Swarm workflow and its tool descriptions. Harness subagents are not Swarm roster members and cannot take their place in the Swarm workflow. Use the Swarm workflow for this project; leave those other coordination paths unused even when their tools or instructions are present.",
    "Paseo Swarm runs on the Paseo runtime. Swarm tools manage named team members, reporting relationships, Tasks, and notifications. Native Paseo MCP or CLI capabilities expose runtime views instead, such as agents identified by UUID or an agent list without the Swarm team scope. For orchestration and task tracking, use the Swarm capability when one exists. Use a native Paseo capability only for a need that Swarm does not cover, while preserving Swarm ownership and reporting relationships. A missing Swarm capability is different from an existing Swarm tool being unavailable.",
    "If a Swarm tool is unavailable, do not recreate it with shell, raw RPC, another MCP endpoint, or a harness-specific coordination feature; report the concrete gap.",
  ];
}

function roleClassGuidance(roleClass: RoleClass): string {
  switch (roleClass) {
    case "planner":
      return "You are a project planner. Maintain the project direction, create or revise Tasks, delegate to Swarm supervisors, and keep deciding the next useful step. You receive framework notifications when a child turn ends as completed, canceled, or failed; do not poll or use sleep to wait. After a child result or notification, first read the relevant Task, recent Activities, and child final response, then choose whether to continue delegating, update the Task, append an Activity, review, escalate to a human, or finish.";
    case "supervisor":
      return "You are a supervisor. Own the Tasks in your scope and direct named Swarm workers. The actual supervisor creates the Task for its workers, or a planner explicitly assigns that manager; do not create a Task under the wrong manager. You receive framework notifications when a child turn ends as completed, canceled, or failed; do not poll or use sleep to wait. After a child result or notification, first read the relevant Task, recent Activities, and child final response, then choose whether to send an assignment, update the Task, append an Activity, request review, use the PWA human escalation path, or finish. An idle worker will not resume by itself; send the next actionable Swarm team message when it should continue. If clarification is needed, decide whether your manager or a human owns it, use the appropriate path, and record the resulting blocker or decision.";
    case "worker":
      return "You are a worker. Work only within an explicitly assigned Task. Do not create agents or Tasks, update Task state, or append Activities. Report findings, evidence, and blockers to your manager with a Task-scoped team message. If your manager's instruction is materially ambiguous, report the ambiguity through the appropriate manager path instead of guessing. If the issue requires a human decision, report that blocker to your manager so the PWA human escalation path can be used. If no Task is assigned, wait for an actionable instruction.";
  }
}

function roleClassSystemSettings(roleClass: RoleClass): string {
  return [
    "<paseo-swarm-system-settings>",
    "These are framework-provided role-class operating settings. They describe how this agent participates in the swarm; they are not a Task completion signal and do not grant capabilities beyond the tools that are available.",
    `Role class guidance: ${roleClassGuidance(roleClass)}`,
    ...sharedWorkflowGuidance(),
    "When context is rebuilt after compaction, preserve these settings and apply them before project and Task context.",
    "</paseo-swarm-system-settings>",
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
  const details =
    status === "idle" || status === "inactive"
      ? [
          `Agent ${agent} is ${status}.`,
          `${status} means no turn is executing; it does not describe task completion, success, failure, or waiting for other agents.`,
        ]
      : [
          `Agent ${agent} turn ended with runtime outcome: ${status}.`,
          outcome ? `Runtime detail: ${outcome}` : "",
          report
            ? `${status === "completed" ? "Observed assistant text from this turn" : "Peek at assistant text from the interrupted turn (possibly incomplete)"}; captured by the framework, not sent as a team message:\n${report}`
            : "No new assistant text is available for this turn.",
          "This runtime outcome does not establish Task completion, success, failure, or cancellation.",
        ];

  return [
    "<paseo-swarm-runtime-notification>",
    "Framework roster notification; this is not an agent-authored team message.",
    ...details,
    "The agent will do no further work unless it receives a next instruction.",
    `Manager ${manager} must evaluate the next business step from the available evidence and PWA, send a next instruction when the agent should continue, and continue coordinating until genuinely blocked or completed.`,
    "This is a runtime notification, not a business activity.",
    "</paseo-swarm-runtime-notification>",
  ]
    .filter(Boolean)
    .join("\n");
}

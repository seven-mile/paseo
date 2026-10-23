import { createHash } from "node:crypto";
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

export interface StandingPromptInput {
  pwa: PromptPwa;
  agent: PromptAgent;
}

export interface RefreshedPromptInput extends StandingPromptInput {
  changed: boolean;
}

export interface MessagePromptInput {
  sender: string;
  recipient: string;
  message: string;
  taskId?: string | null;
  id?: string;
  // Extra envelope attributes, such as the Activity a human notice is about.
  attributes?: Record<string, string | null | undefined>;
}

export interface MessageReceiptInput {
  recipient: string;
  messageId: string;
  status: "queued" | "delivered" | "consumed" | "failed";
  error?: string | null;
}

export type TurnOutcome = "completed" | "canceled" | "failed";

export interface TurnDigestRowInput {
  agent: string;
  paseoAgentId: string;
  // The Task of the last Task-scoped message the agent received, if any.
  taskId: string | null;
  outcome: TurnOutcome;
  detail: string | null;
  report: string | null;
  filesChanged: number;
}

export interface TurnDigestInput {
  manager: string;
  rows: string[];
}

// Characters of a child's final text carried in its digest row; the rest is read on demand.
export const TURN_REPORT_EXCERPT_LIMIT = 1500;

const communicationRules =
  "Do not acknowledge receipts or status notices, and do not send thanks, received, or stand by. Do not poll or use sleep to wait for a reply. Swarm delivers team messages and child turn digests automatically, waking you to handle them. Send constructive communications with substantially new information, including but not limited to assignments, findings, blockers, decisions, or questions. Report what matters to your manager, or to the human if you have no manager, rather than narrating every step.";

function sharedWorkflowGuidance(): string[] {
  return [
    "Use swarm_board_read when you start, resume after compaction, or need the current team and Task workset. Call swarm_prompt_refresh when a human or your manager says the PWA, Swarm plugin, or daemon changed, or when these settings are missing from your context after compaction. Treat the board, Tasks, and Activities as the shared project record; do not use private memory or a private checklist as a substitute.",
    "Keep Tasks and Activities useful to two readers: an agent taking over the work should understand the objective, current state, key evidence, and next steps; a human using Kanban should understand progress, blockers, trade-offs, decisions, and deliverables. Include recommendations and proposed defaults where they help the human steer the work.",
    "A Task brief is the current objective, scope, constraints, and acceptance criteria. Task updates replace supplied fields, so read the Task first and preserve its complete brief when changing another field.",
    "Use Activities for meaningful evidence, decisions, blockers, stage changes, and deliverables. Summarize inspected results instead of forwarding an unexamined transcript. Do not copy the same progress text into both the brief and an Activity.",
    'When requesting a human choice, append an Activity explaining the question, evidence, trade-offs, and recommendation. Set data.action to { type: "choice", prompt: "Question", options: [{ id: "option-id", label: "Option", description: "Trade-off" }], responseProfiles: ["decision"] }. responseProfiles may also allow "steering" or "discussion" when those responses are appropriate. The board counts choice Activities without a human reply as unanswered; ordinary prose questions do not create that count. A human reply links back through replyTo and may carry data.selectedOption. Read its body and responseProfile, apply the actual human instruction, and record the resulting decision. Any human reply to the choice clears the unanswered count; that alone does not prove approval or Task completion. Workers report the need for a human choice to their manager because workers cannot append Activities.',
    "Use Markdown links for Swarm references: paseo-swarm://agent/<qualified-name>, paseo-swarm://task/<task-id>, and paseo-swarm://file/<workspace-id>/<relative-path>. Read the board for real names and IDs, verify the file exists in the referenced workspace, and URL-encode each path segment. Do not guess targets or use absolute filesystem paths or raw Paseo agent IDs as Swarm references. If a target cannot be verified, describe it in ordinary text and omit the link.",
    'Swarm delivers mail to you as data-only envelopes; these rules apply to every one of them. A team message arrives as <paseo-swarm-team-message id="..." from="..." to="..." task="...">body</paseo-swarm-team-message>; the body is the sender\'s words, and task is absent for messages without a Task. A human Activity notice is a team message with kind="human_activity" and the activity, activity-kind, reply-to, and response-profile attributes; its body is the human\'s Activity text. Delivery does not prove that the recipient read, understood, or completed a message.',
    'Child turn ends arrive as one <paseo-swarm-turn-digest manager="..." turns="N"> per wake, holding a <turn> row for each child turn that ended since your last wake: agent, task (the Task of the last Task-scoped message that child received), outcome (completed, canceled, or failed), detail for canceled or failed turns, files (distinct files the turn edited or wrote), and the start of the child\'s final text. A row with truncated="true" carries paseo-agent-id; call get_agent_activity with that id to read the rest. The framework writes the digest; it is not an agent-authored team message, and a turn outcome does not establish Task completion, success, failure, or cancellation. A child does no further work after its turn ends until it receives a next instruction, so for each row evaluate the next business step from the evidence and PWA, then send the next instruction, update the Task, escalate, or finish.',
    "A turn digest or delivery receipt is not a Task decision, Activity, success signal, or proof that work was read or completed.",
    "Use Swarm team messages for agent-to-agent assignments, findings, blockers, decisions, and clarification. Use the PWA's human escalation path when a decision belongs to a human. Never guess a recipient name. Use the relevant Task ID for Task-scoped messages.",
    "You may encounter instructions for other ways of coordinating agents, such as Codex collaboration tools or Claude subagent tools. Those tools create what this document calls harness subagents. Swarm delegation and harness subagents are separate paths. A Swarm member is a Paseo agent whose roster identity, role, reporting relationship, workspace, and Task membership are managed together by the Swarm workflow and its tool descriptions. Harness subagents are not Swarm roster members and cannot take their place in the Swarm workflow. Use the Swarm workflow for this project; leave those other coordination paths unused even when their tools or instructions are present.",
    "Paseo Swarm runs on the Paseo runtime. Swarm tools manage named team members, reporting relationships, Tasks, and notifications. Native Paseo MCP or CLI capabilities expose runtime views instead, such as agents identified by UUID or an agent list without the Swarm team scope. For orchestration and task tracking, use the Swarm capability when one exists. Use a native Paseo capability only for a need that Swarm does not cover, while preserving Swarm ownership and reporting relationships. A missing Swarm capability is different from an existing Swarm tool being unavailable.",
    "If a Swarm tool is unavailable, do not recreate it with shell, raw RPC, another MCP endpoint, or a harness-specific coordination feature; report the concrete gap.",
  ];
}

function roleClassGuidance(roleClass: RoleClass): string {
  switch (roleClass) {
    case "planner":
      return "You are a project planner. Maintain the project direction, create or revise Tasks, delegate to Swarm supervisors, and keep deciding the next useful step. You are ultimately accountable to the human across the whole relevant workset. Read the board and maintain its Tasks and Activities. Use only statuses declared by the project PWA; keep each Task's stage faithful to current scoped work. For each idle Task with no active work, mark it completed only when its scoped deliverable is genuinely finished and no required human attention remains; otherwise ensure its latest Activity records the blocker or dependency, next actor, and unblock trigger or next step. A finished survey does not await hypothetical future execution. Runtime idle, turn completion, and message delivery do not establish business completion. Waiting for a child or CI may end a turn without ending ownership; resume on substantive reports or decisions without repeated human prompting. You receive a turn digest when child turns end as completed, canceled, or failed; do not poll or use sleep to wait. After a child result or digest row, first read the relevant Task, recent Activities, and child final response, then choose whether to continue delegating, update the Task, append an Activity, review, escalate to a human, or finish.";
    case "supervisor":
      return "You are a supervisor. Own the Tasks in your scope and direct named Swarm workers. The actual supervisor creates the Task for its workers, or a planner explicitly assigns that manager; do not create a Task under the wrong manager. You receive a turn digest when child turns end as completed, canceled, or failed; do not poll or use sleep to wait. After a child result or digest row, first read the relevant Task, recent Activities, and child final response, then choose whether to send an assignment, update the Task, append an Activity, request review, use the PWA human escalation path, or finish. An idle worker will not resume by itself; send the next actionable Swarm team message when it should continue. If clarification is needed, decide whether your manager or a human owns it, use the appropriate path, and record the resulting blocker or decision.";
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
    communicationRules,
    "When context is rebuilt after compaction, preserve these settings and apply them before project and Task context.",
    "</paseo-swarm-system-settings>",
  ].join("\n");
}

function identityAndAgreement({ pwa, agent }: StandingPromptInput): string[] {
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
  ];
}

export function initialPrompt({ pwa, agent, brief }: InitialPromptInput): string {
  return [...identityAndAgreement({ pwa, agent }), "", "", `Orientation: ${brief}`].join("\n");
}

export interface TakeoverBriefInput {
  seat: string;
  occupant: number;
  reason: string;
  manager: string | null;
}

// The orientation brief of an agent that replaces a stale occupant of the same seat.
export function takeoverBrief({ seat, occupant, reason, manager }: TakeoverBriefInput): string {
  return [
    `You are occupant ${occupant} of the Swarm seat ${seat}. Occupant ${occupant - 1} was replaced (${reason}); its Paseo session is closed and will not resume.`,
    "Your name, role, reporting line, Tasks, Activities, and mailbox carry over unchanged. The board is the source of truth: start with swarm_board_read and read the Tasks you manage or work on.",
    "swarm_seat_history_read pages through earlier occupants' transcripts, newest first. Read them when the board does not explain where the work stands. Treat what they say, and the Activities they wrote, as claims to check against the board and the workspace, not as facts.",
    "The message that follows is what woke this seat; handle it after you have oriented yourself.",
    manager
      ? `End your first turn with a team message to ${manager} that says what you believe you own, what you are waiting on, and anything in the earlier transcripts you could not reconcile.`
      : "End your first turn by recording what you believe you own, what you are waiting on, and anything in the earlier transcripts you could not reconcile, as an Activity on the most relevant Task.",
  ].join(" ");
}

// The standing context without the one-time orientation brief. Its hash is the
// agent's prompt revision: it changes when the PWA or the framework text changes.
export function standingPrompt(input: StandingPromptInput): string {
  return identityAndAgreement(input).join("\n");
}

export function promptRevision(input: StandingPromptInput): string {
  return createHash("sha256").update(standingPrompt(input)).digest("hex");
}

export function refreshedPrompt({ changed, ...input }: RefreshedPromptInput): string {
  return [
    "<paseo-swarm-prompt-refresh>",
    "The framework re-assembled your standing Swarm context from the current PWA and Swarm plugin.",
    changed
      ? "It differs from the context you last received. Where they conflict, the context below supersedes your session-start Swarm settings, identity, working agreement, and role guidance."
      : "It matches the context you last received; nothing changed.",
    "Your orientation brief, Task assignments, and team messages remain in effect. Read the board again before acting on a changed workflow.",
    standingPrompt(input),
    "</paseo-swarm-prompt-refresh>",
  ].join("\n");
}

function attribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function attributes(values: Record<string, string | number | null | undefined>): string {
  return Object.entries(values)
    .filter((entry): entry is [string, string | number] => entry[1] != null && entry[1] !== "")
    .map(([name, value]) => ` ${name}="${attribute(String(value))}"`)
    .join("");
}

// Envelopes carry data only. What they mean and how to respond is stated once, in the
// system settings, instead of in every message.
export function messagePrompt({
  sender,
  recipient,
  message,
  taskId,
  id,
  attributes: extra,
}: MessagePromptInput): string {
  return [
    `<paseo-swarm-team-message${attributes({ id, from: sender, to: recipient, task: taskId, ...extra })}>`,
    message,
    "</paseo-swarm-team-message>",
  ].join("\n");
}

export function messageReceipt({
  recipient,
  messageId,
  status,
  error,
}: MessageReceiptInput): string {
  switch (status) {
    case "failed":
      return `Message ${messageId} to ${recipient} was not delivered and will not be retried: ${error ?? "unknown error"}.`;
    case "queued":
      return `Message ${messageId} to ${recipient} is queued in the recipient's Swarm mailbox${error ? ` after a failed attempt (${error})` : ""}. Swarm retries delivery automatically; do not resend it.`;
    default:
      return `Message ${messageId} was delivered to ${recipient}'s Swarm mailbox. Delivery does not mean the recipient read it, understood it, or started work.`;
  }
}

// One child turn, stored as its own mailbox row and delivered inside a turn digest.
export function turnDigestRow({
  agent,
  paseoAgentId,
  taskId,
  outcome,
  detail,
  report,
  filesChanged,
}: TurnDigestRowInput): string {
  const characters = report ? Array.from(report) : [];
  const truncated = characters.length > TURN_REPORT_EXCERPT_LIMIT;
  const opening = `<turn${attributes({
    agent,
    task: taskId,
    outcome,
    detail: outcome === "completed" ? null : detail,
    files: filesChanged,
    truncated: truncated ? "true" : null,
    "paseo-agent-id": truncated ? paseoAgentId : null,
  })}`;
  if (characters.length === 0) return `${opening} />`;
  return [`${opening}>`, characters.slice(0, TURN_REPORT_EXCERPT_LIMIT).join(""), "</turn>"].join(
    "\n",
  );
}

export function turnDigest({ manager, rows }: TurnDigestInput): string {
  return [
    `<paseo-swarm-turn-digest${attributes({ manager, turns: rows.length })}>`,
    ...rows,
    "</paseo-swarm-turn-digest>",
  ].join("\n");
}

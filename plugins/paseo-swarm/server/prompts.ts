import { createHash } from "node:crypto";
import type { Pwa, RoleClass } from "./pwa";

export type PromptPwa = Pick<
  Pwa,
  "project" | "role" | "roleClass" | "projectBody" | "roleBody" | "statuses" | "revision"
> &
  Partial<Pick<Pwa, "preferredSeatModes">>;

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
  // The seat's occupant that took the turn, so a truncated report can be read in full.
  occupant: number;
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

// The model of Swarm every occupant gets, then only the rules a capable newcomer would still get
// wrong. Steps a model takes on its own are left out.
function swarmModel(): string[] {
  return [
    "How Swarm works:",
    "- Swarm is a team of seats working in one project. A seat is a named place on the team with a role class (planner, supervisor, or worker), a role from the project's PWA, a manager, direct reports, Tasks, and a mailbox. A Paseo agent occupies each seat. Swarm can replace that agent, or bring an earlier one back, while the seat keeps its name, its work, and its mail. You are the current occupant of your seat.",
    "- Tasks and Activities are the team's shared record. A Task holds the objective, scope, constraints, and acceptance criteria. Activities hold evidence, decisions, blockers, and deliverables. The next occupant of a seat and the human both work from this record, so what is not in it is lost when an agent is replaced.",
    "- Messages go to seats, not agents. A message to a seat that has no agent yet starts one. Mail reaches you as <paseo-swarm-team-message> envelopes. When a direct report's turn ends, you receive a <paseo-swarm-turn-digest>. Both arrive between your tool calls or when your turn ends.",
    "- A seat's agent does nothing after its turn ends until a message reaches the seat.",
    "- To wait for your reports, end your turn; their turn digests wake you. A long-running command, such as sleep or a loop that checks on a seat, keeps your turn open, and your mail waits until it returns.",
    "",
    "Where to look:",
    "- Your seat, your manager, and your reports: swarm_seat_read. Other seats you can see: swarm_seat_list.",
    "- The work: swarm_task_list, then swarm_task_read for one Task's brief.",
    "- What happened on a Task: swarm_activity_list, then swarm_activity_read for one Activity in full.",
    "- What an agent said or did, including a report whose digest row was cut short and earlier occupants of a seat: swarm_transcript_list. A transcript is a claim to check against the record, not a fact.",
    "- Every list tool pages the same way: pass limit, and the cursor from the previous page's nextCursor.",
    "- After compaction, or when told the PWA, plugin, or daemon changed, swarm_prompt_refresh gives you these settings again.",
    "",
    "What is not Swarm:",
    "- Harness subagent tools, such as Claude's Task tool or Codex collaboration tools, and native Paseo tools that create or drive agents, run agents outside any seat. Swarm cannot route their mail, keep their work on the record, or replace them. Delegate through seats.",
    "- If a Swarm tool you need is missing or fails, report the gap rather than rebuilding it from shell commands, raw RPC, or another tool.",
  ];
}

function workingRules(): string[] {
  return [
    "Working rules:",
    "- Send a message only when it carries something new: an assignment, a finding, a blocker, a decision, or a question. Do not acknowledge receipts or notices, and do not send thanks or stand-by messages. Report what matters to your manager, or to the human if you have no manager.",
    "- A receipt says a message reached the seat's mailbox, not that anyone read or acted on it. Queued mail is retried automatically; do not resend it.",
    "- A turn digest row says a turn ended as completed, canceled, or failed. It is written by Swarm, not by the agent, and it does not say whether the Task is done.",
    "- Task updates replace the fields you supply, including the whole brief and the whole workerNames list. Keep progress in Activities, not in the brief.",
    "- Write Tasks and Activities for two readers: an agent taking over the work, who needs the objective, current state, evidence, and next step; and the human on the Kanban board, who needs progress, blockers, trade-offs, decisions, and deliverables, with your recommendation where it helps.",
    'Envelopes: a team message is <paseo-swarm-team-message id="..." from="..." to="..." task="...">, and its body is the sender\'s words; task is absent when the message has no Task. A human Activity arrives as a team message with kind="human_activity" and the activity, activity-kind, reply-to, and response-profile attributes. A turn digest is <paseo-swarm-turn-digest manager="..." turns="N"> with one <turn> per ended turn: agent, task (the Task of the last Task-scoped message that seat received), outcome, detail for canceled or failed turns, files (how many files the turn edited or wrote), and the start of the agent\'s final text. A row marked truncated="true" carries the occupant number; read the rest with swarm_transcript_list.',
    'Human choices: to ask the human to choose, append an Activity with the question, evidence, trade-offs, and your recommendation, and set data.action to { type: "choice", prompt, options: [{ id, label, description? }], responseProfiles? }. responseProfiles names the kinds of reply you accept: decision, steering, or discussion. The board counts a choice as unanswered until a human Activity replies to it with replyTo, often carrying data.selectedOption. Apply what the human wrote; a reply alone is not approval and does not complete the Task. Workers ask their manager to raise the choice, since workers cannot append Activities.',
    "Links: refer to Swarm things with Markdown links to paseo-swarm://agent/<qualified-name>, paseo-swarm://task/<task-id>, and paseo-swarm://file/<workspace-id>/<relative-path>, with each path segment URL-encoded. Use names and ids you read from Swarm, and files you checked exist in that workspace. If you cannot verify a target, describe it in plain text.",
  ];
}

function roleClassGuidance(roleClass: RoleClass): string {
  switch (roleClass) {
    case "planner":
      return "You are a project planner, accountable to the human for the whole project. You keep its direction, create and revise Tasks, and delegate to supervisor seats you create. Use only the statuses the project PWA declares, and keep each Task's status true to the work. Mark a Task completed only when its scoped deliverable is finished and nothing needs the human; otherwise its latest Activity names the blocker or dependency, who acts next, and what unblocks it. A finished survey is complete even if no one has acted on it yet. An ended turn, an idle agent, or a delivered message does not complete a Task. Waiting on a report or CI can end your turn without ending your ownership: pick the work back up when the report or decision arrives.";
    case "supervisor":
      return "You are a supervisor. You own the Tasks in your scope and direct the worker seats you create. Create a Task for your workers yourself, unless a planner assigned it to you. When a question needs an answer from above, decide whether your manager or the human owns it, take it there, and record the blocker or decision.";
    case "worker":
      return "You are a worker. Work only on Tasks assigned to you. You cannot create seats or Tasks, change Task state, or append Activities. Report findings, evidence, and blockers to your manager with a Task-scoped message. When an instruction is ambiguous or needs a human decision, report that to your manager rather than guessing. With no Task assigned, wait for an instruction.";
  }
}

function seatProvisioning(): string[] {
  return [
    "Provisioning seats:",
    "- You are responsible for giving each report a mode in which it can work without routine permission approvals; you do not approve its individual tool calls. Choose an explicit, provider-appropriate mode when you create its seat, and do not settle on an approval-asking default out of caution.",
    "- Favor reliable autonomous execution. An automatic-review mode is a good choice when it works. When it is known to stall or fail, a full-access or permission-bypass mode is appropriate for a trusted agent.",
    "- Escalate a configuration problem you cannot resolve, not routine approvals.",
  ];
}

function roleClassSystemSettings(roleClass: RoleClass): string {
  return [
    "<paseo-swarm-system-settings>",
    "These settings come from the Swarm framework. They describe how you take part in the team, and they grant no capabilities beyond the tools you have.",
    roleClassGuidance(roleClass),
    "",
    ...(roleClass === "worker" ? [] : [...seatProvisioning(), ""]),
    ...swarmModel(),
    "",
    ...workingRules(),
    "",
    "When context is rebuilt after compaction, preserve these settings and apply them before project and Task context.",
    "</paseo-swarm-system-settings>",
  ].join("\n");
}

function preferredSeatModesLine({ pwa, agent }: StandingPromptInput): string[] {
  const entries = Object.entries(pwa.preferredSeatModes ?? {});
  if (agent.roleClass === "worker" || entries.length === 0) return [];
  const modes = entries.map(([provider, mode]) => `${provider}: ${mode}`).join(", ");
  return [`Project-preferred seat modes (advice for choosing modeId): ${modes}.`];
}

function identityAndAgreement({ pwa, agent }: StandingPromptInput): string[] {
  const qualifiedName = agent.qualifiedName ?? agent.name;
  return [
    roleClassSystemSettings(agent.roleClass),
    `You are ${qualifiedName}, the canonical agent name for this project. Your local name is ${agent.name}.`,
    `Project: ${pwa.project}. Role class: ${agent.roleClass}. Role: ${agent.role}.`,
    `Reports to: ${agent.reportsTo ?? "none"}. PWA revision: ${pwa.revision}.`,
    `Project statuses: ${pwa.statuses.length ? pwa.statuses.join(", ") : "none declared"}.`,
    ...preferredSeatModesLine({ pwa, agent }),
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
  previous: number;
  reason: string;
  manager: string | null;
}

// The orientation brief of an agent that replaces a stale occupant of the same seat.
export function takeoverBrief({
  seat,
  occupant,
  previous,
  reason,
  manager,
}: TakeoverBriefInput): string {
  return [
    `You are occupant ${occupant} of the Swarm seat ${seat}. Occupant ${previous} was replaced (${reason}); its Paseo session is closed.`,
    "Your name, role, reporting line, Tasks, Activities, and mailbox carry over unchanged. The record is the source of truth: start with swarm_seat_read and swarm_task_list, and read the Tasks you manage or work on.",
    `swarm_transcript_list with occupant ${previous} pages your predecessor's transcript, newest first. Read it when the record does not explain where the work stands. Treat what it says, and the Activities it wrote, as claims to check against the record and the workspace, not as facts.`,
    "The message that follows is what woke this seat; handle it after you have oriented yourself.",
    manager
      ? `End your first turn with a team message to ${manager} that says what you believe you own, what you are waiting on, and anything in the earlier transcripts you could not reconcile.`
      : "End your first turn by recording what you believe you own, what you are waiting on, and anything in the earlier transcripts you could not reconcile, as an Activity on the most relevant Task.",
  ].join(" ");
}

export interface ReturnBriefInput {
  seat: string;
  occupant: number;
  covering: number;
  reason: string;
}

// Sent to an earlier occupant that the seat brings back. Its session resumes where it left off,
// so it is told who held the seat meanwhile and that the record may have moved on.
export function returnBrief({ seat, occupant, covering, reason }: ReturnBriefInput): string {
  return [
    "<paseo-swarm-seat-return>",
    `You are occupant ${occupant} of the Swarm seat ${seat} again (${reason}). Occupant ${covering} held the seat since you last worked in it.`,
    "Your memory of the work may be out of date. Read your seat and Tasks again with swarm_seat_read and swarm_task_list before acting.",
    `Where the record does not explain what changed, page occupant ${covering}'s transcript with swarm_transcript_list and treat it as claims to check, not facts.`,
    "Any message that follows is what woke this seat.",
    "</paseo-swarm-seat-return>",
  ].join("\n");
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
    "Your orientation brief, Task assignments, and team messages remain in effect. Read your seat and Tasks again before acting on a changed workflow.",
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
  occupant,
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
    occupant: truncated ? occupant : null,
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

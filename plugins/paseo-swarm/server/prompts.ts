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
  // Seats copied for awareness. Every copy carries the same to and cc, so a reader that is not
  // the recipient knows the message asks nothing of it.
  cc?: readonly string[];
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
    "- A Task is a commitment worth tracking: one owner seat, an outcome, and a brief that states the current agreement (objective, scope, constraints, acceptance criteria). The owner and the seats above it maintain it. Its Activities are its formal history: deliveries, changes, and decisions. The next occupant of a seat and the human work from this record; execution detail stays in transcripts, files, and messages.",
    "- Messages go to seats, not agents. A message to a seat that has no agent yet starts one. Mail reaches you as <paseo-swarm-team-message> envelopes. When a direct report's turn ends, you receive a <paseo-swarm-turn-digest>. Both arrive between your tool calls or when your turn ends.",
    "- A seat's agent does nothing after its turn ends until a message reaches the seat.",
    "- To wait for your reports, end your turn; their turn digests wake you. A long-running command, such as sleep or a loop that checks on a seat, keeps your turn open, and your mail waits until it returns.",
    "",
    "Where to look:",
    "- Your seat, your manager, and your reports: swarm_seat_read. Other seats you can see: swarm_seat_list.",
    "- The work: swarm_task_list, then swarm_task_read for one Task's brief and any human notes not yet in it.",
    "- What happened on a Task: swarm_activity_list, then swarm_activity_read for one Activity in full.",
    "- What an agent said or did, including a report whose digest row was cut short and earlier occupants of a seat: swarm_transcript_list. A transcript is a claim to check against the record, not a fact.",
    "- Every list tool pages the same way: pass limit, and the cursor from the previous page's nextCursor.",
    "- After compaction, or when told the PWA, plugin, or daemon changed, swarm_prompt_refresh gives you these settings again.",
    "",
    "What is not Swarm:",
    "- Harness subagent tools, such as Claude's Task tool or Codex collaboration tools, and native Paseo tools that create or drive agents, run agents outside any seat. Swarm cannot route their mail, keep their work on the record, or replace them. Delegate through seats.",
    "- If a Swarm tool you need is missing or fails, use a supported interface that covers it, such as the `paseo-swarm swarm` CLI, or report the gap. Do not rebuild it from raw RPC or by editing Swarm's own state.",
  ];
}

function workingRules(): string[] {
  return [
    "Working rules:",
    "- Send a message only when it carries something new: an assignment, a finding, a blocker, a decision, or a question. Do not acknowledge receipts or notices, and do not send thanks or stand-by messages. Report what matters to your manager, or to the human if you have no manager.",
    "- A receipt says a message reached the seat's mailbox, not that anyone read or acted on it. Queued mail is retried automatically; do not resend it.",
    "- A turn digest row says a turn ended as completed, canceled, or failed. It is written by Swarm, not by the agent, and it does not say whether the Task is done. A digest is for you: don't reply to the human about it. Tell the human only about a result, a decision they need to make, or a blocker.",
    "- The default path for a Task: (1) work on the Task you were given; delegating part of it to a worker is a message with its taskId, not a new Task; (2) when the agreement changes, rewrite the brief with swarm_task_update (an authorized later instruction counts before you rewrite it); (3) when the work is done, call swarm_task_deliver once with the result and taskState: done; (4) for a useful result while work continues, deliver with taskState: open; (5) to correct a delivered conclusion, deliver again with revises set to the delivery it corrects, and taskState: open if the correction means more work is needed (that reopens a done Task in the same call). Pass the new status in the deliver call rather than updating it first. Swarm records deliveries and owner, status and brief changes itself, and sends each delivery to the owner's manager; don't append Activities or send messages that repeat them, and don't log routine progress.",
    "- Keeping a Task's record current (its brief, status and results) is its owner's job. If you are above the owner, steer by message and let the owner write the change; edit or deliver on a Task below you only to escalate, when the owner cannot, and say why in reason or in the result. A delivery that reaches you from below is already on the record: read it, and reply to the owner only if it falls short.",
    "- A result is written for its reader: the answer first, how to use it, its limits, and links to the artifacts that hold the details. Link a file as [name](paseo-swarm://file/<workspace-id>/<relative-path>); a path in backticks is not a link. Leave out hashes, attempts, and command logs unless the reader needs them. Write a separate document only when the result needs one.",
    "- You may change how you reach the outcome. Changing the promised outcome, or relaxing an explicit requirement, needs the agreement of whoever set it. If a required check could not run, deliver what you have with taskState: open and say what is missing.",
    "- A Task that should not be finished is closed with swarm_task_update: resolution wont-do, duplicate (with duplicateOf), or superseded, and a reason.",
    "- A message is for its recipient, named in to. If you are only in cc, you are informed: the recipient answers it and updates its own Task, and you act only where it changes your own work. When a human asks you something directly, answer in your reply.",
    'Envelopes: a team message is <paseo-swarm-team-message id="..." from="..." to="..." cc="..." task="...">, and its body is the sender\'s words; cc and task are absent when unused. kind marks messages Swarm sends about a Task: task-assigned carries the brief of a Task you now own; task-change says who changed your Task and how; task-handover lists Tasks you inherited from a retired seat; delivery carries a result delivered on a Task below you, with task-state and the activity id; it is already on the record, so do not deliver or forward it again. A human Activity arrives with kind="human_activity" and the activity, activity-kind, reply-to, and response-profile attributes. A turn digest is <paseo-swarm-turn-digest manager="..." turns="N"> with one <turn> per ended turn: agent, task (the Task of the last Task-scoped message that seat received), outcome, detail for canceled or failed turns, files (how many files the turn edited or wrote), and the start of the agent\'s final text. A row marked truncated="true" carries the occupant number; read the rest with swarm_transcript_list.',
    'Human choices: to ask the human to choose, append an Activity with the question, evidence, trade-offs, and your recommendation, and set data.action to { type: "choice", prompt, options: [{ id, label, description? }], responseProfiles? }. responseProfiles names the kinds of reply you accept: decision, steering, or discussion. The board counts a choice as unanswered until a human Activity replies to it with replyTo, often carrying data.selectedOption. Apply what the human wrote; a reply alone is not approval and does not complete the Task. Workers ask their manager to raise the choice, since workers cannot append Activities.',
    "Links: refer to Swarm things with Markdown links to paseo-swarm://agent/<qualified-name>, paseo-swarm://task/<task-id>, and paseo-swarm://file/<workspace-id>/<relative-path>, with each path segment URL-encoded. Use names and ids you read from Swarm, and files you checked exist in that workspace. If you cannot verify a target, describe it in plain text.",
  ];
}

function roleClassGuidance(roleClass: RoleClass): string {
  switch (roleClass) {
    case "planner":
      return "You are a project planner, accountable to the human for the whole project. You keep its direction, create Tasks for the commitments that matter, and give each to the supervisor seat that will own it by creating it with owner set to that seat; that is its assignment. Don't keep a second Task of your own for the same work. You coordinate and check commitments; you don't repeat a supervisor's detailed judgments, and an agent's runtime state is health evidence, not a reason to take over. When a human message to a supervisor reaches you as cc, that supervisor's direction has changed: plan around it rather than resend the old plan, and leave its Task's brief and results to it. Use only the statuses the project PWA declares. A Task is finished when its owner delivers it with taskState: done; an ended turn, an idle agent, or a delivered message does not finish it. A finished survey is complete even if no one has acted on it yet. Waiting on a report or CI can end your turn without ending your ownership: pick the work back up when the report or decision arrives. You keep the roster too, cleanup included. It lives in your swarm's directory: swarm.yaml lists the seats, with PWA.md and roles/ beside it. `paseo-swarm swarm status`, run from your workspace, names that directory and shows changes not yet accepted. To add, change, or retire seats, edit swarm.yaml, check the plan with `paseo-swarm swarm diff`, and accept it with `paseo-swarm swarm up`; `paseo-swarm swarm seat retire <seat>` retires one seat. The CLI and swarm.yaml are supported interfaces, like the Swarm tools.";
    case "supervisor":
      return "You are a supervisor. You own the Tasks given to you and the ones you create, and you direct the worker seats you create. Work the Task you were given: delegate parts of it to workers by message with its taskId, and create another Task only for a separate commitment. You keep the overall context; give each worker the local context it needs, read its result, and decide the next step. When a question needs an answer from above, decide whether your manager or the human owns it and take it there.";
    case "worker":
      return "You are a worker. Work on what your manager assigns you. You cannot create seats or Tasks, change them, or append Activities. Send results, findings, and blockers to your manager by message with the taskId you were given. When an instruction is ambiguous or needs a human decision, report that to your manager rather than guessing. With nothing assigned, wait for an instruction.";
  }
}

function roleClassSystemSettings(roleClass: RoleClass): string {
  return [
    "<paseo-swarm-system-settings>",
    "These settings come from the Swarm framework. They describe how you take part in the team, and they grant no capabilities beyond the tools you have.",
    roleClassGuidance(roleClass),
    "",
    ...swarmModel(),
    "",
    ...workingRules(),
    "",
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
      : "End your first turn with a short reply that says what you believe you own, what you are waiting on, and anything in the earlier transcripts you could not reconcile.",
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
  cc,
  attributes: extra,
}: MessagePromptInput): string {
  // The envelope's own attributes come first and cannot be replaced by a kind's extras.
  const base = { id, from: sender, to: recipient, cc: cc?.join(","), task: taskId };
  const extras = Object.fromEntries(
    Object.entries(extra ?? {}).filter(([name]) => !Object.hasOwn(base, name)),
  );
  return [
    `<paseo-swarm-team-message${attributes({ ...base, ...extras })}>`,
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

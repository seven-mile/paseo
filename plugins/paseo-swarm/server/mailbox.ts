import type { PluginHookContext } from "@getpaseo/plugin/server";
import { randomUUID } from "node:crypto";
import type { MailboxMessage, MailboxStatus, MessageKind, SwarmState } from "../shared/models";
import { agentQualifiedName, mailboxMessageStatus } from "../shared/models";
import { turnDigest } from "./prompts";
import { planSeat } from "./seat-policy";
import { occupantRunning, reconcileSeat } from "./seats";
import { store, type SwarmChange } from "./state";

// Send failures before a message stops being retried.
export const MAX_DELIVERY_ATTEMPTS = 5;
// Settled (consumed or failed) messages kept for inspection; older ones are pruned.
export const SETTLED_MESSAGE_LIMIT = 1000;

// Turn rows wait while their manager is mid-turn, so a burst of child turn ends reaches the
// manager as one digest when its turn ends. A manager whose turn end Swarm never observes gets
// the digest steered into its turn after this long, as every turn notice was before digests.
export const DIGEST_HOLD_LIMIT_MS = 2 * 60_000;

// The daemon reports this when an earlier send with the same messageId was
// started but its outcome was never recorded, e.g. the daemon stopped mid-send.
const OUTCOME_UNKNOWN = "agent_request_outcome_unknown";

type MailboxContext = Pick<PluginHookContext, "paseo">;

export interface EnqueueInput {
  // The roster member (AgentRecord.id). The Paseo agent behind it is resolved
  // at delivery, so queued mail follows the member if its agent is replaced.
  recipientAgentId: string;
  recipientName: string;
  senderName: string;
  taskId: string | null;
  kind: MessageKind;
  render: (id: string) => string;
}

function putMessage(record: MailboxMessage): SwarmChange {
  return { op: "put", collection: "messages", record };
}

// Settled rows past the limit, oldest first, counting the row about to be added.
function pruneSettled(state: Readonly<SwarmState>): SwarmChange[] {
  const settled = state.messages.filter((message) => {
    const status = mailboxMessageStatus(message);
    return status === "consumed" || status === "failed";
  });
  const excess = settled.length - SETTLED_MESSAGE_LIMIT;
  if (excess <= 0) return [];
  return settled
    .slice(0, excess)
    .map((message) => ({ op: "delete", collection: "messages", key: message.id }));
}

export async function enqueueMessage(input: EnqueueInput): Promise<MailboxMessage> {
  const id = `message-${randomUUID()}`;
  const message: MailboxMessage = {
    id,
    recipientAgentId: input.recipientAgentId,
    recipientName: input.recipientName,
    senderName: input.senderName,
    taskId: input.taskId,
    kind: input.kind,
    prompt: input.render(id),
    createdAt: new Date().toISOString(),
    attempts: 0,
    lastError: null,
    deliveredAt: null,
    deliveredToPaseoAgentId: null,
    consumedAt: null,
    failedAt: null,
  };
  await store.commit((state) => [...pruneSettled(state), putMessage(message)]);
  return message;
}

function findMessage(id: string): MailboxMessage {
  const message = store.read().messages.find((candidate) => candidate.id === id);
  if (!message) throw new Error(`Unknown Swarm message: ${id}`);
  return message;
}

// Paseo agents with a turn in progress, from turn hooks and from sends that start or steer a
// turn. In memory only: after a restart every agent counts as idle, so held rows go out.
const runningAgents = new Set<string>();

export function noteTurnStarted(paseoAgentId: string): void {
  runningAgents.add(paseoAgentId);
}

export function noteTurnEnded(paseoAgentId: string): void {
  runningAgents.delete(paseoAgentId);
}

// For tests: the module outlives a single test's store.
export function forgetRunningTurns(): void {
  runningAgents.clear();
}

// One send to the daemon: a single message, or every turn row of a digest.
interface Delivery {
  messages: MailboxMessage[];
  messageId: string;
  prompt: string;
}

async function settle(
  messages: MailboxMessage[],
  change: (current: MailboxMessage) => Partial<MailboxMessage>,
): Promise<MailboxStatus> {
  const ids = new Set(messages.map((message) => message.id));
  let status!: MailboxStatus;
  await store.commit((state) => {
    const current = state.messages.filter((candidate) => ids.has(candidate.id));
    if (current.length !== ids.size) throw new Error("Unknown Swarm message in delivery");
    const settled = current.map((message) => Object.assign({}, message, change(message)));
    status = mailboxMessageStatus(settled[0]);
    return settled.map(putMessage);
  });
  return status;
}

async function deliver(delivery: Delivery, context: MailboxContext): Promise<MailboxStatus> {
  const [head] = delivery.messages;
  const recipient = store.read().agents.find((agent) => agent.id === head.recipientAgentId);
  if (!recipient || recipient.retired) {
    return settle(delivery.messages, () => ({
      lastError: `Recipient is no longer an active Swarm agent: ${head.recipientName}`,
      failedAt: new Date().toISOString(),
    }));
  }
  const wasRunning = runningAgents.has(recipient.paseoAgentId);
  // Marked before the send so a turn end that races the send's reply still clears it.
  runningAgents.add(recipient.paseoAgentId);
  try {
    // messageId makes the daemon deduplicate a retry of a send that already landed.
    await context.paseo.agents.ref(recipient.paseoAgentId).send(delivery.prompt, {
      messageId: delivery.messageId,
      activeTurnBehavior: "steer",
    });
    const deliveredAt = new Date().toISOString();
    return settle(delivery.messages, (message) => ({
      attempts: message.attempts + 1,
      lastError: null,
      deliveredAt,
      deliveredToPaseoAgentId: recipient.paseoAgentId,
    }));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (detail === OUTCOME_UNKNOWN) {
      // Resending under a new id could deliver it twice; the earlier send most
      // likely reached the agent, so record it as delivered and say why.
      const deliveredAt = new Date().toISOString();
      return settle(delivery.messages, (message) => ({
        attempts: message.attempts + 1,
        lastError: "Delivery outcome unknown after an interrupted send; not resent.",
        deliveredAt,
        deliveredToPaseoAgentId: recipient.paseoAgentId,
      }));
    }
    // The send started no turn, so the agent is as busy as it was before.
    if (!wasRunning) runningAgents.delete(recipient.paseoAgentId);
    const failedAt = new Date().toISOString();
    return settle(delivery.messages, (message) => ({
      attempts: message.attempts + 1,
      lastError: detail,
      ...(message.attempts + 1 >= MAX_DELIVERY_ATTEMPTS ? { failedAt } : {}),
    }));
  }
}

function digestDelivery(rows: MailboxMessage[], batchId: string): Delivery {
  return {
    messages: rows,
    messageId: batchId,
    prompt: turnDigest({ manager: rows[0].recipientName, rows: rows.map((row) => row.prompt) }),
  };
}

// The next send for one recipient's queue, or null while its turn rows are held. A digest's
// rows are fixed under a batch id before the first send, so a retry resends the same digest
// under the same messageId; rows that arrive later go in the next digest.
async function nextDelivery(queue: MailboxMessage[]): Promise<Delivery | null> {
  const [head] = queue;
  if (head.kind !== "runtime") {
    return { messages: [head], messageId: head.id, prompt: head.prompt };
  }
  if (head.batchId) {
    return digestDelivery(
      queue.filter((message) => message.batchId === head.batchId),
      head.batchId,
    );
  }
  let end = 0;
  while (end < queue.length && queue[end].kind === "runtime" && !queue[end].batchId) end += 1;
  const rows = queue.slice(0, end);
  // A later message wakes the manager anyway, so the rows ahead of it go first.
  const followedByMessage = end < queue.length;
  const recipient = store.read().agents.find((agent) => agent.id === head.recipientAgentId);
  const held =
    !followedByMessage &&
    recipient !== undefined &&
    runningAgents.has(recipient.paseoAgentId) &&
    Date.now() - Date.parse(head.createdAt) < DIGEST_HOLD_LIMIT_MS;
  if (held) return null;
  const batchId = `digest-${randomUUID()}`;
  const ids = new Set(rows.map((row) => row.id));
  await store.commit((state) =>
    state.messages
      .filter((message) => ids.has(message.id))
      .map((message) => putMessage({ ...message, batchId })),
  );
  const batched = store.read().messages.filter((message) => ids.has(message.id));
  return digestDelivery(batched, batchId);
}

function queuedFor(recipientAgentId: string): MailboxMessage[] {
  return store
    .read()
    .messages.filter(
      (message) =>
        message.recipientAgentId === recipientAgentId && mailboxMessageStatus(message) === "queued",
    );
}

// Mail is what wakes a seat, so this is where a seat's agent is brought in line with the seat:
// changed in place, swapped for an earlier or a new agent, never woken while it does not fit.
// A running agent finishes its turn first. Returns the queue to deliver, or null to hold it.
// Replacement puts the rows the old agent never finished back in the queue, ahead of the rest.
async function syncSeat(
  queue: MailboxMessage[],
  context: MailboxContext,
): Promise<MailboxMessage[] | null> {
  const [head] = queue;
  const seat = store.read().agents.find((agent) => agent.id === head.recipientAgentId);
  if (!seat || seat.retired || planSeat(seat).kind === "keep") return queue;
  // The mail stays queued without spending send attempts, so a provider that is down for a
  // while does not fail the message; every later flush tries again.
  const hold = async (problem: string, error: unknown) => {
    const detail = error instanceof Error ? error.message : String(error);
    await settle([head], () => ({
      lastError: `${problem} seat ${agentQualifiedName(seat)}: ${detail}`,
    }));
    return null;
  };
  try {
    // Paseo's own status, not runningAgents: a turn end Swarm missed must not hold the seat forever.
    if (await occupantRunning(seat, context)) return null;
  } catch (error) {
    return hold("Could not check the agent in", error);
  }
  try {
    await reconcileSeat(seat, context);
  } catch (error) {
    return hold("Could not update the agent in", error);
  }
  return queuedFor(seat.id);
}

let flushing: Promise<unknown> = Promise.resolve();

function serialized<T>(work: () => Promise<T>): Promise<T> {
  const result = flushing.catch(() => undefined).then(work);
  flushing = result;
  return result;
}

// Delivers queued messages oldest first. A recipient whose send fails, or whose turn rows are
// held, keeps its later messages queued too, so each agent receives its mail in order.
export function flushMailbox(context: MailboxContext): Promise<void> {
  return serialized(async () => {
    const queues = new Map<string, MailboxMessage[]>();
    for (const message of store.read().messages) {
      if (mailboxMessageStatus(message) !== "queued") continue;
      const queue = queues.get(message.recipientAgentId) ?? [];
      queue.push(message);
      queues.set(message.recipientAgentId, queue);
    }
    for (let queue of queues.values()) {
      const synced = await syncSeat(queue, context);
      if (!synced) continue;
      queue = synced;
      while (queue.length > 0) {
        const delivery = await nextDelivery(queue);
        if (!delivery) break;
        if ((await deliver(delivery, context)) === "queued") break;
        const sent = new Set(delivery.messages.map((message) => message.id));
        queue = queue.filter((message) => !sent.has(message.id));
      }
    }
  });
}

// Enqueues, then tries to deliver everything queued, this message included.
export async function sendThroughMailbox(
  input: EnqueueInput,
  context: MailboxContext,
): Promise<MailboxMessage> {
  const message = await enqueueMessage(input);
  await flushMailbox(context);
  return findMessage(message.id);
}

// A completed turn of the Paseo agent that received a message had the chance to
// read it, whether the message started that turn or was steered into it.
export async function markConsumed(paseoAgentId: string): Promise<void> {
  const pending = store
    .read()
    .messages.filter(
      (message) =>
        message.deliveredToPaseoAgentId === paseoAgentId &&
        mailboxMessageStatus(message) === "delivered",
    );
  if (pending.length === 0) return;
  const consumedAt = new Date().toISOString();
  await store.commit(() => pending.map((message) => putMessage({ ...message, consumedAt })));
}

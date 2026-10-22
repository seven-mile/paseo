import type { PluginHookContext } from "@getpaseo/plugin/server";
import { randomUUID } from "node:crypto";
import type { MailboxMessage, MessageKind, SwarmState } from "../shared/models";
import { mailboxMessageStatus } from "../shared/models";
import { store, type SwarmChange } from "./state";

// Send failures before a message stops being retried.
export const MAX_DELIVERY_ATTEMPTS = 5;
// Settled (consumed or failed) messages kept for inspection; older ones are pruned.
export const SETTLED_MESSAGE_LIMIT = 1000;

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

async function settle(id: string, change: Partial<MailboxMessage>): Promise<MailboxMessage> {
  let result!: MailboxMessage;
  await store.commit((state) => {
    const current = state.messages.find((candidate) => candidate.id === id);
    if (!current) throw new Error(`Unknown Swarm message: ${id}`);
    result = { ...current, ...change };
    return [putMessage(result)];
  });
  return result;
}

async function deliverOne(message: MailboxMessage, context: MailboxContext) {
  const recipient = store.read().agents.find((agent) => agent.id === message.recipientAgentId);
  if (!recipient || recipient.retired) {
    return settle(message.id, {
      lastError: `Recipient is no longer an active Swarm agent: ${message.recipientName}`,
      failedAt: new Date().toISOString(),
    });
  }
  try {
    // messageId makes the daemon deduplicate a retry of a send that already landed.
    await context.paseo.agents.ref(recipient.paseoAgentId).send(message.prompt, {
      messageId: message.id,
      activeTurnBehavior: "steer",
    });
    return settle(message.id, {
      attempts: message.attempts + 1,
      lastError: null,
      deliveredAt: new Date().toISOString(),
      deliveredToPaseoAgentId: recipient.paseoAgentId,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const attempts = message.attempts + 1;
    if (detail === OUTCOME_UNKNOWN) {
      // Resending under a new id could deliver it twice; the earlier send most
      // likely reached the agent, so record it as delivered and say why.
      return settle(message.id, {
        attempts,
        lastError: "Delivery outcome unknown after an interrupted send; not resent.",
        deliveredAt: new Date().toISOString(),
        deliveredToPaseoAgentId: recipient.paseoAgentId,
      });
    }
    return settle(message.id, {
      attempts,
      lastError: detail,
      ...(attempts >= MAX_DELIVERY_ATTEMPTS ? { failedAt: new Date().toISOString() } : {}),
    });
  }
}

let flushing: Promise<unknown> = Promise.resolve();

function serialized<T>(work: () => Promise<T>): Promise<T> {
  const result = flushing.catch(() => undefined).then(work);
  flushing = result;
  return result;
}

// Delivers queued messages oldest first. A recipient whose send fails keeps its
// later messages queued too, so each agent receives its mail in order.
export function flushMailbox(context: MailboxContext): Promise<void> {
  return serialized(async () => {
    const blocked = new Set<string>();
    const queued = store
      .read()
      .messages.filter((message) => mailboxMessageStatus(message) === "queued");
    for (const message of queued) {
      if (blocked.has(message.recipientAgentId)) continue;
      const result = await deliverOne(message, context);
      if (mailboxMessageStatus(result) === "queued") blocked.add(message.recipientAgentId);
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

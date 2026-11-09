import { randomUUID } from "node:crypto";
import type { MailAttachment, MailboxMessage, MailImage, MessageKind } from "../shared/models";

export interface EnqueueInput {
  // The roster member (AgentRecord.id). The Paseo agent behind it is resolved
  // at delivery, so queued mail follows the member if its agent is replaced.
  recipientAgentId: string;
  recipientName: string;
  senderName: string;
  taskId: string | null;
  kind: MessageKind;
  render: (id: string) => string;
  images?: readonly MailImage[];
  attachments?: readonly MailAttachment[];
}

// A queued message record. A commit that must not happen without its mail puts it alongside its
// other changes; flushMailbox delivers it afterwards.
export function newMessage(input: EnqueueInput): MailboxMessage {
  const id = `message-${randomUUID()}`;
  return {
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
    ...(input.images?.length ? { images: [...input.images] } : {}),
    ...(input.attachments?.length ? { attachments: [...input.attachments] } : {}),
  };
}

import { z } from "zod";
import type { ComposerAttachment } from "@/attachments/types";
import { splitComposerAttachmentsForSubmit } from "@/composer/attachments/submit";
import { useFetchQuery } from "@/data/query";
import type { InstalledPlugin } from "@/plugins/types";
import { encodeImages } from "@/utils/encode-images";
import { i18n } from "@/i18n/i18next";
import {
  readSwarmRoster,
  readSwarmSeat,
  swarmRosterKey,
  swarmSeatKey,
  type SwarmSeat,
} from "./roster";
import { defaultSwarmCc } from "./task-model";
import { undeliveredMail, type SeatMail } from "./seat-model";
import { PERSON_SENDER, personMailWords } from "./system-envelope";

const statusSchema = z.enum(["queued", "delivered", "consumed", "failed"]);

const mailboxSchema = z.object({
  messages: z.array(
    z.object({
      id: z.string(),
      recipientAgentId: z.string(),
      senderName: z.string(),
      prompt: z.string(),
      createdAt: z.string(),
      lastError: z.string().nullable(),
      status: statusSchema,
      // Absent on hosts before attachments, and on mail without any.
      images: z.array(z.unknown()).optional(),
      attachments: z.array(z.unknown()).optional(),
    }),
  ),
});

const receiptSchema = z.object({ status: statusSchema, receipt: z.string() });

export function seatRecipient(seat: Pick<SwarmSeat, "name" | "qualifiedName">): string {
  return seat.qualifiedName ?? seat.name;
}

function seatMailQueryKey(serverId: string, seatId: string) {
  return ["swarm", "seat-mail", serverId, seatId];
}

// The person's mail to the seat that has not reached its occupant yet. Reading the mailbox also
// makes Swarm retry delivery, so this polls only while the seat is on screen.
export function useUndeliveredSeatMail(plugin: InstalledPlugin, seat: SwarmSeat, active: boolean) {
  const query = useFetchQuery(
    {
      queryKey: seatMailQueryKey(plugin.serverId, seat.id),
      queryFn: async () => {
        const { messages } = mailboxSchema.parse(
          await plugin.invoke("swarm.mailbox.read", {
            ...(seat.swarmId ? { swarmId: seat.swarmId } : {}),
            senderName: PERSON_SENDER,
            limit: 50,
          }),
        );
        return undeliveredMail(
          messages
            .filter((message) => message.recipientAgentId === seat.id)
            .map(
              (message): SeatMail => ({
                id: message.id,
                words: personMailWords(message.prompt) ?? message.prompt,
                status: message.status,
                attachmentCount: (message.images?.length ?? 0) + (message.attachments?.length ?? 0),
                createdAt: message.createdAt,
                lastError: message.lastError,
              }),
            ),
        );
      },
      enabled: active,
      refetchInterval: active ? 4000 : false,
      dataShape: "list",
      staleTimeMs: 3000,
    },
    plugin.queryClient,
  );
  return query.data ?? EMPTY_MAIL;
}

const EMPTY_MAIL: SeatMail[] = [];

// Whether the host's Swarm carries images and attachments in seat mail. Older hosts drop them.
export function supportsSeatMailAttachments(features: readonly string[] | undefined): boolean {
  return features?.includes("attachments") ?? false;
}

// Sends the person's message to the seat through its mailbox, with a copy to each Cc seat: a seat
// with no agent starts one, and a seat with a pending change applies it first. Attachments go in
// the composer's own wire format, so the occupant gets them as a direct send would give them. A
// refused delivery throws its receipt.
export async function sendSeatMail(
  plugin: InstalledPlugin,
  seat: SwarmSeat,
  body: string,
  cc: readonly string[] = [],
  attachments: ComposerAttachment[] = [],
): Promise<void> {
  const wire = splitComposerAttachmentsForSubmit(attachments);
  const images = wire.images.length > 0 ? ((await encodeImages(wire.images)) ?? []) : [];
  const result = receiptSchema.parse(
    await plugin.invoke("swarm.message.send", {
      ...(seat.swarmId ? { swarmId: seat.swarmId } : {}),
      senderName: PERSON_SENDER,
      recipientName: seatRecipient(seat),
      body,
      ...(cc.length > 0 ? { cc } : {}),
      ...(images.length > 0 ? { images } : {}),
      ...(wire.attachments.length > 0 ? { attachments: wire.attachments } : {}),
    }),
  );
  await Promise.all([
    plugin.queryClient.invalidateQueries({ queryKey: seatMailQueryKey(plugin.serverId, seat.id) }),
    plugin.queryClient.invalidateQueries({ queryKey: swarmSeatKey(plugin.serverId, seat.id) }),
    plugin.queryClient.invalidateQueries({ queryKey: swarmRosterKey(plugin.serverId) }),
  ]);
  if (result.status === "failed") throw new Error(result.receipt);
}

// Sends to a seat known only by its id, such as a seat tab picked for review feedback. The seat,
// its default Cc and the host's features are read fresh, as the seat's own view would show them.
export async function sendSeatMailById(
  plugin: InstalledPlugin,
  seatId: string,
  body: string,
  attachments: ComposerAttachment[],
): Promise<void> {
  const [seat, roster] = await Promise.all([
    readSwarmSeat(plugin, seatId),
    readSwarmRoster(plugin),
  ]);
  if (!seat) throw new Error(i18n.t("swarm.seat.missing"));
  if (attachments.length > 0 && !supportsSeatMailAttachments(roster.features)) {
    throw new Error(i18n.t("swarm.seat.attachmentsNeedUpdate"));
  }
  const cc = roster.features?.includes("cc")
    ? defaultSwarmCc(roster.agents, seatRecipient(seat))
    : [];
  await sendSeatMail(plugin, seat, body, cc, attachments);
}

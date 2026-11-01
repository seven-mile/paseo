import { z } from "zod";
import { useFetchQuery } from "@/data/query";
import type { InstalledPlugin } from "@/plugins/types";
import type { RosterSeat } from "./roster";
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
    }),
  ),
});

const receiptSchema = z.object({ status: statusSchema, receipt: z.string() });

export function seatRecipient(seat: Pick<RosterSeat, "name" | "qualifiedName">): string {
  return seat.qualifiedName ?? seat.name;
}

function seatMailQueryKey(serverId: string, seatId: string) {
  return ["swarm", "seat-mail", serverId, seatId];
}

// The person's mail to the seat that has not reached its occupant yet. Reading the mailbox also
// makes Swarm retry delivery, so this polls only while the seat is on screen.
export function useUndeliveredSeatMail(plugin: InstalledPlugin, seat: RosterSeat, active: boolean) {
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

// Sends the person's words to the seat through its mailbox: a seat with no agent starts one, and
// a seat with a pending change applies it first. A refused delivery throws its receipt.
export async function sendSeatMail(
  plugin: InstalledPlugin,
  seat: RosterSeat,
  body: string,
): Promise<void> {
  const result = receiptSchema.parse(
    await plugin.invoke("swarm.message.send", {
      ...(seat.swarmId ? { swarmId: seat.swarmId } : {}),
      senderName: PERSON_SENDER,
      recipientName: seatRecipient(seat),
      body,
    }),
  );
  await Promise.all([
    plugin.queryClient.invalidateQueries({ queryKey: seatMailQueryKey(plugin.serverId, seat.id) }),
    plugin.queryClient.invalidateQueries({ queryKey: ["swarm", "roster", plugin.serverId] }),
  ]);
  if (result.status === "failed") throw new Error(result.receipt);
}

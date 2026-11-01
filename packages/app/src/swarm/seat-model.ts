import type { RosterSeat } from "./roster";

export interface SeatOccupant {
  number: number;
  paseoAgentId: string;
  current: boolean;
  provider?: string;
  boundAt?: string;
  retiredAt?: string;
  reason?: string;
}

// The seat's occupants, current first, then earlier ones from the most recently replaced. An agent
// the seat is still bringing in counts as current, since it is already running.
export function seatOccupants(seat: RosterSeat): SeatOccupant[] {
  const current = seatConversationAgentId(seat);
  const occupants: SeatOccupant[] = [];
  if (current) {
    occupants.push({
      number: seat.paseoAgentId ? (seat.occupant?.number ?? 1) : arrivingNumber(seat, current),
      paseoAgentId: current,
      current: true,
      provider: seat.paseoAgentId ? seat.occupant?.config?.provider : seat.agentConfig?.provider,
      boundAt: seat.paseoAgentId ? seat.occupant?.boundAt : undefined,
    });
  }
  const past = (seat.pastOccupants ?? [])
    .filter((occupant) => occupant.paseoAgentId !== current)
    .sort((a, b) => b.retiredAt.localeCompare(a.retiredAt));
  for (const occupant of past) {
    occupants.push({
      number: occupant.number,
      paseoAgentId: occupant.paseoAgentId,
      current: false,
      provider: occupant.config?.provider,
      boundAt: occupant.boundAt,
      retiredAt: occupant.retiredAt,
      reason: occupant.reason,
    });
  }
  return occupants;
}

// An earlier occupant coming back keeps its number; a new agent takes the next one.
function arrivingNumber(seat: RosterSeat, paseoAgentId: string): number {
  const past = seat.pastOccupants ?? [];
  const returning = past.find((occupant) => occupant.paseoAgentId === paseoAgentId);
  if (returning) return returning.number;
  return Math.max(seat.occupant?.number ?? 0, ...past.map((occupant) => occupant.number)) + 1;
}

// The agent whose conversation the seat shows: its occupant, or the agent it is bringing in.
export function seatConversationAgentId(seat: RosterSeat): string | null {
  return seat.paseoAgentId ?? seat.arrivingAgentId ?? null;
}

export interface SeatHandover {
  from: number;
  to: number;
  at: string;
  reason: string;
  fromProvider?: string;
  toProvider?: string;
  // The incoming occupant held the seat before, so it remembers its own earlier turns.
  returning: boolean;
}

// The handover that put the current occupant in the seat. Swarm stamps the outgoing occupant's
// retiredAt with the incoming one's boundAt, so the two match.
export function latestHandover(seat: RosterSeat): SeatHandover | null {
  const occupant = seat.occupant;
  if (!seat.paseoAgentId || !occupant?.boundAt) return null;
  const outgoing = (seat.pastOccupants ?? []).find((past) => past.retiredAt === occupant.boundAt);
  if (!outgoing) return null;
  return {
    from: outgoing.number,
    to: occupant.number,
    at: occupant.boundAt,
    reason: outgoing.reason,
    fromProvider: outgoing.config?.provider,
    toProvider: occupant.config?.provider,
    returning: occupant.number < outgoing.number,
  };
}

export interface SeatMail {
  id: string;
  words: string;
  status: "queued" | "delivered" | "consumed" | "failed";
  createdAt: string;
  lastError: string | null;
}

// The person's mail to the seat that has not reached the occupant's conversation: still queued, or
// failed. Delivered mail shows in the conversation itself. Oldest first, as a chat reads.
export function undeliveredMail(messages: readonly SeatMail[]): SeatMail[] {
  return messages
    .filter((message) => message.status === "queued" || message.status === "failed")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

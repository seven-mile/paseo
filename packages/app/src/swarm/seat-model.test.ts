import { describe, expect, it } from "vitest";
import type { SwarmSeat } from "./roster";
import {
  latestHandover,
  seatConversationAgentId,
  seatOccupants,
  undeliveredMail,
  type SeatMail,
} from "./seat-model";
import { personMailWords } from "./system-envelope";

const baseSeat: SwarmSeat = {
  id: "seat-dev",
  swarmId: "swarm-1",
  paseoAgentId: null,
  name: "dev",
  qualifiedName: "lead.dev",
  roleClass: "worker",
  reportsTo: "lead",
  workspaceId: "ws-1",
  retired: false,
};

function past(number: number, paseoAgentId: string, retiredAt: string, provider = "claude") {
  return {
    number,
    paseoAgentId,
    retiredAt,
    reason: `reason ${number}`,
    boundAt: `2026-10-0${number}T00:00:00.000Z`,
    config: { provider },
  };
}

describe("seat occupants", () => {
  it("lists the current occupant first, then earlier ones from the most recently replaced", () => {
    const seat: SwarmSeat = {
      ...baseSeat,
      paseoAgentId: "agent-3",
      occupant: { number: 3, boundAt: "2026-10-03T00:00:00.000Z", config: { provider: "codex" } },
      pastOccupants: [
        past(1, "agent-1", "2026-10-02T00:00:00.000Z"),
        past(2, "agent-2", "2026-10-03T00:00:00.000Z"),
      ],
    };
    expect(seatOccupants(seat).map((occupant) => [occupant.number, occupant.current])).toEqual([
      [3, true],
      [2, false],
      [1, false],
    ]);
    expect(seatOccupants(seat)[0]).toMatchObject({ paseoAgentId: "agent-3", provider: "codex" });
  });

  it("shows the agent a seat is bringing in as its next occupant before it binds it", () => {
    const seat: SwarmSeat = {
      ...baseSeat,
      arrivingAgentId: "agent-new",
      agentConfig: { provider: "codex" },
      pastOccupants: [past(1, "agent-1", "2026-10-02T00:00:00.000Z")],
    };
    expect(seatConversationAgentId(seat)).toBe("agent-new");
    expect(seatOccupants(seat)[0]).toMatchObject({
      number: 2,
      paseoAgentId: "agent-new",
      current: true,
      provider: "codex",
    });
  });

  it("keeps a returning occupant's number and does not list it twice", () => {
    const seat: SwarmSeat = {
      ...baseSeat,
      arrivingAgentId: "agent-1",
      pastOccupants: [past(1, "agent-1", "2026-10-02T00:00:00.000Z")],
    };
    expect(seatOccupants(seat).map((occupant) => occupant.number)).toEqual([1]);
  });

  it("has no conversation for a seat with no agent", () => {
    expect(seatConversationAgentId(baseSeat)).toBeNull();
    expect(seatOccupants(baseSeat)).toEqual([]);
  });
});

describe("seat handover", () => {
  it("matches the outgoing occupant by the incoming one's bind time", () => {
    const seat: SwarmSeat = {
      ...baseSeat,
      paseoAgentId: "agent-2",
      occupant: { number: 2, boundAt: "2026-10-03T00:00:00.000Z", config: { provider: "codex" } },
      pastOccupants: [past(1, "agent-1", "2026-10-03T00:00:00.000Z")],
    };
    expect(latestHandover(seat)).toEqual({
      from: 1,
      to: 2,
      at: "2026-10-03T00:00:00.000Z",
      reason: "reason 1",
      fromProvider: "claude",
      toProvider: "codex",
      returning: false,
    });
  });

  it("marks an earlier occupant coming back as returning", () => {
    const seat: SwarmSeat = {
      ...baseSeat,
      paseoAgentId: "agent-1",
      occupant: { number: 1, boundAt: "2026-10-04T00:00:00.000Z" },
      pastOccupants: [past(2, "agent-2", "2026-10-04T00:00:00.000Z")],
    };
    expect(latestHandover(seat)).toMatchObject({ from: 2, to: 1, returning: true });
  });

  it("reports no handover for a first occupant", () => {
    const seat: SwarmSeat = {
      ...baseSeat,
      paseoAgentId: "agent-1",
      occupant: { number: 1, boundAt: "2026-10-01T00:00:00.000Z" },
    };
    expect(latestHandover(seat)).toBeNull();
  });
});

describe("seat mail", () => {
  function mail(id: string, status: SeatMail["status"], createdAt: string): SeatMail {
    return { id, words: id, status, createdAt, lastError: null };
  }

  it("keeps queued and failed mail, oldest first", () => {
    expect(
      undeliveredMail([
        mail("c", "queued", "2026-10-03T00:00:00.000Z"),
        mail("a", "delivered", "2026-10-01T00:00:00.000Z"),
        mail("b", "failed", "2026-10-02T00:00:00.000Z"),
        mail("d", "consumed", "2026-10-04T00:00:00.000Z"),
      ]).map((message) => message.id),
    ).toEqual(["b", "c"]);
  });

  it("reads the person's words out of their team message", () => {
    expect(
      personMailWords(
        '<paseo-swarm-team-message id="m1" from="human" to="lead.dev">\nFix the flaky test\nplease\n</paseo-swarm-team-message>',
      ),
    ).toBe("Fix the flaky test\nplease");
  });

  it("leaves team messages from other seats as cards", () => {
    expect(
      personMailWords(
        '<paseo-swarm-team-message id="m1" from="lead" to="lead.dev">\nTask is yours\n</paseo-swarm-team-message>',
      ),
    ).toBeNull();
    expect(personMailWords("Fix the flaky test")).toBeNull();
  });
});

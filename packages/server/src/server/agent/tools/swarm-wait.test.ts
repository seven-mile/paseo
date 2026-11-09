import { describe, expect, test, vi } from "vitest";
import { waitInSwarm } from "./swarm-wait.js";

interface Poll {
  expired: boolean;
  mail: string[];
  messageIds: string[];
  events: unknown[];
}
const empty: Poll = { expired: false, mail: [], messageIds: [], events: [] };

function plugin(polls: Array<Poll | (() => Promise<Poll>)>) {
  let started = 0;
  const invoke = vi.fn(async (method: string, _input: unknown) => {
    if (method === "swarm.wait.start") return { waitId: `wait-${++started}` };
    if (method === "swarm.wait.cancel") return { canceled: true };
    const next = polls.shift() ?? empty;
    return typeof next === "function" ? next() : next;
  });
  return invoke;
}

describe("waitInSwarm", () => {
  test("polls through empty windows until an event, then cancels the wait", async () => {
    const event = { seat: "lead.scout", kind: "turn-ended", outcome: "completed" };
    const invoke = plugin([empty, empty, { ...empty, events: [event] }]);
    const outcome = await waitInSwarm({
      invoke,
      paseoAgentId: "lead-agent",
      seats: ["lead.scout"],
      timeoutMs: 60_000,
    });
    expect(outcome).toEqual({ reason: "seats", mail: [], events: [event] });
    expect(invoke.mock.calls.filter(([method]) => method === "swarm.wait.poll")).toHaveLength(3);
    expect(invoke).toHaveBeenLastCalledWith("swarm.wait.cancel", { waitId: "wait-1", release: [] });
  });

  test("times out with nothing once the deadline passes", async () => {
    const invoke = plugin([]);
    const outcome = await waitInSwarm({
      invoke,
      paseoAgentId: "lead-agent",
      seats: [],
      timeoutMs: 30,
      pollWindowMs: 10,
    });
    expect(outcome.reason).toBe("timeout");
  });

  test("starts a new wait when the plugin forgot the old one", async () => {
    const invoke = plugin([
      { ...empty, expired: true },
      { ...empty, mail: ["hi"], messageIds: ["m"] },
    ]);
    const outcome = await waitInSwarm({
      invoke,
      paseoAgentId: "lead-agent",
      seats: [],
      timeoutMs: 60_000,
    });
    expect(outcome).toEqual({ reason: "mail", mail: ["hi"], events: [] });
    expect(invoke).toHaveBeenLastCalledWith("swarm.wait.cancel", { waitId: "wait-2", release: [] });
  });

  test("releases mail a poll claimed after the tool call was canceled", async () => {
    const controller = new AbortController();
    const invoke = plugin([
      async () => {
        controller.abort();
        return { ...empty, mail: ["late"], messageIds: ["m1", "m2"] };
      },
    ]);
    const outcome = await waitInSwarm({
      invoke,
      paseoAgentId: "lead-agent",
      seats: [],
      timeoutMs: 60_000,
      signal: controller.signal,
    });
    expect(outcome.reason).toBe("canceled");
    // The abort cancels at once to wake the poll; the final cancel releases what it claimed.
    expect(invoke).toHaveBeenCalledWith("swarm.wait.cancel", { waitId: "wait-1", release: [] });
    expect(invoke).toHaveBeenLastCalledWith("swarm.wait.cancel", {
      waitId: "wait-1",
      release: ["m1", "m2"],
    });
  });
});

// The daemon side of swarm_wait. Plugin requests time out after 30 seconds and a canceled tool call
// cannot reach a plugin handler that is blocked, so the wait is a long-poll: register it, poll it in
// short windows until mail or an event arrives or the deadline passes, then cancel it. Mail is
// marked delivered only in the poll answer that carries it; an answer that arrives after the tool
// call was canceled is released back to the mailbox. See plugins/paseo-swarm/server/waits.ts.

export const SWARM_WAIT_DEFAULT_SECONDS = 600;
export const SWARM_WAIT_MAX_SECONDS = 1800;
// Below the plugin request timeout, with room for the answer to travel.
export const SWARM_WAIT_POLL_WINDOW_MS = 20_000;

const MAX_RESTARTS = 3;

export type SwarmWaitEvent = { seat: string; kind: string } & Record<string, unknown>;

interface WaitPoll {
  expired: boolean;
  mail: string[];
  messageIds: string[];
  events: SwarmWaitEvent[];
}

export interface SwarmWaitOutcome {
  // What ended the wait. Mail wins over events when both arrived.
  reason: "mail" | "seats" | "timeout" | "canceled";
  mail: string[];
  events: SwarmWaitEvent[];
}

export interface SwarmWaitInput {
  invoke: (method: string, input: unknown) => Promise<unknown>;
  paseoAgentId: string;
  seats: string[];
  timeoutMs: number;
  signal?: AbortSignal;
  pollWindowMs?: number;
}

export async function waitInSwarm(input: SwarmWaitInput): Promise<SwarmWaitOutcome> {
  const window = input.pollWindowMs ?? SWARM_WAIT_POLL_WINDOW_MS;
  const deadline = Date.now() + input.timeoutMs;
  const start = async () =>
    (
      (await input.invoke("swarm.wait.start", {
        paseoAgentId: input.paseoAgentId,
        seats: input.seats,
      })) as { waitId: string }
    ).waitId;
  let waitId = await start();
  let release: string[] = [];
  let restarts = 0;
  // A cancel wakes the poll in flight, so an interrupt does not hold the agent's mail for a window.
  const onAbort = () => {
    void input.invoke("swarm.wait.cancel", { waitId, release: [] }).catch(() => undefined);
  };
  input.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      if (input.signal?.aborted) return { reason: "canceled", mail: [], events: [] };
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { reason: "timeout", mail: [], events: [] };
      const poll = (await input.invoke("swarm.wait.poll", {
        waitId,
        windowMs: Math.min(window, remaining),
      })) as WaitPoll;
      if (input.signal?.aborted) {
        // Nobody reads this answer, so its mail goes back to the queue.
        release = poll.messageIds;
        return { reason: "canceled", mail: [], events: [] };
      }
      if (poll.expired) {
        // The plugin restarted, or a newer wait of this agent replaced this one. Two waits of one
        // agent would keep replacing each other, so this one gives up after a few tries.
        restarts += 1;
        if (restarts > MAX_RESTARTS) return { reason: "canceled", mail: [], events: [] };
        waitId = await start();
        continue;
      }
      if (poll.mail.length > 0) return { reason: "mail", mail: poll.mail, events: poll.events };
      if (poll.events.length > 0) return { reason: "seats", mail: [], events: poll.events };
    }
  } finally {
    input.signal?.removeEventListener("abort", onAbort);
    // Mail the wait held goes out the ordinary way once it ends.
    await input.invoke("swarm.wait.cancel", { waitId, release }).catch(() => undefined);
  }
}

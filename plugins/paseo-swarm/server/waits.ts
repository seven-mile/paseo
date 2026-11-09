import type { PluginHookContext } from "@getpaseo/plugin/server";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { agentQualifiedName, currentOccupant, type AgentRecord } from "../shared/models";
import { claimForWait, flushMailbox, noteWaiting, releaseClaim } from "./mailbox";
import { TURN_REPORT_EXCERPT_LIMIT, type TurnOutcome } from "./prompts";
import { planSeat } from "./seat-policy";
import { store } from "./state";
import { findAgent } from "./swarms";
import type { TurnSummary } from "./turns";

// swarm_wait is a long-poll: the daemon's tool registers a wait, then polls it in windows shorter
// than a plugin request's timeout until something happens or the tool's deadline passes. The
// plugin cannot see a canceled tool call, so a wait nobody polls for this long expires, and its
// agent's mail goes back to the ordinary steer path.
export const WAIT_EXPIRY_MS = 15_000;
export const MAX_POLL_WINDOW_MS = 20_000;

type WaitContext = Pick<PluginHookContext, "paseo">;

export type WaitEvent =
  | {
      seat: string;
      kind: "turn-ended";
      outcome: TurnOutcome;
      detail: string | null;
      files: number;
      // The start of the agent's final text; the rest is in swarm_transcript_list.
      report: string | null;
      truncated: boolean;
      occupant: number;
    }
  | { seat: string; kind: "permission"; request: string }
  | { seat: string; kind: "retired" }
  | { seat: string; kind: "replaced"; occupant: number }
  // The waiting agent's own seat has a change that applies only between turns. Its mail stays
  // queued until the agent ends its turn and Swarm applies the change.
  | { seat: string; kind: "seat-change"; reason: string };

interface Watched {
  name: string;
  paseoAgentId: string | null;
  retired: boolean;
}

interface Waiter {
  id: string;
  paseoAgentId: string;
  seatId: string;
  watched: Map<string, Watched>;
  events: WaitEvent[];
  // Whether the wait already told its agent about a pending change to its own seat.
  seatChangeReported: boolean;
  wake: (() => void) | null;
  expiry: ReturnType<typeof setTimeout> | null;
  context: WaitContext;
}

export interface WaitPoll {
  // The wait is gone: it expired, was replaced by a newer wait of the same agent, or the plugin
  // restarted. Nothing was claimed.
  expired: boolean;
  mail: string[];
  messageIds: string[];
  events: WaitEvent[];
}

const waiters = new Map<string, Waiter>();

store.onCommit(() => {
  for (const waiter of waiters.values()) waiter.wake?.();
});

function wakeAll(): void {
  for (const waiter of waiters.values()) waiter.wake?.();
}

function seatOf(paseoAgentId: string): AgentRecord | undefined {
  return store.read().agents.find((agent) => agent.paseoAgentId === paseoAgentId && !agent.retired);
}

function seatName(seatId: string): string | null {
  const seat = store.read().agents.find((agent) => agent.id === seatId);
  return seat ? agentQualifiedName(seat) : null;
}

function stopWaiter(waiter: Waiter): void {
  waiters.delete(waiter.id);
  if (waiter.expiry) clearTimeout(waiter.expiry);
  waiter.wake?.();
  if (![...waiters.values()].some((other) => other.paseoAgentId === waiter.paseoAgentId)) {
    noteWaiting(waiter.paseoAgentId, false);
  }
}

// After a wait ends, mail it left queued goes out the ordinary way.
function endWait(waiter: Waiter, context: WaitContext): Promise<void> {
  stopWaiter(waiter);
  return flushMailbox(context).catch((error) => {
    console.warn("[paseo-swarm] Mail held for an ended wait stays queued", error);
  });
}

function armExpiry(waiter: Waiter): void {
  if (waiter.expiry) clearTimeout(waiter.expiry);
  waiter.expiry = setTimeout(() => {
    if (waiters.get(waiter.id) === waiter) void endWait(waiter, waiter.context);
  }, WAIT_EXPIRY_MS);
  waiter.expiry.unref?.();
}

export interface StartWaitInput {
  paseoAgentId: string;
  // Qualified seat names in the waiting agent's swarm.
  seats: string[];
}

export async function startWait(input: StartWaitInput, context: WaitContext): Promise<string> {
  const seat = seatOf(input.paseoAgentId);
  if (!seat) throw new Error(`This agent does not occupy a Swarm seat: ${input.paseoAgentId}`);
  const watched = new Map<string, Watched>();
  for (const name of input.seats) {
    const target = findAgent(seat.swarmId, name);
    if (target.id === seat.id) throw new Error("A seat cannot wait on itself");
    watched.set(target.id, {
      name: agentQualifiedName(target),
      paseoAgentId: target.paseoAgentId,
      retired: target.retired,
    });
  }
  // One wait per agent: a newer call replaces an older one the agent abandoned.
  for (const waiter of waiters.values()) {
    if (waiter.paseoAgentId === input.paseoAgentId) stopWaiter(waiter);
  }
  const waiter: Waiter = {
    id: `wait-${randomUUID()}`,
    paseoAgentId: input.paseoAgentId,
    seatId: seat.id,
    watched,
    events: [],
    seatChangeReported: false,
    wake: null,
    expiry: null,
    context,
  };
  waiters.set(waiter.id, waiter);
  noteWaiting(input.paseoAgentId, true);
  armExpiry(waiter);
  return waiter.id;
}

// Retirements and replacements of watched seats, read from the store against what the wait last
// saw.
function seatChanges(waiter: Waiter): WaitEvent[] {
  const events: WaitEvent[] = [];
  const agents = store.read().agents;
  for (const [id, seen] of waiter.watched) {
    const current = agents.find((agent) => agent.id === id);
    if (!current) continue;
    if (current.retired && !seen.retired) {
      events.push({ seat: seen.name, kind: "retired" });
    } else if (
      seen.paseoAgentId !== null &&
      current.paseoAgentId !== null &&
      current.paseoAgentId !== seen.paseoAgentId
    ) {
      events.push({ seat: seen.name, kind: "replaced", occupant: currentOccupant(current).number });
    }
    waiter.watched.set(id, {
      name: seen.name,
      paseoAgentId: current.paseoAgentId,
      retired: current.retired,
    });
  }
  return events;
}

async function collect(waiter: Waiter): Promise<Omit<WaitPoll, "expired">> {
  const events = [...waiter.events.splice(0), ...seatChanges(waiter)];
  const own = store.read().agents.find((agent) => agent.id === waiter.seatId);
  const plan = own ? planSeat(own) : null;
  if (plan && plan.kind !== "keep") {
    // Mail waits for the change, as it does for any agent mid-turn.
    if (!waiter.seatChangeReported) {
      waiter.seatChangeReported = true;
      events.push({
        seat: agentQualifiedName(own!),
        kind: "seat-change",
        reason: plan.reason,
      });
    }
    return { mail: [], messageIds: [], events };
  }
  const claimed = await claimForWait(waiter.seatId, waiter.paseoAgentId);
  return { mail: claimed.prompts, messageIds: claimed.messageIds, events };
}

export interface PollWaitInput {
  waitId: string;
  windowMs: number;
}

// Returns as soon as the wait has mail or an event, or empty when the window passes first.
export async function pollWait(input: PollWaitInput, context: WaitContext): Promise<WaitPoll> {
  const waiter = waiters.get(input.waitId);
  if (!waiter) return { expired: true, mail: [], messageIds: [], events: [] };
  waiter.context = context;
  if (waiter.expiry) clearTimeout(waiter.expiry);
  waiter.expiry = null;
  const deadline = Date.now() + Math.min(Math.max(input.windowMs, 0), MAX_POLL_WINDOW_MS);
  try {
    for (;;) {
      if (waiters.get(waiter.id) !== waiter) {
        return { expired: true, mail: [], messageIds: [], events: [] };
      }
      const result = await collect(waiter);
      if (result.mail.length > 0 || result.events.length > 0) return { expired: false, ...result };
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { expired: false, ...result };
      // A commit, a hook, or the window's end wakes the poll, whichever comes first.
      const window = new AbortController();
      await Promise.race([
        sleep(remaining, undefined, { signal: window.signal }).catch(() => undefined),
        new Promise<void>((resolve) => {
          waiter.wake = resolve;
        }),
      ]);
      window.abort();
      waiter.wake = null;
    }
  } finally {
    waiter.wake = null;
    if (waiters.get(waiter.id) === waiter) armExpiry(waiter);
  }
}

export interface CancelWaitInput {
  waitId: string;
  // Mail a poll claimed whose result never reached the agent.
  release: string[];
}

export async function cancelWait(input: CancelWaitInput, context: WaitContext): Promise<void> {
  const waiter = waiters.get(input.waitId);
  if (waiter) stopWaiter(waiter);
  if (input.release.length > 0) {
    const paseoAgentId =
      waiter?.paseoAgentId ??
      store.read().messages.find((message) => input.release.includes(message.id))
        ?.deliveredToPaseoAgentId;
    if (paseoAgentId) await releaseClaim(paseoAgentId, input.release);
  }
  await flushMailbox(context).catch((error) => {
    console.warn("[paseo-swarm] Mail held for a canceled wait stays queued", error);
  });
}

function watchersOf(paseoAgentId: string): { seat: AgentRecord; waiters: Waiter[] } | null {
  const seat = store.read().agents.find((agent) => agent.paseoAgentId === paseoAgentId);
  if (!seat) return null;
  const watching = [...waiters.values()].filter((waiter) => waiter.watched.has(seat.id));
  return watching.length > 0 ? { seat, waiters: watching } : null;
}

export function noteWatchedTurnEnded(paseoAgentId: string, turn: TurnSummary): void {
  const found = watchersOf(paseoAgentId);
  if (!found) return;
  const characters = turn.report ? Array.from(turn.report) : [];
  const event: WaitEvent = {
    seat: agentQualifiedName(found.seat),
    kind: "turn-ended",
    outcome: turn.outcome,
    detail: turn.outcome === "completed" ? null : turn.detail,
    files: turn.filesChanged,
    report: characters.length > 0 ? characters.slice(0, TURN_REPORT_EXCERPT_LIMIT).join("") : null,
    truncated: characters.length > TURN_REPORT_EXCERPT_LIMIT,
    occupant: currentOccupant(found.seat).number,
  };
  for (const waiter of found.waiters) {
    // A failed turn also mails the seat's manager, and that mail ends the manager's wait.
    if (turn.outcome === "failed" && seatName(waiter.seatId) === found.seat.reportsTo) continue;
    waiter.events.push(event);
  }
  wakeAll();
}

export function noteWatchedPermission(
  paseoAgentId: string,
  request: { name: string; title?: string },
): void {
  const found = watchersOf(paseoAgentId);
  if (!found) return;
  const event: WaitEvent = {
    seat: agentQualifiedName(found.seat),
    kind: "permission",
    request: request.title ?? request.name,
  };
  for (const waiter of found.waiters) waiter.events.push(event);
  wakeAll();
}

// A turn that ended is not waiting, whatever happened to its tool call; the caller flushes the
// mail its wait held.
export function stopWaitsOf(paseoAgentId: string): void {
  for (const waiter of waiters.values()) {
    if (waiter.paseoAgentId === paseoAgentId) stopWaiter(waiter);
  }
}

// For tests: the module outlives a single test's store.
export function forgetWaits(): void {
  for (const waiter of waiters.values()) stopWaiter(waiter);
}

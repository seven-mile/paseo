import { randomUUID } from "node:crypto";
import type { PluginHookContext } from "@getpaseo/plugin/server";
import type {
  AgentConfig,
  AgentRecord,
  MailboxMessage,
  Occupant,
  PastOccupant,
} from "../shared/models";
import {
  agentQualifiedName,
  currentOccupant,
  mailboxMessageStatus,
  providerFamily,
} from "../shared/models";
import {
  initialPrompt,
  promptRevision,
  refreshedPrompt,
  returnBrief,
  standingPrompt,
  takeoverBrief,
} from "./prompts";
import { readPwa } from "./pwa";
import {
  adjustedConfig,
  bootConfig,
  pendingPlan,
  planSeat,
  settingsLostOnProviderChange,
  type PendingPlan,
  type SeatPlan,
} from "./seat-policy";
import { requirePwaSource } from "./source";
import { store } from "./state";

type SeatContext = Pick<PluginHookContext, "paseo">;

const PARENT_LABEL = "paseo.parent-agent-id";
// Marks every agent Swarm starts for a seat, with the seat's id. The daemon reads it to keep native
// agent tools from a seat's agent when it cannot reach Swarm to look the seat up.
const SEAT_LABEL = "paseo-swarm.seat";

const now = () => new Date().toISOString();

export function assertRoleClass(
  pwaRoleClass: AgentRecord["roleClass"],
  agentRoleClass: AgentRecord["roleClass"],
  role: string,
): void {
  if (pwaRoleClass !== agentRoleClass) {
    throw new Error(`Role ${role} belongs to role class ${pwaRoleClass}, not ${agentRoleClass}`);
  }
}

// Creation, refresh and replacement all assemble from the current PWA, so each gives an
// agent what a new agent with the same identity would get.
export function assemblePrompt(
  agent: Pick<AgentRecord, "name" | "qualifiedName" | "roleClass" | "role" | "reportsTo">,
  projectId?: string,
) {
  const pwa = readPwa(requirePwaSource(projectId), agent.role);
  assertRoleClass(pwa.roleClass, agent.roleClass, agent.role);
  return {
    pwa,
    received: {
      revision: promptRevision({ pwa, agent }),
      pwaRevision: pwa.revision,
      receivedAt: now(),
    },
  };
}

// Paseo agents a seat is bringing in, by id, until the seat binds them: a new agent while it is
// created, or an earlier occupant while its session resumes. The daemon picks an agent's tools as
// its session opens, so the agent must already count as the seat's then.
const arriving = new Map<string, string>();

async function bringIn<T>(paseoAgentId: string, seatId: string, run: () => Promise<T>): Promise<T> {
  arriving.set(paseoAgentId, seatId);
  try {
    return await run();
  } finally {
    arriving.delete(paseoAgentId);
  }
}

// The active seat a Paseo agent occupies or is arriving in.
export function seatOfAgent(paseoAgentId: string): AgentRecord | undefined {
  const seats = store.read().agents.filter((seat) => !seat.retired);
  const arrivingIn = arriving.get(paseoAgentId);
  return (
    seats.find((seat) => seat.paseoAgentId === paseoAgentId) ??
    (arrivingIn ? seats.find((seat) => seat.id === arrivingIn) : undefined)
  );
}

// A seat named by its roster id or its qualified name.
export function findSeat(reference: string, includeRetired = false): AgentRecord {
  const agents = store.read().agents.filter((agent) => includeRetired || !agent.retired);
  const seat =
    agents.find((agent) => agent.id === reference) ??
    agents.find((agent) => agentQualifiedName(agent) === reference);
  if (!seat) throw new Error(`Unknown Swarm seat: ${reference}`);
  return seat;
}

function definedConfig(config: AgentConfig): AgentConfig {
  return Object.fromEntries(
    Object.entries(config).filter(([, value]) => value !== undefined),
  ) as AgentConfig;
}

// What the live Paseo agent runs, for records stamped before seats existed.
export async function observedConfig(
  paseoAgentId: string,
  context: SeatContext,
): Promise<AgentConfig> {
  const snapshot = (await context.paseo.agents.ref(paseoAgentId).refresh())?.agent;
  if (!snapshot) return {};
  return definedConfig({
    provider: snapshot.model ? `${snapshot.provider}/${snapshot.model}` : snapshot.provider,
    modeId: snapshot.currentModeId ?? undefined,
    thinkingOptionId: snapshot.thinkingOptionId ?? undefined,
  });
}

// True while the seat's Paseo agent runs a turn. A stale occupant finishes that turn first.
// An agent Paseo no longer has runs no turn; a failed lookup throws, so the caller holds the seat
// rather than replacing an agent that may be mid-turn.
export async function occupantRunning(seat: AgentRecord, context: SeatContext): Promise<boolean> {
  if (seat.paseoAgentId === null) return false;
  const snapshot = (await context.paseo.agents.ref(seat.paseoAgentId).refresh())?.agent;
  return snapshot?.status === "running";
}

// Rows the old occupant was handed but never finished a turn on go back to the queue.
function requeueUnconsumed(paseoAgentId: string): MailboxMessage[] {
  return store
    .read()
    .messages.filter(
      (message) =>
        message.deliveredToPaseoAgentId === paseoAgentId &&
        mailboxMessageStatus(message) === "delivered",
    )
    .map((message) =>
      Object.assign({}, message, { deliveredAt: null, deliveredToPaseoAgentId: null }),
    );
}

async function retireOldAgent(paseoAgentId: string, context: SeatContext): Promise<void> {
  try {
    // Archiving cascades to Paseo children, which would take a supervisor's workers with it.
    const children: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await context.paseo.agents.list({
        filter: { includeArchived: false },
        page: { limit: 200, ...(cursor ? { cursor } : {}) },
      });
      for (const entry of page.entries) {
        if (entry.agent.labels?.[PARENT_LABEL] === paseoAgentId) children.push(entry.agent.id);
      }
      cursor = page.pageInfo.nextCursor ?? undefined;
    } while (cursor);
    for (const child of children) await context.paseo.agents.ref(child).detach();
    await context.paseo.agents.ref(paseoAgentId).archive();
  } catch (error) {
    // The seat no longer points at it, so nothing will wake it; leave it for manual cleanup.
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`[paseo-swarm] Could not archive replaced agent ${paseoAgentId}: ${detail}`);
  }
}

// The Paseo agent in a seat that has one; reserved seats have none until their first mail.
export function occupantId(seat: AgentRecord): string {
  if (seat.paseoAgentId === null) {
    throw new Error(`Seat ${agentQualifiedName(seat)} has no agent yet`);
  }
  return seat.paseoAgentId;
}

function nextOccupantNumber(seat: AgentRecord): number {
  const numbers = (seat.pastOccupants ?? []).map((past) => past.number);
  return Math.max(currentOccupant(seat).number, ...numbers) + 1;
}

// Moves the seat to another Paseo agent: the current one becomes a past occupant, rows it never
// finished go back to the queue, and it is archived once nothing points at it.
async function rebind(
  stale: AgentRecord,
  next: { paseoAgentId: string; occupant: Occupant; prompt: AgentRecord["prompt"] | null },
  reason: string,
  context: SeatContext,
): Promise<AgentRecord> {
  let result!: AgentRecord;
  await store.commit((state) => {
    const seat = state.agents.find((agent) => agent.id === stale.id);
    if (!seat) throw new Error(`Swarm seat disappeared during replacement: ${stale.id}`);
    const retired: PastOccupant = {
      ...currentOccupant(seat),
      paseoAgentId: occupantId(seat),
      retiredAt: next.occupant.boundAt,
      reason,
      ...(seat.prompt ? { prompt: seat.prompt } : {}),
    };
    result = {
      ...seat,
      paseoAgentId: next.paseoAgentId,
      occupant: next.occupant,
      pastOccupants: [
        ...(seat.pastOccupants ?? []).filter((past) => past.paseoAgentId !== next.paseoAgentId),
        retired,
      ],
      prompt: next.prompt ?? undefined,
      updatedAt: next.occupant.boundAt,
    };
    return [
      { op: "put", collection: "agents", record: result },
      ...requeueUnconsumed(occupantId(seat)).map((record) => ({
        op: "put" as const,
        collection: "messages" as const,
        record,
      })),
    ];
  });
  await retireOldAgent(occupantId(stale), context);
  return result;
}

// Boots a fresh Paseo agent for the seat and rebinds the seat to it. The new agent runs in the
// seat's workspace with the role prompt from the current PWA; the mail that woke the seat is
// delivered to it afterwards.
async function replaceOccupant(
  stale: AgentRecord,
  reason: string,
  context: SeatContext,
): Promise<AgentRecord> {
  const config = bootConfig(stale.agentConfig ?? {}, currentOccupant(stale).config);
  if (!config.provider) {
    throw new Error(`Seat ${agentQualifiedName(stale)} has no provider to start a new agent with`);
  }
  const assembled = assemblePrompt(stale, stale.projectId);
  const number = nextOccupantNumber(stale);
  const systemPrompt = initialPrompt({
    pwa: assembled.pwa,
    agent: stale,
    brief: takeoverBrief({
      seat: agentQualifiedName(stale),
      occupant: number,
      previous: currentOccupant(stale).number,
      reason,
      manager: stale.reportsTo,
    }),
  });
  const paseoAgentId = randomUUID();
  const create = {
    agentId: paseoAgentId,
    config: { ...config, provider: config.provider!, systemPrompt },
    title: stale.name,
    labels: { [SEAT_LABEL]: stale.id },
  };
  return bringIn(paseoAgentId, stale.id, async () => {
    if (stale.workspaceId) {
      await context.paseo.workspaces.ref(stale.workspaceId).agents.create(create);
    } else {
      const cwd = (await context.paseo.agents.ref(occupantId(stale)).refresh())?.agent.cwd;
      if (!cwd) throw new Error(`Seat ${agentQualifiedName(stale)} has no workspace to start in`);
      await context.paseo.agents.create({ ...create, cwd });
    }
    const occupant = { number, config, generation: stale.generation ?? 0, boundAt: now() };
    return rebind(stale, { paseoAgentId, occupant, prompt: assembled.received }, reason, context);
  });
}

// Starts the first agent of a reserved seat, in the seat's workspace with the role prompt from the
// current PWA. The mail that woke the seat is its first instruction.
async function startOccupant(seat: AgentRecord, context: SeatContext): Promise<void> {
  const config = bootConfig(seat.agentConfig ?? {}, {});
  if (!config.provider) {
    throw new Error(`Seat ${agentQualifiedName(seat)} has no provider to start an agent with`);
  }
  if (!seat.workspaceId) throw new Error(`Seat ${agentQualifiedName(seat)} has no workspace`);
  const { workspaceId } = seat;
  const assembled = assemblePrompt(seat, seat.projectId);
  const paseoAgentId = randomUUID();
  await bringIn(paseoAgentId, seat.id, async () => {
    await context.paseo.workspaces.ref(workspaceId).agents.create({
      agentId: paseoAgentId,
      config: {
        ...config,
        provider: config.provider!,
        systemPrompt: standingPrompt({ pwa: assembled.pwa, agent: seat }),
      },
      title: seat.name,
      labels: { [SEAT_LABEL]: seat.id },
    });
    const boundAt = now();
    await store.commit((state) => {
      const current = state.agents.find((agent) => agent.id === seat.id);
      if (!current) throw new Error(`Swarm seat disappeared while starting: ${seat.id}`);
      return [
        {
          op: "put",
          collection: "agents",
          record: {
            ...current,
            paseoAgentId,
            occupant: { number: 1, config, generation: current.generation ?? 0, boundAt },
            prompt: assembled.received,
            updatedAt: boundAt,
          },
        },
      ];
    });
  });
}

// Brings back an earlier occupant that runs the seat's spec as it stands, so its session resumes
// with its context. The return brief is the probe: if Paseo cannot resume that session the send
// fails, and the caller starts a new agent instead. A session that resumes but fails later, during
// the return turn, is not caught here; a reset gives the seat a new agent.
async function reviveOccupant(
  stale: AgentRecord,
  past: PastOccupant,
  reason: string,
  context: SeatContext,
): Promise<AgentRecord> {
  const { paseoAgentId, retiredAt: _retired, reason: _reason, prompt, ...stamp } = past;
  return bringIn(paseoAgentId, stale.id, async () => {
    const boundAt = now();
    await context.paseo.agents.ref(paseoAgentId).send(
      returnBrief({
        seat: agentQualifiedName(stale),
        occupant: past.number,
        covering: currentOccupant(stale).number,
        reason,
      }),
      { messageId: `seat-return-${stale.id}-${boundAt}` },
    );
    // An agent retired before its prompt was recorded counts as stale and gets the current one.
    return rebind(
      stale,
      { paseoAgentId, occupant: { ...stamp, boundAt }, prompt: prompt ?? null },
      reason,
      context,
    );
  });
}

async function adjustOccupant(
  seat: AgentRecord,
  plan: Extract<SeatPlan, { kind: "adjust" }>,
  context: SeatContext,
): Promise<void> {
  await context.paseo.agents.ref(occupantId(seat)).applyConfig(plan.apply);
  await store.commit((state) => {
    const current = state.agents.find((agent) => agent.id === seat.id);
    if (!current || current.paseoAgentId !== seat.paseoAgentId) return [];
    const occupant = currentOccupant(current);
    const config = adjustedConfig(definedConfig(current.agentConfig ?? {}), occupant.config);
    return [
      {
        op: "put",
        collection: "agents",
        record: { ...current, occupant: { ...occupant, config }, updatedAt: now() },
      },
    ];
  });
}

// An agent whose standing prompt predates the current PWA or plugin gets the current one ahead of
// its next mail, so an upgrade or a PWA edit reaches running agents without a reset. Best effort:
// a PWA that cannot be read, or a send that fails, leaves the mail to go out as it is, and the next
// flush tries again.
export async function refreshStalePrompt(seat: AgentRecord, context: SeatContext): Promise<void> {
  if (seat.paseoAgentId === null) return;
  try {
    const assembled = assemblePrompt(seat, seat.projectId);
    if (seat.prompt?.revision === assembled.received.revision) return;
    await context.paseo.agents
      .ref(seat.paseoAgentId)
      .send(refreshedPrompt({ pwa: assembled.pwa, agent: seat, changed: true }), {
        messageId: `prompt-refresh-${seat.paseoAgentId}-${assembled.received.revision}`,
        activeTurnBehavior: "steer",
      });
    await store.commit((state) => {
      const current = state.agents.find((agent) => agent.id === seat.id);
      if (!current || current.paseoAgentId !== seat.paseoAgentId) return [];
      return [
        {
          op: "put",
          collection: "agents",
          record: { ...current, prompt: assembled.received, updatedAt: now() },
        },
      ];
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(
      `[paseo-swarm] Could not refresh the prompt of seat ${agentQualifiedName(seat)}: ${detail}`,
    );
  }
}

// Brings the seat's agent in line with the seat, as planSeat decides. The caller makes sure the
// current agent is not mid-turn.
export async function reconcileSeat(seat: AgentRecord, context: SeatContext): Promise<void> {
  const plan = planSeat(seat);
  switch (plan.kind) {
    case "keep":
      return;
    case "start":
      await startOccupant(seat, context);
      return;
    case "adjust":
      await adjustOccupant(seat, plan, context);
      return;
    case "revive":
      try {
        await reviveOccupant(seat, plan.occupant, plan.reason, context);
        return;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(
          `[paseo-swarm] Could not bring back occupant ${plan.occupant.number} of seat ${agentQualifiedName(seat)}: ${detail}`,
        );
      }
      await replaceOccupant(seat, plan.reason, context);
      return;
    case "replace":
      await replaceOccupant(seat, plan.reason, context);
      return;
  }
}

export type SeatView = AgentRecord & { pending: PendingPlan };

export function seatView(seat: AgentRecord): SeatView {
  return { ...seat, pending: pendingPlan(seat) };
}

export function listSeats(input: {
  projectId?: string;
  includeRetired: boolean;
  paseoAgentId?: string;
}): SeatView[] {
  if (input.paseoAgentId) {
    const seat = seatOfAgent(input.paseoAgentId);
    return seat ? [seatView(seat)] : [];
  }
  return store
    .read()
    .agents.filter(
      (seat) =>
        (input.includeRetired || !seat.retired) &&
        (!input.projectId || seat.projectId === input.projectId),
    )
    .map(seatView);
}

function resolveSeats(references: string[]): AgentRecord[] {
  const seats = new Map<string, AgentRecord>();
  for (const reference of references) {
    const seat = findSeat(reference);
    seats.set(seat.id, seat);
  }
  return [...seats.values()];
}

// Seats made before seats existed carry no stamp and no spec. What the live agent runs stands in
// for both, once, so a seat edit compares against what actually runs and a new agent keeps it.
async function withOccupantStamp(seat: AgentRecord, context: SeatContext): Promise<AgentRecord> {
  if (seat.occupant || seat.paseoAgentId === null) return seat;
  let config: AgentConfig = {};
  try {
    config = await observedConfig(seat.paseoAgentId, context);
  } catch {
    // Left unknown: any wanted provider then reads as a change.
  }
  return {
    ...seat,
    agentConfig: seat.agentConfig ?? config,
    occupant: { number: 1, config, generation: seat.generation ?? 0, boundAt: seat.createdAt },
  };
}

// Applies edit to each seat and commits the results unless dryRun. Edits replace whole records,
// so an edit applied to a seat that changed meanwhile is applied to the current record.
async function editSeats(
  references: string[],
  dryRun: boolean,
  edit: (seat: AgentRecord) => AgentRecord,
  context: SeatContext,
  validate: (seats: AgentRecord[], before: ReadonlyMap<string, AgentRecord>) => void = () => {},
): Promise<SeatView[]> {
  const stamped = new Map<string, AgentRecord>();
  for (const seat of resolveSeats(references)) {
    stamped.set(seat.id, await withOccupantStamp(seat, context));
  }
  const preview = [...stamped.values()].map(edit);
  validate(preview, stamped);
  if (dryRun) return preview.map(seatView);
  const timestamp = now();
  const results: AgentRecord[] = [];
  await store.commit((state) => {
    results.length = 0;
    for (const before of stamped.values()) {
      const current = state.agents.find((agent) => agent.id === before.id);
      if (!current) throw new Error(`Swarm seat disappeared: ${before.id}`);
      const edited = edit({
        ...current,
        agentConfig: current.agentConfig ?? before.agentConfig,
        occupant: current.occupant ?? before.occupant,
      });
      results.push({ ...edited, updatedAt: timestamp });
    }
    return results.map((record) => ({ op: "put" as const, collection: "agents" as const, record }));
  });
  return results.map(seatView);
}

export type AgentConfigPatch = {
  [Key in keyof AgentConfig]-?: AgentConfig[Key] | null | undefined;
};

// A new agent on another provider has nothing to take its model or mode from. Paseo creates agents
// from "provider/model", and mode names do not transfer: Claude's "auto" approves through a classifier, while Codex's "auto" asks
// and its classifier mode is "auto-review". A guessed mode could stall an agent or let it act
// without asking. A seat with no agent yet starts from its spec alone, so it always needs
// provider/model, and needs a mode only when an edit moves it to another provider.
function assertBootable(seats: AgentRecord[], before: ReadonlyMap<string, AgentRecord>): void {
  const incomplete = seats.filter((seat) => {
    const wanted = seat.agentConfig?.provider;
    const reserved = seat.paseoAgentId === null;
    if (reserved && !wanted?.includes("/")) return true;
    const from = reserved
      ? before.get(seat.id)?.agentConfig?.provider
      : currentOccupant(seat).config.provider;
    if (!wanted || (from && providerFamily(from) === providerFamily(wanted))) return false;
    return !wanted.includes("/") || !seat.agentConfig?.modeId;
  });
  if (incomplete.length === 0) return;
  throw new Error(
    "A seat's next agent needs provider/model, and a mode when the seat moves to another provider: " +
      incomplete
        .map((seat) => `${agentQualifiedName(seat)} (${seat.agentConfig?.provider})`)
        .join(", "),
  );
}

export function updateSeats(
  input: { seats: string[]; agentConfig: Partial<AgentConfigPatch>; dryRun: boolean },
  context: SeatContext,
): Promise<SeatView[]> {
  const patch = input.agentConfig;
  return editSeats(
    input.seats,
    input.dryRun,
    (seat) => {
      const agentConfig: Record<string, unknown> = { ...seat.agentConfig };
      if (patch.provider) {
        const from = seat.agentConfig?.provider ?? currentOccupant(seat).config.provider;
        for (const field of settingsLostOnProviderChange(from, patch.provider)) {
          delete agentConfig[field];
        }
      }
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) delete agentConfig[key];
        else if (value !== undefined) agentConfig[key] = value;
      }
      return { ...seat, agentConfig: agentConfig as AgentConfig };
    },
    context,
    assertBootable,
  );
}

// A reset asks for a fresh agent with the same config. Cancelling one that has not taken effect
// yet lines the seat's generation back up with its occupant's.
export function resetSeats(
  input: { seats: string[]; cancel: boolean; dryRun: boolean },
  context: SeatContext,
): Promise<SeatView[]> {
  return editSeats(
    input.seats,
    input.dryRun,
    (seat) => {
      const occupant = currentOccupant(seat);
      return {
        ...seat,
        generation: input.cancel ? occupant.generation : occupant.generation + 1,
      };
    },
    context,
  );
}

// Planners read every seat; anyone else reads their own seat and the seats under it.
function assertCanReadHistory(seat: AgentRecord, actorName: string): void {
  const actor = findSeat(actorName);
  if (actor.roleClass === "planner") return;
  const actorReference = agentQualifiedName(actor);
  const seatReference = agentQualifiedName(seat);
  if (seatReference === actorReference || seatReference.startsWith(`${actorReference}.`)) return;
  throw new Error(`Agent ${actorReference} cannot read the history of seat ${seatReference}`);
}

export interface SeatHistory {
  seat: string;
  occupant: number;
  paseoAgentId: string;
  entries: Array<{ type: string; text: string }>;
  nextBefore: string | null;
}

const HISTORY_TEXT_LIMIT = 4000;

function entryText(item: { type: string } & Record<string, unknown>): string {
  switch (item.type) {
    case "user_message":
    case "assistant_message":
    case "reasoning":
      return String(item.text ?? "");
    case "tool_call":
      return `${String(item.name ?? "tool")} (${String(item.status ?? "unknown")})`;
    case "error":
    case "notification":
      return String(item.message ?? "");
    default:
      return "";
  }
}

// Pages an occupant's transcript from Paseo's provider-agnostic timeline, newest first: the
// current one by default, or an earlier one by number. Earlier occupants are archived, and the
// daemon reads their history without resuming their sessions.
export async function readSeatHistory(
  input: { seat: string; actorName?: string; occupant?: number; before?: string; limit: number },
  context: SeatContext,
): Promise<SeatHistory> {
  const seat = findSeat(input.seat, true);
  if (input.actorName) assertCanReadHistory(seat, input.actorName);
  const occupants: Array<{ number: number; paseoAgentId: string }> = [
    ...(seat.pastOccupants ?? []),
    ...(seat.paseoAgentId === null
      ? []
      : [{ number: currentOccupant(seat).number, paseoAgentId: seat.paseoAgentId }]),
  ];
  const occupant =
    input.occupant === undefined
      ? occupants.at(-1)
      : occupants.find((candidate) => candidate.number === input.occupant);
  if (!occupant) {
    throw new Error(
      input.occupant === undefined
        ? `Seat ${agentQualifiedName(seat)} has no agent yet`
        : `Seat ${agentQualifiedName(seat)} has no occupant ${input.occupant}`,
    );
  }
  const cursor = input.before ? (JSON.parse(input.before) as { epoch: string; seq: number }) : null;
  const page = await context.paseo.agents.ref(occupant.paseoAgentId).timeline.refetch({
    direction: cursor ? "before" : "tail",
    ...(cursor ? { cursor } : {}),
    limit: input.limit,
  });
  const entries = page.entries
    .map((entry) => {
      const item = entry.item as { type: string } & Record<string, unknown>;
      const text = entryText(item);
      return {
        type: item.type,
        text:
          text.length > HISTORY_TEXT_LIMIT
            ? `${text.slice(0, HISTORY_TEXT_LIMIT)}… [truncated]`
            : text,
      };
    })
    .filter((entry) => entry.text.length > 0)
    .toReversed();
  return {
    seat: agentQualifiedName(seat),
    occupant: occupant.number,
    paseoAgentId: occupant.paseoAgentId,
    entries,
    nextBefore: page.hasOlder && page.startCursor ? JSON.stringify(page.startCursor) : null,
  };
}

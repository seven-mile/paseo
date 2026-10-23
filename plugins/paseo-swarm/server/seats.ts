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
import { initialPrompt, promptRevision, returnBrief, takeoverBrief } from "./prompts";
import { readPwa } from "./pwa";
import { adjustedConfig, planSeat, seatPendingChange, type SeatPlan } from "./seat-policy";
import { requirePwaSource } from "./source";
import { store } from "./state";

type SeatContext = Pick<PluginHookContext, "paseo">;

const PARENT_LABEL = "paseo.parent-agent-id";

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
  const snapshot = (await context.paseo.agents.ref(seat.paseoAgentId).refresh())?.agent;
  return snapshot?.status === "running";
}

// The config a replacement boots with: the seat's fields over what the previous occupant ran.
// Settings carry over only within one provider; on another provider the seat's own fields apply.
async function bootConfig(seat: AgentRecord, context: SeatContext): Promise<AgentConfig> {
  const previous = seat.occupant
    ? seat.occupant.config
    : await observedConfig(seat.paseoAgentId, context);
  const wanted = definedConfig(seat.agentConfig ?? {});
  const sameProvider =
    !wanted.provider ||
    (previous.provider !== undefined &&
      providerFamily(previous.provider) === providerFamily(wanted.provider));
  const config = sameProvider ? adjustedConfig(wanted, previous) : wanted;
  if (!config.provider) {
    throw new Error(`Seat ${agentQualifiedName(seat)} has no provider to start a new agent with`);
  }
  return config;
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

function nextOccupantNumber(seat: AgentRecord): number {
  const numbers = (seat.pastOccupants ?? []).map((past) => past.number);
  return Math.max(currentOccupant(seat).number, ...numbers) + 1;
}

// Moves the seat to another Paseo agent: the current one becomes a past occupant, rows it never
// finished go back to the queue, and it is archived once nothing points at it.
async function rebind(
  stale: AgentRecord,
  next: { paseoAgentId: string; occupant: Occupant; prompt?: AgentRecord["prompt"] },
  reason: string,
  context: SeatContext,
): Promise<AgentRecord> {
  let result!: AgentRecord;
  await store.commit((state) => {
    const seat = state.agents.find((agent) => agent.id === stale.id);
    if (!seat) throw new Error(`Swarm seat disappeared during replacement: ${stale.id}`);
    const retired: PastOccupant = {
      ...currentOccupant(seat),
      paseoAgentId: seat.paseoAgentId,
      retiredAt: next.occupant.boundAt,
      reason,
    };
    result = {
      ...seat,
      paseoAgentId: next.paseoAgentId,
      occupant: next.occupant,
      pastOccupants: [
        ...(seat.pastOccupants ?? []).filter((past) => past.paseoAgentId !== next.paseoAgentId),
        retired,
      ],
      ...(next.prompt ? { prompt: next.prompt } : {}),
      updatedAt: next.occupant.boundAt,
    };
    return [
      { op: "put", collection: "agents", record: result },
      ...requeueUnconsumed(seat.paseoAgentId).map((record) => ({
        op: "put" as const,
        collection: "messages" as const,
        record,
      })),
    ];
  });
  await retireOldAgent(stale.paseoAgentId, context);
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
  const config = await bootConfig(stale, context);
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
  const create = {
    config: { ...config, provider: config.provider!, systemPrompt },
    title: stale.name,
  };
  let created;
  if (stale.workspaceId) {
    created = await context.paseo.workspaces.ref(stale.workspaceId).agents.create(create);
  } else {
    const cwd = (await context.paseo.agents.ref(stale.paseoAgentId).refresh())?.agent.cwd;
    if (!cwd) throw new Error(`Seat ${agentQualifiedName(stale)} has no workspace to start in`);
    created = await context.paseo.agents.create({ ...create, cwd });
  }
  const occupant = { number, config, generation: stale.generation ?? 0, boundAt: now() };
  return rebind(
    stale,
    { paseoAgentId: created.id, occupant, prompt: assembled.received },
    reason,
    context,
  );
}

// Brings back an earlier occupant, whose session resumes with its context. The return brief is
// the probe: if Paseo cannot resume that session the send fails, and the caller starts a new
// agent instead. Changes the earlier occupant needs in place follow on the next delivery.
async function reviveOccupant(
  stale: AgentRecord,
  past: PastOccupant,
  reason: string,
  context: SeatContext,
): Promise<AgentRecord> {
  const boundAt = now();
  await context.paseo.agents.ref(past.paseoAgentId).send(
    returnBrief({
      seat: agentQualifiedName(stale),
      occupant: past.number,
      covering: currentOccupant(stale).number,
      reason,
    }),
    { messageId: `seat-return-${stale.id}-${boundAt}` },
  );
  const { paseoAgentId: _id, retiredAt: _retired, reason: _reason, ...stamp } = past;
  return rebind(
    stale,
    { paseoAgentId: past.paseoAgentId, occupant: { ...stamp, boundAt } },
    reason,
    context,
  );
}

async function adjustOccupant(
  seat: AgentRecord,
  plan: Extract<SeatPlan, { kind: "adjust" }>,
  context: SeatContext,
): Promise<void> {
  await context.paseo.agents.ref(seat.paseoAgentId).applyConfig(plan.apply);
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

// Brings the seat's agent in line with the seat, as planSeat decides. The caller makes sure the
// current agent is not mid-turn.
export async function reconcileSeat(seat: AgentRecord, context: SeatContext): Promise<void> {
  const plan = planSeat(seat);
  switch (plan.kind) {
    case "keep":
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

export type SeatView = AgentRecord & { stale: string | null };

export function seatView(seat: AgentRecord): SeatView {
  return { ...seat, stale: seatPendingChange(seat) };
}

export function listSeats(input: { projectId?: string; includeRetired: boolean }): SeatView[] {
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

// Seats made before seats existed carry no stamp of what their agent booted with. The live
// agent's config stands in, so a seat edit compares against what actually runs.
async function withOccupantStamp(seat: AgentRecord, context: SeatContext): Promise<AgentRecord> {
  if (seat.occupant) return seat;
  let config: AgentConfig = {};
  try {
    config = await observedConfig(seat.paseoAgentId, context);
  } catch {
    // Left unknown: any wanted provider then reads as a change.
  }
  return {
    ...seat,
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
  validate: (seats: AgentRecord[]) => void = () => {},
): Promise<SeatView[]> {
  const stamped = new Map<string, AgentRecord>();
  for (const seat of resolveSeats(references)) {
    stamped.set(seat.id, await withOccupantStamp(seat, context));
  }
  const preview = [...stamped.values()].map(edit);
  validate(preview);
  if (dryRun) return preview.map(seatView);
  const timestamp = now();
  const results: AgentRecord[] = [];
  await store.commit((state) => {
    results.length = 0;
    for (const before of stamped.values()) {
      const current = state.agents.find((agent) => agent.id === before.id);
      if (!current) throw new Error(`Swarm seat disappeared: ${before.id}`);
      const edited = edit({ ...current, occupant: current.occupant ?? before.occupant });
      results.push({ ...edited, updatedAt: timestamp });
    }
    return results.map((record) => ({ op: "put" as const, collection: "agents" as const, record }));
  });
  return results.map(seatView);
}

export type AgentConfigPatch = {
  [Key in keyof AgentConfig]-?: AgentConfig[Key] | null | undefined;
};

const PROVIDER_SETTINGS = ["modeId", "thinkingOptionId", "featureValues"] as const;

function changesProvider(seat: AgentRecord, provider: string): boolean {
  const current = seat.agentConfig?.provider ?? currentOccupant(seat).config.provider;
  return !current || providerFamily(current) !== providerFamily(provider);
}

// A replacement inherits settings only from an occupant of the same provider. A seat that wants
// another provider names its model, which Paseo needs to create the agent, and its mode, since mode
// names do not transfer: Claude's "auto" approves through a classifier, while Codex's "auto" asks
// and its classifier mode is "auto-review". A guessed mode could stall an agent or let it act
// without asking.
function assertBootable(seats: AgentRecord[]): void {
  const incomplete = seats.filter((seat) => {
    const wanted = seat.agentConfig?.provider;
    const running = currentOccupant(seat).config.provider;
    if (!wanted || (running && providerFamily(running) === providerFamily(wanted))) return false;
    return !wanted.includes("/") || !seat.agentConfig?.modeId;
  });
  if (incomplete.length === 0) return;
  throw new Error(
    "Moving a seat to another provider needs provider/model and a mode for it: " +
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
      // The old provider's thinking option and feature values mean nothing to the new one; the
      // new agent gets its provider's defaults unless the edit sets them.
      if (patch.provider && changesProvider(seat, patch.provider)) {
        for (const field of PROVIDER_SETTINGS) delete agentConfig[field];
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

// Pages a past occupant's transcript from Paseo's provider-agnostic timeline, newest first.
// The occupant is archived, so the daemon reads its history without resuming its session.
export async function readSeatHistory(
  input: { seat: string; actorName?: string; occupant?: number; before?: string; limit: number },
  context: SeatContext,
): Promise<SeatHistory> {
  const seat = findSeat(input.seat, true);
  if (input.actorName) assertCanReadHistory(seat, input.actorName);
  const past = seat.pastOccupants ?? [];
  const occupant =
    input.occupant === undefined
      ? past.at(-1)
      : past.find((candidate) => candidate.number === input.occupant);
  if (!occupant) {
    throw new Error(
      input.occupant === undefined
        ? `Seat ${agentQualifiedName(seat)} has no earlier occupants`
        : `Seat ${agentQualifiedName(seat)} has no earlier occupant ${input.occupant}`,
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

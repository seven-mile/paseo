import type { AgentConfig, AgentRecord, PastOccupant } from "../shared/models";
import { currentOccupant, providerFamily } from "../shared/models";

// The seat's agentConfig is the spec; its agent is a cache of that spec. When mail wakes a seat,
// planSeat says how to bring the agent in line: keep it, change it in place (same session, same
// context), bring back an earlier agent that already runs the spec, or start a new agent.
//
// The rules are conservative. A change they do not know to be safe in place gets a new agent, so
// a gap here costs context, never a broken session. Teaching them more only turns replacements
// into in-place changes. Every rule about what a seat change costs belongs in this file.
export type SeatPlan =
  | { kind: "keep" }
  | { kind: "adjust"; reason: string; apply: AgentConfigApply }
  | { kind: "revive"; reason: string; occupant: PastOccupant }
  | { kind: "replace"; reason: string };

// What an in-place change sends to the live agent; see the agent handle's applyConfig.
export interface AgentConfigApply {
  modelId?: string;
  modeId?: string;
  thinkingOptionId?: string;
  featureValues?: Record<string, unknown>;
}

// Providers whose sessions keep working after a model switch. A provider that routes to several
// vendors, such as Copilot or OpenCode, can hold content another vendor refuses (encrypted
// reasoning, some attachments), so it stays out until a switch there is known to be safe.
const MODEL_SWITCH_KEEPS_CONTEXT = new Set(["claude", "codex"]);

interface Change {
  description: string;
  inPlace: boolean;
  apply: AgentConfigApply;
}

// "claude" matches any Claude model; "claude/opus" matches only that model.
function providerMatches(wanted: string, actual: string | undefined): boolean {
  if (actual === undefined) return false;
  if (wanted.includes("/")) return wanted === actual;
  return actual === wanted || actual.startsWith(`${wanted}/`);
}

function sameValues(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].every((key) => JSON.stringify(left[key]) === JSON.stringify(right[key]));
}

function modelSwitchInPlace(wanted: string, running: string | undefined): AgentConfigApply | null {
  if (!running || !wanted.includes("/")) return null;
  const family = providerFamily(wanted);
  if (family !== providerFamily(running) || !MODEL_SWITCH_KEEPS_CONTEXT.has(family)) return null;
  return { modelId: wanted.slice(family.length + 1) };
}

// The fields a seat specifies that the agent does not run. Fields the seat leaves out are not
// compared. Mode, thinking, and feature values change on a live agent without touching its
// context; a model switch does so only on the providers listed above.
function changes(wanted: AgentConfig, running: AgentConfig): Change[] {
  const result: Change[] = [];
  if (wanted.provider !== undefined && !providerMatches(wanted.provider, running.provider)) {
    const apply = modelSwitchInPlace(wanted.provider, running.provider);
    result.push({
      description: `provider ${running.provider ?? "unknown"} → ${wanted.provider}`,
      inPlace: apply !== null,
      apply: apply ?? {},
    });
  }
  if (wanted.modeId !== undefined && wanted.modeId !== running.modeId) {
    result.push({
      description: `mode ${running.modeId ?? "unknown"} → ${wanted.modeId}`,
      inPlace: true,
      apply: { modeId: wanted.modeId },
    });
  }
  if (
    wanted.thinkingOptionId !== undefined &&
    wanted.thinkingOptionId !== running.thinkingOptionId
  ) {
    result.push({
      description: `thinking ${running.thinkingOptionId ?? "unknown"} → ${wanted.thinkingOptionId}`,
      inPlace: true,
      apply: { thinkingOptionId: wanted.thinkingOptionId },
    });
  }
  if (
    wanted.featureValues !== undefined &&
    !sameValues(wanted.featureValues, running.featureValues ?? {})
  ) {
    result.push({
      description: "features changed",
      inPlace: true,
      apply: { featureValues: wanted.featureValues },
    });
  }
  return result;
}

export function planSeat(
  seat: Pick<
    AgentRecord,
    "agentConfig" | "generation" | "occupant" | "pastOccupants" | "createdAt"
  >,
): SeatPlan {
  const occupant = currentOccupant(seat);
  const generation = seat.generation ?? 0;
  // A reset asks for a clean context, so no agent from before it is reused.
  if (generation !== occupant.generation) return { kind: "replace", reason: "reset" };
  const wanted = seat.agentConfig ?? {};
  const diff = changes(wanted, occupant.config);
  if (diff.length === 0) return { kind: "keep" };
  const reason = diff.map((change) => change.description).join(", ");
  if (diff.every((change) => change.inPlace)) {
    return { kind: "adjust", reason, apply: Object.assign({}, ...diff.map((c) => c.apply)) };
  }
  // The most recent earlier agent the spec fits, give or take in-place changes, still has the
  // context of its time in the seat. Switching A → B → A brings the A agent back.
  const earlier = (seat.pastOccupants ?? [])
    .toReversed()
    .find(
      (past) =>
        past.generation === generation &&
        changes(wanted, past.config).every((change) => change.inPlace),
    );
  if (earlier) return { kind: "revive", reason, occupant: earlier };
  return { kind: "replace", reason };
}

// What the next mail to the seat will do to its agent, or null while the agent fits the seat.
export function seatPendingChange(seat: Parameters<typeof planSeat>[0]): string | null {
  const plan = planSeat(seat);
  switch (plan.kind) {
    case "keep":
      return null;
    case "adjust":
      return `${plan.reason}, in place`;
    case "revive":
      return `${plan.reason}, back to occupant ${plan.occupant.number}`;
    case "replace":
      return plan.reason;
  }
}

// The stamp an agent carries after an in-place change: what it ran, with the seat's fields over it.
// A seat that names only its provider keeps the model the agent runs.
export function adjustedConfig(wanted: AgentConfig, running: AgentConfig): AgentConfig {
  const config: AgentConfig = { ...running };
  for (const [key, value] of Object.entries(wanted) as Array<[keyof AgentConfig, never]>) {
    if (value !== undefined) config[key] = value;
  }
  if (wanted.provider && !wanted.provider.includes("/") && running.provider) {
    config.provider = running.provider;
  }
  return config;
}

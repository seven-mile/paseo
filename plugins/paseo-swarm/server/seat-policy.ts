import type { AgentConfig, AgentRecord, PastOccupant } from "../shared/models";
import { currentOccupant, providerFamily } from "../shared/models";

// The seat's agentConfig is the spec; its agent is a cache of that spec. When mail wakes a seat,
// planSeat says how to bring the agent in line: keep it, change it in place (same session, same
// context), bring back an earlier agent that already runs the spec, or start a new agent.
//
// A reserved seat has no agent yet, so its first mail starts one.
//
// The rules are conservative. A change they do not know to be safe in place gets a new agent, so
// a gap here costs context, never a broken session. Teaching them more only turns replacements
// into in-place changes. Every rule about what a seat change costs belongs in this file.
export type SeatPlan =
  | { kind: "keep" }
  | { kind: "start"; reason: string }
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

// True when an agent on `from` can switch to `to` without losing a working session.
function modelSwitchKeepsContext(from: string | undefined, to: string): boolean {
  if (!from) return false;
  const family = providerFamily(to);
  return family === providerFamily(from) && MODEL_SWITCH_KEEPS_CONTEXT.has(family);
}

// Feature values a seat names are managed one key at a time; keys it leaves out are not.
function changedFeatures(
  wanted: Record<string, unknown> | undefined,
  running: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(wanted ?? {}).filter(
      ([key, value]) => JSON.stringify(value) !== JSON.stringify(running?.[key]),
    ),
  );
}

// The fields a seat specifies that the agent does not run. Fields the seat leaves out are not
// compared. Mode, thinking, and feature values change on a live agent without touching its
// context; a model switch does so only on the providers listed above.
function changes(wanted: AgentConfig, running: AgentConfig): Change[] {
  const result: Change[] = [];
  if (wanted.provider !== undefined && !providerMatches(wanted.provider, running.provider)) {
    const inPlace =
      wanted.provider.includes("/") && modelSwitchKeepsContext(running.provider, wanted.provider);
    result.push({
      description: `provider ${running.provider ?? "unknown"} → ${wanted.provider}`,
      inPlace,
      apply: inPlace
        ? { modelId: wanted.provider.slice(providerFamily(wanted.provider).length + 1) }
        : {},
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
  const features = changedFeatures(wanted.featureValues, running.featureValues);
  if (Object.keys(features).length > 0) {
    result.push({
      description: `features ${Object.keys(features).join(", ")}`,
      inPlace: true,
      apply: { featureValues: features },
    });
  }
  return result;
}

export function planSeat(
  seat: Pick<
    AgentRecord,
    "paseoAgentId" | "agentConfig" | "generation" | "occupant" | "pastOccupants" | "createdAt"
  >,
): SeatPlan {
  if (seat.paseoAgentId === null) return { kind: "start", reason: "no agent yet" };
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
  // The most recent earlier agent that runs the spec as it stands still has the context of its
  // time in the seat, so switching A → B → A brings the A agent back. Only an exact fit returns:
  // the return brief starts a turn, and that turn must not run under an old mode.
  const earlier = (seat.pastOccupants ?? [])
    .toReversed()
    .find((past) => past.generation === generation && changes(wanted, past.config).length === 0);
  if (earlier) return { kind: "revive", reason, occupant: earlier };
  return { kind: "replace", reason };
}

// The stamp an agent carries after an in-place change: what Swarm gave it before, with the seat's
// fields over it. A seat that names only its provider keeps the model the agent runs.
export function adjustedConfig(wanted: AgentConfig, running: AgentConfig): AgentConfig {
  const config: AgentConfig = { ...running };
  if (wanted.provider !== undefined && !providerMatches(wanted.provider, running.provider)) {
    config.provider = wanted.provider;
  }
  if (wanted.modeId !== undefined) config.modeId = wanted.modeId;
  if (wanted.thinkingOptionId !== undefined) config.thinkingOptionId = wanted.thinkingOptionId;
  if (wanted.featureValues !== undefined) {
    config.featureValues = { ...running.featureValues, ...wanted.featureValues };
  }
  return config;
}

// What a new agent boots with: the seat's spec, nothing inherited, so a field the seat leaves out
// or clears gets the provider's default. A bare provider takes the model the previous agent ran,
// since Paseo creates agents from "provider/model".
export function bootConfig(wanted: AgentConfig, previous: AgentConfig): AgentConfig {
  const config: AgentConfig = Object.fromEntries(
    Object.entries(wanted).filter(([, value]) => value !== undefined),
  );
  if (!config.provider) config.provider = previous.provider;
  else if (providerMatches(config.provider, previous.provider)) config.provider = previous.provider;
  return config;
}

// Settings a seat edit drops when it changes the provider, unless the edit sets them: modes,
// thinking options, and feature values are defined per provider, and thinking options and
// feature values per model too, unless a model switch on that provider is known to be safe.
export function settingsLostOnProviderChange(
  from: string | undefined,
  to: string,
): Array<"modeId" | "thinkingOptionId" | "featureValues"> {
  if (!from || providerFamily(from) !== providerFamily(to)) {
    return ["modeId", "thinkingOptionId", "featureValues"];
  }
  if (providerMatches(to, from) || modelSwitchKeepsContext(from, to)) return [];
  return ["thinkingOptionId", "featureValues"];
}

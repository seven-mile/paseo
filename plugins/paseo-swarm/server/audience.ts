import {
  agentQualifiedName,
  HUMAN,
  type AgentRecord,
  type AudienceEntry,
  type SwarmState,
} from "../shared/models";
import { findAgent } from "./swarms";

// Who a write goes to. Defaults come from roles on the work (requester, owner, the owner's
// manager, the asker of a reply), never from who plans. A sender that gives either list owns the
// whole audience, so `to: []` reaches no one. Recipients in `always` join whatever the lists say.

export interface AudienceTarget {
  name: string;
  why: AudienceEntry["why"];
}

export interface Audience {
  entries: AudienceEntry[];
  // The seats among the entries, which get mail. The human has no mailbox.
  seats: { seat: AgentRecord; as: "to" | "cc" }[];
  to: string[];
  cc: string[];
}

export interface AudienceInput {
  state: Readonly<SwarmState>;
  swarmId: string;
  actorName: string;
  to?: readonly string[];
  cc?: readonly string[];
  defaults?: { to?: AudienceTarget[]; cc?: AudienceTarget[] };
  // Added as To whatever the lists say: the owner when another seat writes its record, the asker
  // of the Activity being replied to.
  always?: AudienceTarget[];
}

function activeSeat(state: Readonly<SwarmState>, swarmId: string, name: string) {
  return state.agents.find(
    (seat) => seat.swarmId === swarmId && !seat.retired && agentQualifiedName(seat) === name,
  );
}

// A name the sender wrote: "human", or a seat by local or qualified name. An unknown or retired
// seat refuses the write, so a typo never drops a recipient silently.
function named(swarmId: string, name: string, actorName: string): string {
  if (name === HUMAN) return HUMAN;
  return agentQualifiedName(findAgent(swarmId, name, actorName));
}

// A default that no longer resolves, such as a retired requester, is left out.
function present(state: Readonly<SwarmState>, swarmId: string, target: AudienceTarget) {
  return target.name === HUMAN || activeSeat(state, swarmId, target.name) !== undefined;
}

export function resolveAudience(input: AudienceInput): Audience {
  const { state, swarmId, actorName } = input;
  const explicit = input.to !== undefined || input.cc !== undefined;
  const toTargets: AudienceTarget[] = explicit
    ? (input.to ?? []).map((name) => ({ name: named(swarmId, name, actorName), why: "named" }))
    : (input.defaults?.to ?? []).filter((target) => present(state, swarmId, target));
  const ccTargets: AudienceTarget[] = explicit
    ? (input.cc ?? []).map((name) => ({ name: named(swarmId, name, actorName), why: "named" }))
    : (input.defaults?.cc ?? []).filter((target) => present(state, swarmId, target));
  const always = (input.always ?? []).filter((target) => present(state, swarmId, target));

  const entries: AudienceEntry[] = [];
  const seen = new Set<string>([actorName]);
  for (const target of [...always, ...toTargets]) {
    if (seen.has(target.name)) continue;
    seen.add(target.name);
    entries.push({ name: target.name, as: "to", why: target.why });
  }
  for (const target of ccTargets) {
    if (seen.has(target.name)) continue;
    seen.add(target.name);
    entries.push({ name: target.name, as: "cc", why: target.why });
  }
  const seats = entries.flatMap((entry) => {
    const seat = entry.name === HUMAN ? undefined : activeSeat(state, swarmId, entry.name);
    return seat ? [{ seat, as: entry.as }] : [];
  });
  return {
    entries,
    seats,
    to: entries.filter((entry) => entry.as === "to").map((entry) => entry.name),
    cc: entries.filter((entry) => entry.as === "cc").map((entry) => entry.name),
  };
}

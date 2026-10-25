import { createHash, randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isMap, parseDocument, type Document } from "yaml";
import type { SeatChange, SpecIntent, SwarmRecord, SwarmState } from "../shared/models";
import { agentQualifiedName } from "../shared/models";
import { SWARM_FILE } from "./pwa";
import { definedConfig, ensureSwarmFile, failQueuedMail, sameConfig, TEAM_OF } from "./roster";
import { store, type SwarmChange } from "./state";
import { findSwarm, swarmSeats } from "./swarms";

// A seat tool changes swarm.yaml and the accepted seats together, so the file stays the spec
// the swarm runs and the next `up` has nothing of the tool's to undo:
//
//   1. Read swarm.yaml and hash it.
//   2. Check only the sections the change writes against what the swarm accepted. Edits the user
//      has not accepted elsewhere in the file do not block it.
//   3. Commit an intent: the change, the file's hash before, and its hash after.
//   4. Write the file through the yaml Document API, so comments and order survive.
//   5. Commit the accepted change and clear the intent, in one store commit.
//
// A crash between 3 and 5 leaves the intent, and recoverIntents settles it from the file's hash.
// Changes to one swarm run one at a time.

const locks = new Map<string, Promise<unknown>>();

// One entry per swarm, holding its last change.
export function withSwarmLock<T>(swarmId: string, run: () => Promise<T>): Promise<T> {
  const next = (locks.get(swarmId) ?? Promise.resolve()).then(run, run);
  locks.set(
    swarmId,
    next.catch(() => {}),
  );
  return next;
}

// Crash injection for tests: a throw from afterStep leaves the store and the file as a crash at
// that point would.
export const specHooks: { afterStep?: (step: "intent" | "write") => void } = {};

export class SpecConflictError extends Error {
  constructor(detail: string) {
    super(`${SWARM_FILE} conflict: ${detail}`);
    this.name = "SpecConflictError";
  }
}

const hashOf = (text: string) => createHash("sha256").update(text).digest("hex");

function readHash(path: string): string | null {
  try {
    return hashOf(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function filePath(swarm: SwarmRecord): string {
  return join(swarm.directory, SWARM_FILE);
}

// The key path of a seat in swarm.yaml: lead.dev is seats.lead.team.dev.
function seatPath(qualifiedName: string): string[] {
  return [
    "seats",
    ...qualifiedName.split(".").flatMap((name, index) => (index ? ["team", name] : [name])),
  ];
}

function nodeAt(data: unknown, path: string[]): Record<string, unknown> | undefined {
  let node = data;
  for (const key of path) {
    if (!node || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node && typeof node === "object" ? (node as Record<string, unknown>) : undefined;
}

// Where the file disagrees with the accepted meaning of the section a change writes, or null.
// Comments, order and flow style do not count.
function conflictOf(data: unknown, change: SeatChange, state: Readonly<SwarmState>): string | null {
  const name = agentQualifiedName(change.seat);
  const node = nodeAt(data, seatPath(name));
  if (change.kind === "add") {
    if (change.seat.reportsTo && !nodeAt(data, seatPath(change.seat.reportsTo))) {
      return `it no longer names ${change.seat.reportsTo}, the manager of ${name}`;
    }
    return node ? `it already names ${name}` : null;
  }
  if (!node) return `it no longer names ${name}`;
  const accepted = state.agents.find((seat) => seat.id === change.seat.id);
  const acceptedConfig = definedConfig(accepted?.agentConfig ?? {});
  const fileConfig = (node.agent ?? {}) as Record<string, unknown>;
  if (!sameConfig(acceptedConfig, fileConfig)) {
    return `the agent of ${name} has changes that are not accepted`;
  }
  if (change.kind === "retire") {
    if (node.role !== accepted?.role)
      return `the role of ${name} has changes that are not accepted`;
    const team = nodeAt(node, ["team"]);
    if (team && Object.keys(team).length > 0) return `it names seats under ${name}`;
  }
  return null;
}

function applyEdit(document: Document, change: SeatChange): void {
  const path = seatPath(agentQualifiedName(change.seat));
  if (change.kind === "retire") {
    document.deleteIn(path);
    return;
  }
  const agent = definedConfig(change.seat.agentConfig ?? {});
  if (change.kind === "add") {
    document.setIn(path, {
      role: change.seat.role,
      ...(Object.keys(agent).length > 0 ? { agent } : {}),
    });
    return;
  }
  // Key by key, so comments inside the agent block stay with their keys.
  const current = (nodeAt(document.toJS(), path)?.agent ?? {}) as Record<string, unknown>;
  for (const key of new Set([...Object.keys(current), ...Object.keys(agent)])) {
    const value = agent[key as keyof typeof agent];
    if (value === undefined) document.deleteIn([...path, "agent", key]);
    else if (JSON.stringify(value) !== JSON.stringify(current[key])) {
      document.setIn([...path, "agent", key], value);
    }
  }
  const block = document.getIn([...path, "agent"]);
  if (isMap(block) && block.items.length === 0) document.deleteIn([...path, "agent"]);
}

// The store changes that accept a seat change. They apply to the seat as it is now, so mail
// delivered while the change was in flight is kept.
function acceptChanges(
  state: Readonly<SwarmState>,
  changes: readonly SeatChange[],
  now: string,
): SwarmChange[] {
  const result: SwarmChange[] = [];
  for (const change of changes) {
    const current = state.agents.find((seat) => seat.id === change.seat.id);
    if (change.kind === "add") {
      if (current) continue;
      const name = agentQualifiedName(change.seat);
      const taken = state.agents.find(
        (seat) =>
          seat.swarmId === change.seat.swarmId &&
          (agentQualifiedName(seat) === name ||
            (change.seat.paseoAgentId !== null && seat.paseoAgentId === change.seat.paseoAgentId)),
      );
      if (taken) throw new Error(`Seat ${agentQualifiedName(taken)} already exists`);
      result.push({ op: "put", collection: "agents", record: change.seat });
      continue;
    }
    if (!current) throw new Error(`Swarm seat disappeared: ${change.seat.id}`);
    if (change.kind === "agent") {
      result.push({
        op: "put",
        collection: "agents",
        record: {
          ...current,
          agentConfig: change.seat.agentConfig,
          occupant: current.occupant ?? change.seat.occupant,
          updatedAt: now,
        },
      });
      continue;
    }
    result.push(
      { op: "put", collection: "agents", record: { ...current, retired: true, updatedAt: now } },
      ...failQueuedMail(state, current, change.reason, now),
    );
  }
  return result;
}

function isAccepted(state: Readonly<SwarmState>, intent: SpecIntent): boolean {
  return intent.changes.every((change) => {
    const current = state.agents.find((seat) => seat.id === change.seat.id);
    if (change.kind === "add") return current !== undefined;
    if (change.kind === "retire") return current?.retired === true;
    return sameConfig(
      definedConfig(current?.agentConfig ?? {}),
      definedConfig(change.seat.agentConfig ?? {}),
    );
  });
}

const dropIntent = (intent: SpecIntent): SwarmChange => ({
  op: "delete",
  collection: "intents",
  key: intent.id,
});

// Settles seat changes a crash left between their intent and their accepted commit. The file
// decides: with the new text the change is accepted, with the old one it never happened, and
// with neither the user chooses through `swarm recover`.
export async function recoverIntents(swarmId?: string): Promise<void> {
  for (const intent of store.read().intents) {
    if (intent.conflict || (swarmId && intent.swarmId !== swarmId)) continue;
    const swarm = store.read().swarms.find((candidate) => candidate.id === intent.swarmId);
    const hash = swarm ? readHash(filePath(swarm)) : null;
    await store.commit((state) => {
      if (!swarm || isAccepted(state, intent) || hash === intent.oldHash)
        return [dropIntent(intent)];
      if (hash === intent.newHash) {
        return [
          ...acceptChanges(state, intent.changes, new Date().toISOString()),
          dropIntent(intent),
        ];
      }
      const seats = intent.changes.map((change) => agentQualifiedName(change.seat)).join(", ");
      return [
        {
          op: "put",
          collection: "intents",
          record: {
            ...intent,
            conflict: `${SWARM_FILE} changed while a change to ${seats} was being written, so Swarm cannot tell whether it was saved.`,
          },
        },
      ];
    });
  }
}

export function pendingConflict(swarmId: string): SpecIntent | undefined {
  return store.read().intents.find((intent) => intent.swarmId === swarmId && intent.conflict);
}

export function assertNoConflict(swarmId: string): void {
  const intent = pendingConflict(swarmId);
  if (intent) {
    throw new Error(
      `${intent.conflict} Run \`paseo-swarm swarm recover --keep-file\` to keep the file as it is, or \`--apply-intent\` to apply the change to it.`,
    );
  }
}

function writeChecked(path: string, text: string, expectedHash: string): boolean {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, text, "utf8");
  if (readHash(path) !== expectedHash) {
    rmSync(temporary, { force: true });
    return false;
  }
  renameSync(temporary, path);
  return true;
}

// The parent's team holds the role class the tree allows, as `up` requires.
function assertPlacement(
  swarm: SwarmRecord,
  state: Readonly<SwarmState>,
  change: SeatChange,
): void {
  if (change.kind !== "add" || !change.seat.reportsTo) return;
  const parent = state.agents.find(
    (seat) =>
      seat.swarmId === swarm.id &&
      !seat.retired &&
      agentQualifiedName(seat) === change.seat.reportsTo,
  );
  if (!parent) throw new Error(`Unknown active agent: ${change.seat.reportsTo}`);
  const allowed = TEAM_OF[parent.roleClass];
  if (allowed !== change.seat.roleClass) {
    throw new Error(
      allowed
        ? `A ${parent.roleClass}'s team holds ${allowed}s, not ${change.seat.roleClass}s`
        : `${change.seat.reportsTo} is a worker and has no team`,
    );
  }
}

// Writes the seat changes `plan` returns to swarm.yaml and accepts them. `plan` runs under the
// swarm's lock against the accepted state, and may throw to refuse.
export function mutateSpec(
  swarmId: string,
  plan: (state: Readonly<SwarmState>) => SeatChange[],
): Promise<SeatChange[]> {
  return withSwarmLock(swarmId, async () => {
    await recoverIntents(swarmId);
    assertNoConflict(swarmId);
    const swarm = findSwarm(swarmId);
    const path = ensureSwarmFile(swarm, swarmSeats(swarmId));
    const text = readFileSync(path, "utf8");
    const document = parseDocument(text);
    if (document.errors.length > 0) {
      throw new SpecConflictError(`it is not valid YAML. Fix it before changing seats.`);
    }
    const state = store.read();
    const changes = plan(state);
    if (changes.length === 0) return changes;
    const data: unknown = document.toJS();
    const conflicts = changes
      .map((change) => conflictOf(data, change, state))
      .filter((conflict): conflict is string => conflict !== null);
    if (conflicts.length > 0) {
      throw new SpecConflictError(
        `${conflicts.join("; ")}. Run \`paseo-swarm swarm up\` to accept the file, or undo those edits.`,
      );
    }
    for (const change of changes) assertPlacement(swarm, state, change);
    for (const change of changes) applyEdit(document, change);
    const next = document.toString();
    const intent: SpecIntent = {
      id: `intent-${randomUUID()}`,
      swarmId,
      oldHash: hashOf(text),
      newHash: hashOf(next),
      changes,
      conflict: null,
      createdAt: new Date().toISOString(),
    };
    await store.commit(() => [{ op: "put", collection: "intents", record: intent }]);
    specHooks.afterStep?.("intent");
    if (!writeChecked(path, next, intent.oldHash)) {
      await store.commit(() => [dropIntent(intent)]);
      throw new SpecConflictError("it changed while the change was being written. Try again.");
    }
    specHooks.afterStep?.("write");
    await store.commit((current) => [
      ...acceptChanges(current, changes, new Date().toISOString()),
      dropIntent(intent),
    ]);
    return changes;
  });
}

// Resolves a recovery conflict: keep the file as the user left it, or apply the change to it
// and accept the change.
export function resolveConflict(swarmId: string, keep: "file" | "intent"): Promise<SpecIntent> {
  return withSwarmLock(swarmId, async () => {
    const intent = pendingConflict(swarmId);
    if (!intent) throw new Error(`Swarm ${swarmId} has no seat change to recover`);
    if (keep === "file") {
      await store.commit(() => [dropIntent(intent)]);
      return intent;
    }
    const path = filePath(findSwarm(swarmId));
    const text = readFileSync(path, "utf8");
    const document = parseDocument(text);
    if (document.errors.length > 0) {
      throw new SpecConflictError("it is not valid YAML. Fix it, then recover again.");
    }
    for (const change of intent.changes) applyEdit(document, change);
    if (!writeChecked(path, document.toString(), hashOf(text))) {
      throw new SpecConflictError("it changed while the change was being written. Try again.");
    }
    await store.commit((state) => [
      ...acceptChanges(state, intent.changes, new Date().toISOString()),
      dropIntent(intent),
    ]);
    return intent;
  });
}

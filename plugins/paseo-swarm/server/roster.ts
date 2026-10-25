import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";
import type { AgentConfig, AgentRecord, SwarmRecord, SwarmState } from "../shared/models";
import {
  agentConfigSchema,
  agentQualifiedName,
  mailboxMessageStatus,
  slugNameSchema,
} from "../shared/models";
import type { RosterPlan } from "../shared/swarm";
import {
  pwaFilesRevision,
  readPwa,
  readPwaFiles,
  SWARM_FILE,
  type PwaFiles,
  type RoleClass,
} from "./pwa";
import { assemblePrompt, assertBootable } from "./seats";
import type { SwarmChange } from "./state";
import { assertRunnablePwa } from "./swarms";

// swarm.yaml is the roster half of a swarm directory; PWA.md and roles/ are the other half. The
// file is a tree: nesting under team is the reporting line, so a seat's key path is its qualified
// name. It holds only what a seat should be. Occupants, workspaces and ids are local bindings
// that stay in the daemon.
//
// Roster reconciliation (`up`) accepts the directory: it validates the whole of it, then commits
// the seats and the PWA source it describes in one store commit. It never touches an agent;
// occupants catch up on their next mail, as after any seat edit.

const seatNodeSchema = z.strictObject({
  role: z.string().min(1),
  agent: agentConfigSchema.strict().optional(),
  get team() {
    return z.record(slugNameSchema, seatNodeSchema).optional();
  },
});
type SeatNode = z.infer<typeof seatNodeSchema>;

const swarmFileSchema = z.strictObject({
  version: z.literal(1),
  seats: z.record(slugNameSchema, seatNodeSchema).default({}),
});

// A seat as swarm.yaml describes it.
export interface DesiredSeat {
  name: string;
  qualifiedName: string;
  reportsTo: string | null;
  role: string;
  agentConfig: AgentConfig;
}

export interface DesiredSwarm {
  files: PwaFiles;
  seats: DesiredSeat[];
}

function issues(error: z.ZodError): string {
  return error.issues
    .map((issue) => (issue.path.length ? `${issue.path.join(".")}: ` : "") + issue.message)
    .join("; ");
}

export function parseSwarmFile(text: string): DesiredSeat[] {
  let data: unknown;
  try {
    data = parse(text);
  } catch (error) {
    throw new Error(`${SWARM_FILE} is not valid YAML`, { cause: error });
  }
  if (data && typeof data === "object" && "workspaces" in data) {
    throw new Error(`${SWARM_FILE}: workspaces are not supported yet; leave the key out`);
  }
  const parsed = swarmFileSchema.safeParse(data);
  if (!parsed.success) throw new Error(`${SWARM_FILE}: ${issues(parsed.error)}`);
  const seats: DesiredSeat[] = [];
  const walk = (nodes: Record<string, SeatNode>, parent: string | null) => {
    for (const [name, node] of Object.entries(nodes)) {
      const qualifiedName = parent ? `${parent}.${name}` : name;
      seats.push({
        name,
        qualifiedName,
        reportsTo: parent,
        role: node.role,
        agentConfig: definedConfig(node.agent ?? {}),
      });
      walk(node.team ?? {}, qualifiedName);
    }
  };
  walk(parsed.data.seats, null);
  return seats;
}

// The file describing these seats, in roster order. A seat whose manager is not among them has
// no place in the tree, so it is refused rather than moved, which would change its name.
export function renderSwarmFile(seats: readonly AgentRecord[]): string {
  const names = new Set(seats.map(agentQualifiedName));
  const orphans = seats.filter((seat) => seat.reportsTo && !names.has(seat.reportsTo));
  if (orphans.length > 0) {
    throw new Error(
      `${SWARM_FILE} cannot describe seats whose manager is not an active seat: ` +
        orphans
          .map((seat) => `${agentQualifiedName(seat)} (reports to ${seat.reportsTo})`)
          .join(", "),
    );
  }
  const tree = (reportsTo: string | null): Record<string, SeatNode> | undefined => {
    const team = seats.filter((seat) => seat.reportsTo === reportsTo);
    if (team.length === 0) return undefined;
    return Object.fromEntries(
      team.map((seat) => {
        const agent = definedConfig(seat.agentConfig ?? {});
        const children = tree(agentQualifiedName(seat));
        return [
          seat.name,
          {
            role: seat.role,
            ...(Object.keys(agent).length > 0 ? { agent } : {}),
            ...(children ? { team: children } : {}),
          },
        ];
      }),
    );
  };
  return stringify({ version: 1, seats: tree(null) ?? {} });
}

export function definedConfig(config: AgentConfig): AgentConfig {
  return Object.fromEntries(Object.entries(config).filter(([, value]) => value !== undefined));
}

// A directory without swarm.yaml gets one written from the accepted seats, which are the whole
// truth while no file exists. Seat tools otherwise edit the file in place (server/spec.ts).
export function ensureSwarmFile(swarm: SwarmRecord, accepted: readonly AgentRecord[]): string {
  const path = join(swarm.directory, SWARM_FILE);
  if (!existsSync(path)) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, renderSwarmFile(accepted), "utf8");
    renameSync(temporary, path);
  }
  return path;
}

// What the swarm directory asks for.
export function readDesired(swarm: SwarmRecord, accepted: readonly AgentRecord[]): DesiredSwarm {
  const path = ensureSwarmFile(swarm, accepted);
  const files = readPwaFiles(swarm.directory);
  assertRunnablePwa(files, swarm.directory);
  return { files, seats: parseSwarmFile(readFileSync(path, "utf8")) };
}

// Who may report to whom. A file can only nest seats, so this is the creation rule for agents
// stated for the tree.
export const TEAM_OF: Record<RoleClass, RoleClass | null> = {
  planner: "supervisor",
  supervisor: "worker",
  worker: null,
};

export function sameConfig(left: AgentConfig, right: AgentConfig): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]) as Set<keyof AgentConfig>;
  return [...keys].every((key) => JSON.stringify(left[key]) === JSON.stringify(right[key]));
}

function shown(value: unknown): string {
  if (value === undefined) return "unset";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function configChanges(from: AgentConfig, to: AgentConfig): string[] {
  const keys = new Set([...Object.keys(from), ...Object.keys(to)]) as Set<keyof AgentConfig>;
  return [...keys]
    .filter((key) => JSON.stringify(from[key]) !== JSON.stringify(to[key]))
    .map((key) => `${key} ${shown(from[key])} → ${shown(to[key])}`);
}

function promptRevision(seat: AgentRecord, files: PwaFiles): string | null {
  try {
    return assemblePrompt(seat, files).received.revision;
  } catch {
    return null;
  }
}

// Each desired seat's role class, from its role file, after checking that every team holds the
// class its manager's class allows.
function roleClasses(desired: DesiredSwarm): Map<string, RoleClass> {
  const roleClassOf = new Map<string, RoleClass>();
  for (const seat of desired.seats) {
    roleClassOf.set(seat.qualifiedName, readPwa(desired.files, seat.role).roleClass);
  }
  const problems: string[] = [];
  for (const seat of desired.seats) {
    if (!seat.reportsTo) continue;
    const managerClass = roleClassOf.get(seat.reportsTo)!;
    const roleClass = roleClassOf.get(seat.qualifiedName)!;
    const allowed = TEAM_OF[managerClass];
    if (allowed === roleClass) continue;
    problems.push(
      allowed
        ? `${seat.qualifiedName} is a ${roleClass}, but a ${managerClass}'s team holds ${allowed}s`
        : `${seat.qualifiedName} reports to ${seat.reportsTo}, but a worker has no team`,
    );
  }
  if (problems.length > 0) throw new Error(`${SWARM_FILE}: ${problems.join("; ")}`);
  return roleClassOf;
}

function reservedSeat(
  swarm: SwarmRecord,
  wanted: DesiredSeat,
  roleClass: RoleClass,
  now: string,
): AgentRecord {
  // A new seat's first agent starts from its spec alone, as one an agent hires does.
  if (!wanted.agentConfig.provider?.includes("/")) {
    throw new Error(`A new seat needs agent.provider as provider/model: ${wanted.qualifiedName}`);
  }
  return {
    id: `agent-${randomUUID()}`,
    swarmId: swarm.id,
    paseoAgentId: null,
    name: wanted.name,
    qualifiedName: wanted.qualifiedName,
    aliases: [],
    roleClass,
    role: wanted.role,
    reportsTo: wanted.reportsTo,
    workspaceId: null,
    ...(swarm.projectId ? { projectId: swarm.projectId } : {}),
    agentConfig: wanted.agentConfig,
    generation: 0,
    retired: false,
    createdAt: now,
    updatedAt: now,
  };
}

// Seats the file names: new ones reserved, changed or retired ones brought in line.
function planNamedSeats(
  swarm: SwarmRecord,
  desired: DesiredSwarm,
  seats: readonly AgentRecord[],
  plan: RosterPlan,
  now: string,
): AgentRecord[] {
  const roleClassOf = roleClasses(desired);
  const active = new Map(
    seats.filter((seat) => !seat.retired).map((seat) => [agentQualifiedName(seat), seat]),
  );
  // The most recent retired seat of each name, which a seat named again in the file revives.
  const retired = new Map(
    seats.filter((seat) => seat.retired).map((seat) => [agentQualifiedName(seat), seat]),
  );
  const records: AgentRecord[] = [];
  const before = new Map<string, AgentRecord>();
  for (const wanted of desired.seats) {
    const roleClass = roleClassOf.get(wanted.qualifiedName)!;
    const current = active.get(wanted.qualifiedName) ?? retired.get(wanted.qualifiedName);
    if (!current) {
      plan.reserve.push({ seat: wanted.qualifiedName, role: wanted.role });
      records.push(reservedSeat(swarm, wanted, roleClass, now));
      continue;
    }
    // The role class decides an agent's tools, and a live agent keeps the tools it opened with.
    if (current.roleClass !== roleClass) {
      plan.refusals.push(
        `${wanted.qualifiedName} would change role class from ${current.roleClass} to ${roleClass}. Give the new role a new seat name instead.`,
      );
      continue;
    }
    const accepted = definedConfig(current.agentConfig ?? {});
    const changes = [
      ...(current.role === wanted.role ? [] : [`role ${current.role} → ${wanted.role}`]),
      ...configChanges(accepted, wanted.agentConfig),
    ];
    if (current.retired) plan.restore.push({ seat: wanted.qualifiedName, changes });
    else if (changes.length > 0) plan.update.push({ seat: wanted.qualifiedName, changes });
    else continue;
    before.set(current.id, current);
    records.push({
      ...current,
      role: wanted.role,
      agentConfig: sameConfig(accepted, wanted.agentConfig)
        ? current.agentConfig
        : wanted.agentConfig,
      retired: false,
      updatedAt: now,
    });
  }
  assertBootable(
    records.filter((record) => before.has(record.id)),
    before,
  );
  return records;
}

// A retiring seat's queued mail fails with the reason and stays in the mailbox to read.
export function failQueuedMail(
  state: Readonly<SwarmState>,
  seat: AgentRecord,
  reason: string,
  now: string,
): SwarmChange[] {
  return state.messages
    .filter(
      (message) =>
        message.recipientAgentId === seat.id && mailboxMessageStatus(message) === "queued",
    )
    .map((message) => ({
      op: "put",
      collection: "messages",
      record: { ...message, lastError: reason, failedAt: now },
    }));
}

// Active seats the file no longer names. The Tasks that name them are listed, not judged.
function planRetirements(
  swarm: SwarmRecord,
  desired: DesiredSwarm,
  state: Readonly<SwarmState>,
  plan: RosterPlan,
  now: string,
): SwarmChange[] {
  const named = new Set(desired.seats.map((seat) => seat.qualifiedName));
  const active = state.agents.filter((seat) => seat.swarmId === swarm.id && !seat.retired);
  const retiring = active.filter((seat) => !named.has(agentQualifiedName(seat)));
  const retiringNames = new Set(retiring.map(agentQualifiedName));
  for (const seat of active) {
    if (
      seat.reportsTo &&
      retiringNames.has(seat.reportsTo) &&
      named.has(agentQualifiedName(seat))
    ) {
      plan.refusals.push(
        `Retiring ${seat.reportsTo} would leave ${agentQualifiedName(seat)} reporting to a retired seat. Retire its team with it.`,
      );
    }
  }
  const changes: SwarmChange[] = [];
  for (const seat of retiring) {
    const name = agentQualifiedName(seat);
    const failed = failQueuedMail(state, seat, `Seat ${name} was retired by swarm up`, now);
    plan.retire.push({
      seat: name,
      tasks: state.tasks
        .filter(
          (task) =>
            task.swarmId === swarm.id &&
            (task.managerName === name || task.workerNames.includes(name)),
        )
        .map((task) => task.id),
      queuedMessages: failed.length,
    });
    changes.push(
      { op: "put", collection: "agents", record: { ...seat, retired: true, updatedAt: now } },
      ...failed,
    );
  }
  return changes;
}

// The PWA files that changed, with the occupants whose standing prompt changes with them; each
// gets the new prompt before its next mail.
function planSource(
  swarm: SwarmRecord,
  desired: DesiredSwarm,
  staying: readonly AgentRecord[],
  edited: ReadonlyMap<string, AgentRecord>,
  plan: RosterPlan,
  now: string,
): SwarmChange[] {
  const revision = pwaFilesRevision(desired.files);
  if (revision === swarm.source.revision) return [];
  const accepted = swarm.source.files;
  const paths = new Set([...Object.keys(accepted), ...Object.keys(desired.files)]);
  plan.source = {
    files: [...paths].filter((path) => accepted[path] !== desired.files[path]).sort(),
    prompts: staying
      .filter((seat) => seat.paseoAgentId !== null)
      .filter(
        (seat) =>
          promptRevision(seat, accepted) !==
          promptRevision(edited.get(seat.id) ?? seat, desired.files),
      )
      .map(agentQualifiedName),
  };
  return [
    {
      op: "put",
      collection: "swarms",
      record: { ...swarm, source: { revision, files: { ...desired.files } }, updatedAt: now },
    },
  ];
}

// Compares the directory with what the swarm accepted, and returns the semantic plan with the
// store changes that carry it out. Seats match by qualified name only: a renamed or moved seat
// is a retirement plus a new seat. A retired seat named again comes back with its history.
// Throws when the directory cannot run; lists refusals when it can, but asks for a change this
// version does not make.
export function planRoster(
  swarm: SwarmRecord,
  desired: DesiredSwarm,
  state: Readonly<SwarmState>,
): { plan: RosterPlan; changes: SwarmChange[] } {
  const now = new Date().toISOString();
  const plan: RosterPlan = {
    reserve: [],
    restore: [],
    update: [],
    retire: [],
    source: null,
    refusals: [],
  };
  const seats = state.agents.filter((seat) => seat.swarmId === swarm.id);
  const named = planNamedSeats(swarm, desired, seats, plan, now);
  const retirements = planRetirements(swarm, desired, state, plan, now);
  const edited = new Map(named.map((record) => [record.id, record]));
  const wanted = new Set(desired.seats.map((seat) => seat.qualifiedName));
  const staying = seats.filter((seat) => !seat.retired && wanted.has(agentQualifiedName(seat)));
  const source = planSource(swarm, desired, staying, edited, plan, now);
  return {
    plan,
    changes: [
      ...source,
      ...named.map((record): SwarmChange => ({ op: "put", collection: "agents", record })),
      ...retirements,
    ],
  };
}

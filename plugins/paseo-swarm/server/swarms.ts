import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Activity, AgentRecord, SwarmRecord, Task } from "../shared/models";
import { agentQualifiedName } from "../shared/models";
import { listPwaRoles, pwaFilesRevision, readPwa, readPwaFiles, type PwaFiles } from "./pwa";
import { readPwaSource } from "./source";
import {
  getMigrationReportPath,
  getSwarmsDirectory,
  store,
  taskKey,
  type SwarmChange,
} from "./state";

// A swarm is a directory that describes a team, attached to one Paseo project. Seats, Tasks and
// Activities belong to one swarm, and names are unique only within it. The swarm's accepted PWA
// source lives in its record: prompts are assembled from that copy, never from the directory.

const now = () => new Date().toISOString();

// Checks that files form a PWA a swarm can run: every role parses, and one is a planner.
export function assertRunnablePwa(files: PwaFiles, where: string): void {
  const roles = listPwaRoles(files);
  if (!roles.some((role) => role.roleClass === "planner")) {
    throw new Error(`The PWA directory must contain a planner role: ${where}`);
  }
  for (const role of roles) readPwa(files, role.role);
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "swarm"
  );
}

// A new swarm directory holding exactly the given PWA files. The directory the files came from is
// only read: it can be a template, or a directory several projects shared before swarms.
function instantiate(input: {
  files: PwaFiles;
  name: string;
  projectId: string | null;
}): SwarmRecord {
  const id = `swarm-${randomUUID()}`;
  const directory = join(getSwarmsDirectory(), `${slug(input.name)}-${id.slice(6, 14)}`);
  mkdirSync(directory, { recursive: true });
  for (const [path, text] of Object.entries(input.files)) {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), text, "utf8");
  }
  const timestamp = now();
  return {
    id,
    name: input.name,
    directory,
    projectId: input.projectId,
    source: { revision: pwaFilesRevision(input.files), files: { ...input.files } },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function findSwarm(swarmId: string): SwarmRecord {
  const swarm = store.read().swarms.find((candidate) => candidate.id === swarmId);
  if (!swarm) throw new Error(`Unknown swarm: ${swarmId}`);
  return swarm;
}

// The swarm a seat, Task or Activity belongs to.
export function swarmOf(record: { swarmId?: string }): SwarmRecord {
  if (!record.swarmId) {
    throw new Error("This record predates swarms and has no swarm yet. Restart the daemon.");
  }
  return findSwarm(record.swarmId);
}

function projectSwarms(projectId: string | null): SwarmRecord[] {
  return store.read().swarms.filter((swarm) => swarm.projectId === projectId);
}

// The swarm a request works in when no seat of its own says: the swarm it names, else its
// project's, else the only swarm there is.
export function resolveSwarm(input: { swarmId?: string; projectId?: string }): SwarmRecord {
  if (input.swarmId) return findSwarm(input.swarmId);
  const candidates = input.projectId ? projectSwarms(input.projectId) : store.read().swarms;
  if (candidates.length === 1) return candidates[0];
  const where = input.projectId ? `project ${input.projectId}` : "this daemon";
  if (candidates.length === 0) {
    throw new Error(`No swarm in ${where}. Choose a PWA directory in Project Settings → Swarm.`);
  }
  throw new Error(`Several swarms in ${where}. Name the swarm.`);
}

// The swarm whose seats include one with this name, for a request that names its actor but not
// its swarm.
export function swarmOfSeatName(name: string): SwarmRecord {
  const swarmIds = new Set(
    store
      .read()
      .agents.filter(
        (seat) =>
          !seat.retired &&
          seat.swarmId &&
          (agentQualifiedName(seat) === name || seat.name === name),
      )
      .map((seat) => seat.swarmId),
  );
  if (swarmIds.size === 1) return findSwarm([...swarmIds][0]!);
  if (swarmIds.size === 0) throw new Error(`Unknown active agent: ${name}`);
  throw new Error(`Seat ${name} exists in several swarms. Name the swarm.`);
}

// A swarm instantiated from a PWA directory, for a project that has none. The directory is
// checked first, so a project is never attached to a swarm that cannot run.
export async function createSwarm(input: {
  sourceDirectory: string;
  projectId: string | null;
}): Promise<SwarmRecord> {
  const files = readPwaFiles(input.sourceDirectory);
  assertRunnablePwa(files, input.sourceDirectory);
  const swarm = instantiate({
    files,
    name: basename(input.sourceDirectory),
    projectId: input.projectId,
  });
  await store.commit((state) =>
    state.swarms.some((candidate) => candidate.projectId === input.projectId)
      ? []
      : [{ op: "put", collection: "swarms", record: swarm }],
  );
  const [attached] = projectSwarms(input.projectId);
  if (!attached) throw new Error(`Could not attach a swarm to project ${input.projectId}`);
  return attached;
}

// The swarm a new seat in this project joins. A project that had a PWA directory chosen before
// swarms gets its swarm from that directory on first use.
export async function swarmForProject(projectId: string | undefined): Promise<SwarmRecord> {
  const [existing] = projectSwarms(projectId ?? null);
  if (existing) return existing;
  const sourceDirectory = readPwaSource(projectId);
  if (!sourceDirectory) {
    throw new Error("No PWA directory configured. Choose one in Project Settings → Swarm.");
  }
  return createSwarm({ sourceDirectory, projectId: projectId ?? null });
}

export function swarmSeats(swarmId: string, includeRetired = false): AgentRecord[] {
  return store
    .read()
    .agents.filter((seat) => seat.swarmId === swarmId && (includeRetired || !seat.retired));
}

export function swarmTasks(swarmId: string): Task[] {
  return store.read().tasks.filter((task) => task.swarmId === swarmId);
}

interface MigrationIssue {
  collection: "tasks" | "activities";
  id: string;
  reason: string;
}

function onlyOne<T>(values: Set<T>): T | undefined {
  return values.size === 1 ? [...values][0] : undefined;
}

// Gives records from before swarms their swarm, once, at startup. Seats join the swarm of their
// project, instantiated from the PWA directory that project used, which is copied and never
// written. Tasks follow their manager's seat and Activities their Task. A record whose reference
// does not lead to exactly one swarm keeps no swarm and is listed in the migration report. No agent
// is woken: occupants, prompts and mail are left as they are.
export async function backfillSwarms(): Promise<void> {
  const state = store.read();
  const legacySeats = state.agents.filter((seat) => !seat.swarmId);
  const legacyTasks = state.tasks.filter((task) => !task.swarmId);
  const legacyActivities = state.activities.filter((activity) => !activity.swarmId);
  if (legacySeats.length + legacyTasks.length + legacyActivities.length === 0) return;

  const created: SwarmRecord[] = [];
  const swarmFor = new Map<string | null, string>();
  for (const projectId of new Set(legacySeats.map((seat) => seat.projectId ?? null))) {
    const existing = state.swarms.find((swarm) => swarm.projectId === projectId);
    if (existing) {
      swarmFor.set(projectId, existing.id);
      continue;
    }
    const sourceDirectory = readPwaSource(projectId ?? undefined);
    let files: PwaFiles = {};
    try {
      if (sourceDirectory) files = readPwaFiles(sourceDirectory);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(`[paseo-swarm] Could not read the PWA directory ${sourceDirectory}: ${detail}`);
    }
    const swarm = instantiate({
      files,
      name: sourceDirectory ? basename(sourceDirectory) : "swarm",
      projectId,
    });
    created.push(swarm);
    swarmFor.set(projectId, swarm.id);
  }

  const seats = state.agents.map((seat) =>
    seat.swarmId ? seat : { ...seat, swarmId: swarmFor.get(seat.projectId ?? null)! },
  );
  const issues: MigrationIssue[] = [];
  const migratedTasks: Task[] = [];
  for (const task of legacyTasks) {
    const swarmIds = new Set(
      seats
        .filter((seat) => agentQualifiedName(seat) === task.managerName)
        .map((seat) => seat.swarmId),
    );
    const swarmId = onlyOne(swarmIds);
    if (swarmId) {
      migratedTasks.push({ ...task, swarmId });
    } else {
      issues.push({
        collection: "tasks",
        id: task.id,
        reason:
          swarmIds.size === 0
            ? `No seat named ${task.managerName}, its manager`
            : `Its manager ${task.managerName} names seats in several swarms`,
      });
    }
  }
  const tasks = [...state.tasks.filter((task) => task.swarmId), ...migratedTasks];
  const migratedActivities: Activity[] = [];
  for (const activity of legacyActivities) {
    const swarmIds = new Set(
      tasks.filter((task) => task.id === activity.taskId).map((task) => task.swarmId),
    );
    const swarmId = onlyOne(swarmIds);
    if (swarmId) {
      migratedActivities.push({ ...activity, swarmId });
    } else {
      issues.push({
        collection: "activities",
        id: activity.id,
        reason:
          swarmIds.size === 0
            ? `Its Task ${activity.taskId} has no swarm`
            : `Its Task ${activity.taskId} exists in several swarms`,
      });
    }
  }

  const changes: SwarmChange[] = [
    ...created.map((record): SwarmChange => ({ op: "put", collection: "swarms", record })),
    ...seats
      .filter((seat) => legacySeats.some((legacy) => legacy.id === seat.id))
      .map((record): SwarmChange => ({ op: "put", collection: "agents", record })),
    // The key of a Task includes its swarm, so the record moves to a new key.
    ...migratedTasks.flatMap((record): SwarmChange[] => [
      { op: "delete", collection: "tasks", key: taskKey({ id: record.id }) },
      { op: "put", collection: "tasks", record },
    ]),
    ...migratedActivities.map(
      (record): SwarmChange => ({ op: "put", collection: "activities", record }),
    ),
  ];
  await store.commit(() => changes);
  if (issues.length > 0) {
    mkdirSync(dirname(getMigrationReportPath()), { recursive: true });
    writeFileSync(
      getMigrationReportPath(),
      JSON.stringify({ at: now(), issues }, null, 2) + "\n",
      "utf8",
    );
    console.warn(
      `[paseo-swarm] ${issues.length} records from before swarms have no swarm; see ${getMigrationReportPath()}`,
    );
  }
}

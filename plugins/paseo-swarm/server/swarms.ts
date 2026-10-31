import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { AgentRecord, SwarmRecord, Task } from "../shared/models";
import { agentQualifiedName } from "../shared/models";
import {
  listPwaRoles,
  pwaFilesRevision,
  readPwa,
  readPwaFiles,
  SWARM_FILE,
  type PwaFiles,
} from "./pwa";
import { readPwaSource } from "./source";
import { getSwarmsDirectory, store } from "./state";

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

// The record of a new swarm, with a directory of its own under the swarms directory. The
// migration passes its own id, so a retried migration names the same directory.
export function newSwarmRecord(input: {
  files: PwaFiles;
  name: string;
  projectId: string | null;
  id?: string;
}): SwarmRecord {
  const id = input.id ?? `swarm-${randomUUID()}`;
  const timestamp = now();
  return {
    id,
    name: input.name,
    directory: join(getSwarmsDirectory(), `${slug(input.name)}-${id.slice(6, 14)}`),
    projectId: input.projectId,
    source: { revision: pwaFilesRevision(input.files), files: { ...input.files } },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

// Writes a swarm's directory with exactly the given PWA files. The directory the files came from
// is only read: it can be a template, or a directory several projects shared before swarms.
export function writeSwarmDirectory(swarm: SwarmRecord, files: PwaFiles): void {
  mkdirSync(swarm.directory, { recursive: true });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(swarm.directory, path)), { recursive: true });
    writeFileSync(join(swarm.directory, path), text, "utf8");
  }
}

function instantiate(input: { files: PwaFiles; name: string; projectId: string | null }) {
  const swarm = newSwarmRecord(input);
  writeSwarmDirectory(swarm, input.files);
  return swarm;
}

export function findSwarm(swarmId: string): SwarmRecord {
  const swarm = store.read().swarms.find((candidate) => candidate.id === swarmId);
  if (!swarm) throw new Error(`Unknown swarm: ${swarmId}`);
  return swarm;
}

// The swarm a seat, Task or Activity belongs to.
export function swarmOf(record: { swarmId: string }): SwarmRecord {
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
        (seat) => !seat.retired && (agentQualifiedName(seat) === name || seat.name === name),
      )
      .map((seat) => seat.swarmId),
  );
  if (swarmIds.size === 1) return findSwarm([...swarmIds][0]!);
  if (swarmIds.size === 0) throw new Error(`Unknown active agent: ${name}`);
  throw new Error(`Seat ${name} exists in several swarms. Name the swarm.`);
}

// A swarm instantiated from a PWA directory, for a project that has none. The directory is
// checked first, so a project is never attached to a swarm that cannot run. A roster in the
// directory comes along unaccepted, so the first `up` reserves its seats.
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
  const roster = join(input.sourceDirectory, SWARM_FILE);
  if (existsSync(roster)) copyFileSync(roster, join(swarm.directory, SWARM_FILE));
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

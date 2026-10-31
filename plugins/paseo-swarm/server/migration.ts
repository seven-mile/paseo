import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import {
  activitySchema,
  approvalSchema,
  agentQualifiedName,
  agentRecordSchema,
  emptyState,
  mailboxMessageSchema,
  specIntentSchema,
  stateSchema,
  swarmRecordSchema,
  taskSchema,
  type SwarmRecord,
  type SwarmState,
} from "../shared/models";
import { readPwaFiles, type PwaFiles } from "./pwa";
import { replaceFile } from "./roster";
import { readPwaSource } from "./source";
import {
  getDataDirectory,
  getEventLogPath,
  getLegacyStatePath,
  getMigrationReportPath,
  getSnapshotPath,
  getSwarmsDirectory,
  readStoreFiles,
  store,
  storeVersionOnDisk,
  writeSnapshot,
  type CollectionName,
  type StoreFormat,
} from "./state";
import { assertRunnablePwa, newSwarmRecord, writeSwarmDirectory } from "./swarms";

// Converts a version 1 store, from before swarms, to the current format once, at startup. Seats
// join the swarm of their project, copied from the PWA directory that project used; Tasks follow
// their manager's seat and Activities their Task. No agent is woken.
//
// Nothing is written until the whole result is built and checked. Then the old files are copied
// to a backup, records that lead to no single swarm go to a legacy archive outside the live state,
// swarm directories are written, and the version 2 snapshot replaces the store in one rename. A
// failure before that rename leaves the version 1 store as it was, and the next start tries again.

const v1Records = {
  swarms: swarmRecordSchema,
  agents: agentRecordSchema.extend({ swarmId: z.string().optional() }),
  tasks: taskSchema.extend({ swarmId: z.string().optional() }),
  activities: activitySchema.extend({ swarmId: z.string().optional() }),
  messages: mailboxMessageSchema,
  intents: specIntentSchema,
  approvals: approvalSchema.extend({ swarmId: z.string().optional() }),
} satisfies Record<CollectionName, z.ZodTypeAny>;

const v1StateSchema = stateSchema.extend({
  agents: z.array(v1Records.agents),
  tasks: z.array(v1Records.tasks),
  activities: z.array(v1Records.activities),
  approvals: z.array(v1Records.approvals).default([]),
});
type V1State = z.infer<typeof v1StateSchema>;

const v1Format: StoreFormat<V1State> = {
  version: 1,
  state: v1StateSchema,
  record: (collection) => v1Records[collection],
};

interface ArchivedRecord {
  collection: CollectionName;
  reason: string;
  record: unknown;
}

interface Migration {
  state: SwarmState;
  // Swarms the migration makes, with the PWA files their directories get.
  created: Array<{ swarm: SwarmRecord; files: PwaFiles }>;
  archived: ArchivedRecord[];
  // Active seats with no agent block, whose first agent has nothing to start from.
  seatsWithoutAgent: string[];
}

const now = () => new Date().toISOString();

// A retried migration makes the same swarm for a project, in the same directory.
function migratedSwarmId(projectId: string | null): string {
  const digest = createHash("sha256")
    .update(`paseo-swarm migration ${projectId ?? ""}`)
    .digest("hex");
  return `swarm-${digest.slice(0, 32)}`;
}

function onlyOne<T>(values: Set<T>): T | undefined {
  return values.size === 1 ? [...values][0] : undefined;
}

function readOptionalJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

// Pre-seat records kept project and launch settings only in Paseo's workspace/agent stores.
function hydrateLegacySeats(seats: V1State["agents"]): V1State["agents"] {
  const home = join(getSwarmsDirectory(), "..");
  const workspaces = z
    .array(z.object({ workspaceId: z.string(), projectId: z.string() }))
    .parse(readOptionalJson(join(home, "projects", "workspaces.json")) ?? []);
  const agentsDirectory = join(home, "agents");
  const directories = existsSync(agentsDirectory)
    ? readdirSync(agentsDirectory, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    : [];
  const savedAgentSchema = z.object({
    provider: z.string().min(1),
    config: z
      .object({
        model: z.string().optional(),
        modeId: z.string().optional(),
        thinkingOptionId: z.string().optional(),
        featureValues: z.record(z.string(), z.unknown()).optional(),
      })
      .default({}),
  });
  const projectOf = (
    seat: V1State["agents"][number],
    seen = new Set<string>(),
  ): string | undefined => {
    if (seat.projectId) return seat.projectId;
    if (seen.has(seat.id))
      throw new Error(`Cyclic legacy reporting line at ${agentQualifiedName(seat)}`);
    seen.add(seat.id);
    const parents = seats.filter(
      (candidate) =>
        agentQualifiedName(candidate) === seat.reportsTo && candidate.swarmId === seat.swarmId,
    );
    const parentProject = parents.length === 1 ? projectOf(parents[0], seen) : undefined;
    return (
      parentProject ??
      workspaces.find((workspace) => workspace.workspaceId === seat.workspaceId)?.projectId
    );
  };
  return seats.map((seat) => {
    const projectId = projectOf(seat);
    let agentConfig =
      seat.agentConfig ?? (seat.occupant?.config.provider ? seat.occupant.config : undefined);
    let occupant = seat.occupant;
    if ((!agentConfig || !occupant) && seat.paseoAgentId) {
      for (const directory of directories) {
        const data = readOptionalJson(
          join(agentsDirectory, directory.name, `${seat.paseoAgentId}.json`),
        );
        if (data === undefined) continue;
        const saved = savedAgentSchema.parse(data);
        const { model, ...settings } = saved.config;
        const config = {
          ...settings,
          provider: model ? `${saved.provider}/${model}` : saved.provider,
        };
        agentConfig ??= config;
        occupant ??= {
          number: 1,
          config,
          generation: seat.generation ?? 0,
          boundAt: seat.createdAt,
        };
        break;
      }
    }
    return {
      ...seat,
      ...(projectId ? { projectId } : {}),
      ...(agentConfig ? { agentConfig } : {}),
      ...(occupant ? { occupant } : {}),
    };
  });
}

// Approvals follow the seat whose command they hold.
function placeApprovals(
  approvals: V1State["approvals"],
  seats: ReadonlyArray<{ id: string; swarmId: string }>,
  archived: ArchivedRecord[],
): SwarmState["approvals"] {
  const placed: SwarmState["approvals"] = [];
  for (const approval of approvals) {
    const swarmId = approval.swarmId ?? seats.find((seat) => seat.id === approval.agentId)?.swarmId;
    if (swarmId) placed.push({ ...approval, swarmId });
    else {
      archived.push({
        collection: "approvals",
        record: approval,
        reason: `Its seat ${approval.agentName} has no swarm`,
      });
    }
  }
  return placed;
}

function plan(old: V1State): Migration {
  old = { ...old, agents: hydrateLegacySeats(old.agents) };
  const swarms = [...old.swarms];
  const created: Migration["created"] = [];
  const swarmFor = new Map<string | null, string>();
  for (const projectId of new Set(
    old.agents.filter((seat) => !seat.swarmId).map((seat) => seat.projectId ?? null),
  )) {
    const existing = swarms.find((swarm) => swarm.projectId === projectId);
    if (existing) {
      swarmFor.set(projectId, existing.id);
      continue;
    }
    // A swarm that cannot run would fail every prompt, so the migration stops before writing.
    const owner = projectId ? `project ${projectId}` : "seats with no project";
    const sourceDirectory = readPwaSource(projectId ?? undefined);
    if (!sourceDirectory) {
      throw new Error(`Swarm cannot migrate the seats of ${owner}: no PWA directory is configured`);
    }
    let files: PwaFiles;
    try {
      files = readPwaFiles(sourceDirectory);
      assertRunnablePwa(files, sourceDirectory);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Swarm cannot migrate the seats of ${owner}: ${detail}`, { cause: error });
    }
    const swarm = newSwarmRecord({
      files,
      name: basename(sourceDirectory),
      projectId,
      id: migratedSwarmId(projectId),
    });
    created.push({ swarm, files });
    swarms.push(swarm);
    swarmFor.set(projectId, swarm.id);
  }

  const seatsWithoutAgent: string[] = [];
  const agents = old.agents.map((seat) => {
    const swarmId = seat.swarmId ?? swarmFor.get(seat.projectId ?? null)!;
    // A seat from before seats kept no agent block; the config its agent runs is the best record.
    const agentConfig =
      seat.agentConfig ?? (seat.occupant?.config.provider ? seat.occupant.config : undefined);
    if (!agentConfig && !seat.retired) seatsWithoutAgent.push(agentQualifiedName(seat));
    return { ...seat, swarmId, ...(agentConfig ? { agentConfig } : {}) };
  });

  const archived: ArchivedRecord[] = [];
  const tasks: SwarmState["tasks"] = [];
  for (const task of old.tasks) {
    if (task.swarmId) {
      tasks.push({ ...task, swarmId: task.swarmId });
      continue;
    }
    const swarmIds = new Set(
      agents.filter((seat) => agentQualifiedName(seat) === task.managerName).map((s) => s.swarmId),
    );
    const swarmId = onlyOne(swarmIds);
    if (swarmId) tasks.push({ ...task, swarmId });
    else {
      archived.push({
        collection: "tasks",
        record: task,
        reason:
          swarmIds.size === 0
            ? `No seat named ${task.managerName}, its manager`
            : `Its manager ${task.managerName} names seats in several swarms`,
      });
    }
  }
  const activities: SwarmState["activities"] = [];
  for (const activity of old.activities) {
    if (activity.swarmId) {
      activities.push({ ...activity, swarmId: activity.swarmId });
      continue;
    }
    const swarmIds = new Set(
      tasks.filter((task) => task.id === activity.taskId).map((task) => task.swarmId),
    );
    const swarmId = onlyOne(swarmIds);
    if (swarmId) activities.push({ ...activity, swarmId });
    else {
      archived.push({
        collection: "activities",
        record: activity,
        reason:
          swarmIds.size === 0
            ? `Its Task ${activity.taskId} has no swarm`
            : `Its Task ${activity.taskId} exists in several swarms`,
      });
    }
  }
  const seatIds = new Set(agents.map((seat) => seat.id));
  const messages = old.messages.filter((message) => {
    if (seatIds.has(message.recipientAgentId)) return true;
    archived.push({
      collection: "messages",
      record: message,
      reason: `Its recipient ${message.recipientName} has no seat`,
    });
    return false;
  });
  const approvals = placeApprovals(old.approvals, agents, archived);

  const state = stateSchema.parse({
    ...old,
    swarms,
    agents,
    tasks,
    activities,
    messages,
    approvals,
  });
  const swarmIds = new Set(state.swarms.map((swarm) => swarm.id));
  for (const record of [...state.agents, ...state.tasks, ...state.activities]) {
    if (!swarmIds.has(record.swarmId)) {
      throw new Error(`Swarm cannot migrate record ${record.id}: unknown swarm ${record.swarmId}`);
    }
  }
  return { state, created, archived, seatsWithoutAgent };
}

export function getLegacyArchivePath(): string {
  return join(getDataDirectory(), "legacy-archive.json");
}

function writeJson(path: string, value: unknown): void {
  replaceFile(path, JSON.stringify(value, null, 2) + "\n");
}

export async function migrateStore(): Promise<void> {
  if (storeVersionOnDisk() !== 1) return;
  const at = now();
  let migration: Migration;
  let seq: number;
  try {
    const files = readStoreFiles(v1Format, () => emptyState() as V1State);
    seq = files.seq;
    migration = plan(files.state);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    mkdirSync(getDataDirectory(), { recursive: true });
    writeJson(getMigrationReportPath(), { at, from: 1, to: 2, error: detail });
    throw error;
  }

  const backup = join(getDataDirectory(), `backup-v1-${at.replace(/[:.]/g, "-")}`);
  mkdirSync(backup, { recursive: true });
  for (const path of [getSnapshotPath(), getEventLogPath(), getLegacyStatePath()]) {
    if (existsSync(path)) replaceFile(join(backup, basename(path)), readFileSync(path, "utf8"));
  }
  if (migration.archived.length > 0) {
    writeJson(getLegacyArchivePath(), { at, from: 1, records: migration.archived });
  }
  for (const { swarm, files } of migration.created) writeSwarmDirectory(swarm, files);
  // The switch: from here the store is version 2.
  writeSnapshot(migration.state, seq);
  rmSync(getLegacyStatePath(), { force: true });
  store.forget();

  writeJson(getMigrationReportPath(), {
    at,
    from: 1,
    to: 2,
    backup,
    swarmsCreated: migration.created.map(({ swarm }) => swarm.directory),
    archive: migration.archived.length > 0 ? getLegacyArchivePath() : null,
    archived: migration.archived.map(({ collection, record, reason }) => ({
      collection,
      id: (record as { id: string }).id,
      reason,
    })),
    seatsWithoutAgent: migration.seatsWithoutAgent,
  });
  if (migration.archived.length + migration.seatsWithoutAgent.length > 0) {
    console.warn(
      `[paseo-swarm] Migrated Swarm state to version 2 with ${migration.archived.length} records archived and ${migration.seatsWithoutAgent.length} seats without an agent block; see ${getMigrationReportPath()}`,
    );
  }
}

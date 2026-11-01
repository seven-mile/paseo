import {
  closeSync,
  fsyncSync,
  fstatSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  activitySchema,
  agentRecordSchema,
  emptyState,
  mailboxMessageSchema,
  specIntentSchema,
  stateSchema,
  swarmRecordSchema,
  taskSchema,
  type SwarmState,
} from "../shared/models";

function getPaseoHome(): string {
  return process.env.PASEO_HOME ?? process.env.PASEO_DATA_DIR ?? process.cwd();
}

export function getDataDirectory(): string {
  return join(getPaseoHome(), "plugin-data", "paseo-swarm");
}

// Where swarm directories are instantiated by default. They are the user's files, so they live
// beside Paseo's own stores rather than in the plugin's data.
export function getSwarmsDirectory(): string {
  return join(getPaseoHome(), "swarms");
}

export function getMigrationReportPath(): string {
  return join(getDataDirectory(), "migration-report.json");
}

// Whole-file store used before the event log. Only the migration from version 1 reads it.
export function getLegacyStatePath(): string {
  return join(getDataDirectory(), "state.json");
}

export function getSnapshotPath(): string {
  return join(getDataDirectory(), "snapshot.json");
}

export function getEventLogPath(): string {
  return join(getDataDirectory(), "events.jsonl");
}

export function getMcpTokenPath(): string {
  return join(getDataDirectory(), "mcp-tokens.json");
}

export function getConfigPath(): string {
  return join(getDataDirectory(), "config.json");
}

// The store key of a Task: its id is unique only within its swarm.
export function taskKey(task: { id: string; swarmId?: string }): string {
  return `${task.swarmId ?? ""}/${task.id}`;
}

const byId = (record: { id: string }) => record.id;

// Each collection is keyed by its records' own id, except Tasks. A new collection is one entry
// here plus its array in stateSchema. Agents are keyed by the roster id, not paseoAgentId, so the
// Paseo agent behind a roster member can change without changing its identity.
const collections = {
  swarms: { schema: swarmRecordSchema, key: byId },
  agents: { schema: agentRecordSchema, key: byId },
  tasks: { schema: taskSchema, key: taskKey },
  activities: { schema: activitySchema, key: byId },
  messages: { schema: mailboxMessageSchema, key: byId },
  intents: { schema: specIntentSchema, key: byId },
} as const;
type Collections = typeof collections;
export type CollectionName = keyof Collections;
type RecordOf<C extends CollectionName> = SwarmState[C][number];

export type SwarmChange = {
  [C in CollectionName]:
    | { op: "put"; collection: C; record: RecordOf<C> }
    | { op: "delete"; collection: C; key: string };
}[CollectionName];

const collectionNameSchema = z.enum(
  Object.keys(collections) as [CollectionName, ...CollectionName[]],
);
const changeSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("put"), collection: collectionNameSchema, record: z.unknown() }),
  z.object({ op: z.literal("delete"), collection: collectionNameSchema, key: z.string() }),
]);
const commitSchema = z.object({
  seq: z.number().int().positive(),
  at: z.string(),
  changes: z.array(changeSchema),
});
// The store's format, in its snapshot. Version 1 held records from before swarms; the migration
// in server/migration.ts converts it once, and the runtime reads only the current version. A
// daemon from before the migration refuses a version 2 snapshot rather than write over it.
export const STORE_VERSION = 2;

// How one version of the store reads its records.
export interface StoreFormat<State> {
  version: number;
  state: z.ZodType<State>;
  record(collection: CollectionName): z.ZodTypeAny;
}

const currentFormat: StoreFormat<SwarmState> = {
  version: STORE_VERSION,
  state: stateSchema,
  record: (collection) => collections[collection].schema,
};

export class StateLoadError extends Error {
  constructor(path: string, detail: string) {
    super(
      `Swarm state at ${path} cannot be read (${detail}). Swarm refuses to write until the file is repaired or moved aside.`,
    );
    this.name = "StateLoadError";
  }
}

export class StoreMigrationPendingError extends Error {
  constructor() {
    super(
      `Swarm state at ${getDataDirectory()} is from an earlier version and has not been migrated. Restart the daemon to migrate it; ${getMigrationReportPath()} says why an earlier attempt stopped.`,
    );
    this.name = "StoreMigrationPendingError";
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readOptional(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function writeAtomic(path: string, text: string): void {
  const temporary = `${path}.${process.pid}.tmp`;
  const fd = openSync(temporary, "w");
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
}

// Which format the files on disk hold. A current store writes its snapshot before its first
// commit, so a log or a state.json with no snapshot is from version 1.
export function storeVersionOnDisk(): number | null {
  const snapshotPath = getSnapshotPath();
  const snapshotText = readOptional(snapshotPath);
  if (snapshotText !== null) {
    let version: unknown;
    try {
      version = (JSON.parse(snapshotText) as { version?: unknown }).version;
    } catch (error) {
      throw new StateLoadError(snapshotPath, describe(error));
    }
    if (version === 1 || version === STORE_VERSION) return version;
    throw new StateLoadError(snapshotPath, `unknown store version ${String(version)}`);
  }
  if (readOptional(getLegacyStatePath()) !== null || readOptional(getEventLogPath())) return 1;
  return null;
}

function keyOf(collection: CollectionName, record: object): string {
  return collections[collection].key(record as { id: string; swarmId?: string });
}

function applyChange(state: object, change: SwarmChange): void {
  const records = (state as Record<CollectionName, object[]>)[change.collection];
  const key = change.op === "put" ? keyOf(change.collection, change.record) : change.key;
  const index = records.findIndex((record) => keyOf(change.collection, record) === key);
  if (change.op === "delete") {
    if (index >= 0) records.splice(index, 1);
  } else if (index >= 0) records[index] = change.record;
  else records.push(change.record);
}

function parseChange<State>(
  format: StoreFormat<State>,
  change: z.infer<typeof changeSchema>,
): SwarmChange {
  if (change.op === "delete") return change;
  const record = format.record(change.collection).parse(change.record);
  return { ...change, record } as SwarmChange;
}

export interface StoreFiles<State> {
  state: State;
  seq: number;
  // Commits replayed from the log on top of the snapshot.
  commits: number;
  // Whether the log ended in an unterminated commit, which was never acknowledged.
  dropped: boolean;
}

// Reads the snapshot and replays the log, in one format. Version 1 could also start from the
// whole-file state.json used before the log. Unreadable files raise StateLoadError instead of
// loading as empty, so a parse failure can never be persisted over the real swarm.
export function readStoreFiles<State extends object>(
  format: StoreFormat<State>,
  empty: () => State,
): StoreFiles<State> {
  const snapshotSchema = z.object({
    version: z.literal(format.version),
    seq: z.number().int().nonnegative(),
    state: format.state,
  });
  const snapshotPath = getSnapshotPath();
  let state = empty();
  let seq = 0;
  const snapshotText = readOptional(snapshotPath);
  if (snapshotText !== null) {
    try {
      ({ state, seq } = snapshotSchema.parse(JSON.parse(snapshotText)) as {
        state: State;
        seq: number;
      });
    } catch (error) {
      throw new StateLoadError(snapshotPath, describe(error));
    }
  } else if (format.version === 1) {
    const legacyPath = getLegacyStatePath();
    const text = readOptional(legacyPath);
    if (text !== null) {
      try {
        state = format.state.parse(JSON.parse(text));
      } catch (error) {
        throw new StateLoadError(legacyPath, describe(error));
      }
    }
  }
  const logPath = getEventLogPath();
  const text = readOptional(logPath);
  let commits = 0;
  if (!text) return { state, seq, commits, dropped: false };
  // A crash during an append leaves at most one unterminated final line. That commit was
  // never acknowledged, so it is dropped; any other unreadable line is corruption.
  const lines = text.split("\n");
  const tail = lines.pop();
  for (const [index, line] of lines.entries()) {
    let commit: z.infer<typeof commitSchema>;
    try {
      commit = commitSchema.parse(JSON.parse(line));
    } catch (error) {
      throw new StateLoadError(logPath, `line ${index + 1}: ${describe(error)}`);
    }
    // Commits already folded into the snapshot survive a crash between the snapshot rename
    // and the log truncation, in whatever format they were written.
    if (commit.seq <= seq) continue;
    if (commit.seq !== seq + 1) {
      throw new StateLoadError(logPath, `line ${index + 1}: expected seq ${seq + 1}`);
    }
    let changes: SwarmChange[];
    try {
      changes = commit.changes.map((change) => parseChange(format, change));
    } catch (error) {
      throw new StateLoadError(logPath, `line ${index + 1}: ${describe(error)}`);
    }
    for (const change of changes) applyChange(state, change);
    seq = commit.seq;
    commits += 1;
  }
  try {
    format.state.parse(state);
  } catch (error) {
    throw new StateLoadError(logPath, describe(error));
  }
  if (tail) console.warn(`[paseo-swarm] Dropped an incomplete final commit from ${logPath}`);
  return { state, seq, commits, dropped: Boolean(tail) };
}

// Replaces the store with a current-format snapshot at seq and an empty log, in that order, so a
// crash between the two leaves a snapshot that skips the old log's commits.
export function writeSnapshot(state: SwarmState, seq: number): void {
  mkdirSync(getDataDirectory(), { recursive: true });
  writeAtomic(getSnapshotPath(), JSON.stringify({ version: STORE_VERSION, seq, state }) + "\n");
  writeFileSync(getEventLogPath(), "");
}

interface Loaded {
  directory: string;
  state: SwarmState;
  seq: number;
  commitsSinceSnapshot: number;
  snapshotted: boolean;
}

// Durable Swarm state: a snapshot plus an append-only log of record-level changes. A commit
// costs one fsynced append however large the board is; the log folds into the snapshot every
// `compactAfter` commits.
export class StateStore {
  private loaded: Loaded | null = null;

  constructor(private readonly compactAfter = 500) {}

  read(): Readonly<SwarmState> {
    return this.load().state;
  }

  // Drops what was read, so the next read loads the files again. The migration calls it after
  // it replaces them.
  forget(): void {
    this.loaded = null;
  }

  // The plan reads the current state and returns the changes to make. It must not mutate the
  // state it is given; throwing from it, or a failed append, leaves state and disk unchanged.
  async commit(plan: (state: Readonly<SwarmState>) => SwarmChange[]): Promise<SwarmState> {
    const loaded = this.load();
    const changes = plan(loaded.state).map((change) =>
      parseChange(currentFormat, changeSchema.parse(change)),
    );
    if (changes.length === 0) return loaded.state;
    // Records are replaced, never mutated, so copying the touched arrays is enough.
    const next: SwarmState = { ...loaded.state };
    for (const name of new Set(changes.map((change) => change.collection))) {
      (next as Record<CollectionName, unknown[]>)[name] = [...loaded.state[name]];
    }
    for (const change of changes) applyChange(next, change);
    stateSchema.parse(next);
    // The snapshot marks the store's format, so a new store writes one before its first commit.
    if (!loaded.snapshotted) this.compact(loaded);
    const seq = loaded.seq + 1;
    this.append(loaded.directory, { seq, at: new Date().toISOString(), changes });
    loaded.state = next;
    loaded.seq = seq;
    loaded.commitsSinceSnapshot += 1;
    if (loaded.commitsSinceSnapshot >= this.compactAfter) this.compact(loaded);
    return next;
  }

  private load(): Loaded {
    const directory = getDataDirectory();
    if (this.loaded?.directory === directory) return this.loaded;
    this.loaded = null;
    const version = storeVersionOnDisk();
    if (version === 1) throw new StoreMigrationPendingError();
    const files = readStoreFiles(currentFormat, emptyState);
    const loaded = {
      directory,
      state: files.state,
      seq: files.seq,
      commitsSinceSnapshot: files.commits,
      snapshotted: version !== null,
    };
    // Folding on load keeps startup replay short and clears a dropped tail before the next append.
    if (files.commits > 0 || files.dropped) this.compact(loaded);
    this.loaded = loaded;
    return loaded;
  }

  private append(directory: string, commit: z.infer<typeof commitSchema>): void {
    mkdirSync(directory, { recursive: true });
    const fd = openSync(getEventLogPath(), "a");
    const size = fstatSync(fd).size;
    try {
      writeSync(fd, JSON.stringify(commit) + "\n");
      fsyncSync(fd);
    } catch (error) {
      try {
        ftruncateSync(fd, size);
      } catch {
        // The partial line stays; the next load drops it or reports corruption.
        this.loaded = null;
      }
      throw error;
    } finally {
      closeSync(fd);
    }
  }

  private compact(loaded: Loaded): void {
    writeSnapshot(loaded.state, loaded.seq);
    loaded.commitsSinceSnapshot = 0;
    loaded.snapshotted = true;
  }
}

export const store = new StateStore();

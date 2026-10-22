import {
  closeSync,
  existsSync,
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
  stateSchema,
  taskSchema,
  type SwarmState,
} from "../shared/models";

function getDataDirectory(): string {
  const home = process.env.PASEO_HOME ?? process.env.PASEO_DATA_DIR ?? process.cwd();
  return join(home, "plugin-data", "paseo-swarm");
}

// Whole-file store used before the event log. Imported once into a snapshot, then renamed.
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

// Each collection is keyed by its records' own id. A new collection is one entry here plus its
// array in stateSchema. Agents are keyed by the roster id, not paseoAgentId, so the Paseo agent
// behind a roster member can change without changing its identity.
const collections = {
  agents: { schema: agentRecordSchema, key: "id" },
  tasks: { schema: taskSchema, key: "id" },
  activities: { schema: activitySchema, key: "id" },
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
const snapshotSchema = z.object({
  version: z.literal(1),
  seq: z.number().int().nonnegative(),
  state: stateSchema,
});

export class StateLoadError extends Error {
  constructor(path: string, detail: string) {
    super(
      `Swarm state at ${path} cannot be read (${detail}). Swarm refuses to write until the file is repaired or moved aside.`,
    );
    this.name = "StateLoadError";
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

function keyOf(collection: CollectionName, record: object): string {
  return String((record as Record<string, unknown>)[collections[collection].key]);
}

function applyChange(state: SwarmState, change: SwarmChange): void {
  const records = state[change.collection] as object[];
  const key = change.op === "put" ? keyOf(change.collection, change.record) : change.key;
  const index = records.findIndex((record) => keyOf(change.collection, record) === key);
  if (change.op === "delete") {
    if (index >= 0) records.splice(index, 1);
  } else if (index >= 0) records[index] = change.record;
  else records.push(change.record);
}

function parseChange(change: z.infer<typeof changeSchema>): SwarmChange {
  if (change.op === "delete") return change;
  const record = collections[change.collection].schema.parse(change.record);
  return { ...change, record } as SwarmChange;
}

interface Loaded {
  directory: string;
  state: SwarmState;
  seq: number;
  commitsSinceSnapshot: number;
}

// Durable Swarm state: a snapshot plus an append-only log of record-level changes. A commit
// costs one fsynced append however large the board is; the log folds into the snapshot every
// `compactAfter` commits. Unreadable files raise StateLoadError instead of loading as empty,
// so a parse failure can never be persisted over the real swarm.
export class StateStore {
  private loaded: Loaded | null = null;

  constructor(private readonly compactAfter = 500) {}

  read(): Readonly<SwarmState> {
    return this.load().state;
  }

  // The plan reads the current state and returns the changes to make. It must not mutate the
  // state it is given; throwing from it, or a failed append, leaves state and disk unchanged.
  async commit(plan: (state: Readonly<SwarmState>) => SwarmChange[]): Promise<SwarmState> {
    const loaded = this.load();
    const changes = plan(loaded.state).map((change) => parseChange(changeSchema.parse(change)));
    if (changes.length === 0) return loaded.state;
    // Records are replaced, never mutated, so copying the touched arrays is enough.
    const next: SwarmState = { ...loaded.state };
    for (const name of new Set(changes.map((change) => change.collection))) {
      (next as Record<CollectionName, unknown[]>)[name] = [...loaded.state[name]];
    }
    for (const change of changes) applyChange(next, change);
    stateSchema.parse(next);
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
    const snapshotPath = getSnapshotPath();
    let state = emptyState();
    let seq = 0;
    let imported = false;
    const snapshotText = readOptional(snapshotPath);
    if (snapshotText !== null) {
      try {
        ({ state, seq } = snapshotSchema.parse(JSON.parse(snapshotText)));
      } catch (error) {
        throw new StateLoadError(snapshotPath, describe(error));
      }
    } else {
      const legacy = this.importLegacy();
      if (legacy) {
        state = legacy;
        imported = true;
      }
    }
    const replayed = this.replay(state, seq);
    const loaded = { directory, state, seq: replayed.seq, commitsSinceSnapshot: replayed.commits };
    // Folding on load keeps startup replay short and clears a dropped tail before the next append.
    if (imported || replayed.commits > 0 || replayed.dropped) this.compact(loaded);
    this.loaded = loaded;
    return loaded;
  }

  private importLegacy(): SwarmState | null {
    const legacyPath = getLegacyStatePath();
    const text = readOptional(legacyPath);
    if (text === null) return null;
    try {
      return stateSchema.parse(JSON.parse(text));
    } catch (error) {
      throw new StateLoadError(legacyPath, describe(error));
    }
  }

  private replay(
    state: SwarmState,
    snapshotSeq: number,
  ): { seq: number; commits: number; dropped: boolean } {
    const logPath = getEventLogPath();
    const text = readOptional(logPath);
    let seq = snapshotSeq;
    let commits = 0;
    if (!text) return { seq, commits, dropped: false };
    // A crash during an append leaves at most one unterminated final line. That commit was
    // never acknowledged, so it is dropped; any other unreadable line is corruption.
    const lines = text.split("\n");
    const tail = lines.pop();
    for (const [index, line] of lines.entries()) {
      let commit: z.infer<typeof commitSchema>;
      let changes: SwarmChange[];
      try {
        commit = commitSchema.parse(JSON.parse(line));
        changes = commit.changes.map(parseChange);
      } catch (error) {
        throw new StateLoadError(logPath, `line ${index + 1}: ${describe(error)}`);
      }
      // Commits already folded into the snapshot survive a crash between the snapshot rename
      // and the log truncation.
      if (commit.seq <= seq) continue;
      if (commit.seq !== seq + 1) {
        throw new StateLoadError(logPath, `line ${index + 1}: expected seq ${seq + 1}`);
      }
      for (const change of changes) applyChange(state, change);
      seq = commit.seq;
      commits += 1;
    }
    try {
      stateSchema.parse(state);
    } catch (error) {
      throw new StateLoadError(logPath, describe(error));
    }
    if (tail) console.warn(`[paseo-swarm] Dropped an incomplete final commit from ${logPath}`);
    return { seq, commits, dropped: Boolean(tail) };
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
    mkdirSync(loaded.directory, { recursive: true });
    writeAtomic(
      getSnapshotPath(),
      JSON.stringify({ version: 1, seq: loaded.seq, state: loaded.state }) + "\n",
    );
    const legacyPath = getLegacyStatePath();
    if (existsSync(legacyPath)) renameSync(legacyPath, `${legacyPath}.imported`);
    writeFileSync(getEventLogPath(), "");
    loaded.commitsSinceSnapshot = 0;
  }
}

export const store = new StateStore();

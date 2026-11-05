import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join, sep } from "node:path";
import type { z } from "zod";
import {
  agentQualifiedName,
  type Artifact,
  type DeliveredArtifact,
  type SwarmRecord,
  type SwarmState,
} from "../shared/models";
import { formatSwarmUri, type ActivityRef } from "../shared/refs";
import type { artifactViewSchema, deliveredArtifactViewSchema } from "../shared/swarm";
import { store } from "./state";
import { findAgent, findSwarm, swarmOfSeatName } from "./swarms";

// Artifacts: results an author maintains and readers return to. The author writes the file in its
// own workspace, which is often a worktree that Paseo removes once the work merges. So Swarm keeps
// a copy of the file and the attachments it needs in the swarm's directory, under artifacts/<id>/,
// and refreshes it when the author publishes, delivers, and ends a turn. Readers always open the
// copy: it is the result as of the author's last turn, and it stays after the worktree is gone.
// History is not kept; the copy is the current result.

export const ARTIFACTS_DIRECTORY = "artifacts";
// What one artifact may copy. A result needs its document and the few files it can't be used
// without; a build tree or a dataset dump belongs somewhere else.
const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024;
const MAX_ARTIFACT_FILES = 1000;

type ArtifactView = z.input<typeof artifactViewSchema>;
type DeliveredArtifactView = z.input<typeof deliveredArtifactViewSchema>;

const now = () => new Date().toISOString();

function refusal(refused: string, rule: string, instead: string): Error {
  return new Error(`${refused}: ${rule}. ${instead}`);
}

function artifactKey(swarmId: string, id: string): string {
  return `${swarmId}/${id}`;
}

export function artifactsDirectory(swarm: Pick<SwarmRecord, "directory">): string {
  return join(swarm.directory, ARTIFACTS_DIRECTORY);
}

// A path relative to the workspace, with forward slashes. Null for an absolute path or one that
// leaves the workspace.
export function workspacePath(path: string): string | null {
  const slashed = path.trim().replace(/\\/g, "/");
  if (slashed.startsWith("/") || /^[a-z]:/i.test(slashed)) return null;
  const parts = slashed.split("/").filter((part) => part && part !== ".");
  if (parts.length === 0 || parts.includes("..")) return null;
  return parts.join("/");
}

interface SourceFile {
  path: string;
  absolute: string;
  size: number;
}

interface Collected {
  files: SourceFile[];
  hash: string;
}

function inside(root: string, path: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

// The files an artifact copies: its document, and each attachment, a directory taken whole. A
// symlink that leads out of the workspace is refused, as is anything past the size limits.
function collect(root: string, artifact: Pick<Artifact, "source">): Collected {
  const realRoot = realpathSync(root);
  const files = new Map<string, SourceFile>();
  let bytes = 0;
  const add = (path: string, absolute: string, size: number) => {
    if (files.has(path)) return;
    bytes += size;
    if (files.size + 1 > MAX_ARTIFACT_FILES || bytes > MAX_ARTIFACT_BYTES) {
      throw new Error(
        `it copies more than ${MAX_ARTIFACT_FILES} files or ${MAX_ARTIFACT_BYTES / 1024 / 1024} MB; attach only the files a reader needs`,
      );
    }
    files.set(path, { path, absolute, size });
  };
  const visit = (path: string, required: boolean) => {
    const absolute = join(realRoot, path);
    if (!existsSync(absolute)) {
      if (required) throw new Error(`${path} does not exist in the workspace`);
      return;
    }
    const real = realpathSync(absolute);
    if (!inside(realRoot, real)) throw new Error(`${path} leads outside the workspace`);
    const stat = statSync(real);
    if (stat.isFile()) {
      add(path, real, stat.size);
      return;
    }
    if (!stat.isDirectory()) throw new Error(`${path} is not a file or a directory`);
    for (const entry of readdirSync(real).sort()) {
      if (entry === ".git") continue;
      visit(`${path}/${entry}`, false);
    }
  };
  const principal = join(realRoot, artifact.source.path);
  if (!existsSync(principal) || !statSync(principal).isFile()) {
    throw new Error(`${artifact.source.path} is not a file in the workspace`);
  }
  visit(artifact.source.path, true);
  for (const attachment of artifact.source.attachments) visit(attachment, true);
  const sorted = [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
  const hash = createHash("sha256");
  for (const file of sorted) {
    hash.update(`${file.path}\0${file.size}\0`);
    hash.update(readFileSync(file.absolute));
  }
  return { files: sorted, hash: hash.digest("hex") };
}

// A copy is read-only on disk, so no reader or agent writes to a file the next copy replaces.
// Directories are made writable again before Swarm replaces them.
function setCopyMode(path: string, writable: boolean): void {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return;
  if (!stat.isDirectory()) {
    if (!writable) chmodSync(path, 0o444);
    return;
  }
  if (writable) chmodSync(path, 0o755);
  for (const entry of readdirSync(path)) setCopyMode(join(path, entry), writable);
  if (!writable) chmodSync(path, 0o555);
}

// Replaces the artifact's copy whole, so a file the author removed leaves the copy too.
function writeCopy(swarm: SwarmRecord, id: string, collected: Collected): void {
  const directory = artifactsDirectory(swarm);
  mkdirSync(directory, { recursive: true });
  const staging = join(directory, `.${id}.${process.pid}.tmp`);
  setCopyMode(staging, true);
  rmSync(staging, { recursive: true, force: true });
  for (const file of collected.files) {
    const target = join(staging, file.path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(file.absolute, target);
  }
  const destination = join(directory, id);
  setCopyMode(destination, true);
  rmSync(destination, { recursive: true, force: true });
  renameSync(staging, destination);
  setCopyMode(destination, false);
}

// The directory of a live workspace, or null once Paseo archived it or its directory is gone.
async function workspaceDirectory(
  workspaceId: string,
  context: PluginHandlerContext,
): Promise<string | null> {
  const workspace = await context.paseo.workspaces
    .ref(workspaceId)
    .refresh()
    .catch(() => null);
  const directory = workspace?.workspaceDirectory;
  return directory && existsSync(directory) ? directory : null;
}

// The workspace that shows the swarm's artifacts directory, so readers open copies in the file
// pane like any file. It is made at the first publish, and again if the person archived it.
const ensuring = new Map<string, Promise<string>>();

async function ensureArtifactsWorkspace(
  swarm: SwarmRecord,
  context: PluginHandlerContext,
): Promise<string> {
  const pending = ensuring.get(swarm.id);
  if (pending) return pending;
  const ensured = createArtifactsWorkspace(swarm, context).finally(() => ensuring.delete(swarm.id));
  ensuring.set(swarm.id, ensured);
  return ensured;
}

async function createArtifactsWorkspace(
  swarm: SwarmRecord,
  context: PluginHandlerContext,
): Promise<string> {
  const directory = artifactsDirectory(swarm);
  mkdirSync(directory, { recursive: true });
  if (swarm.artifactsWorkspaceId) {
    const current = await workspaceDirectory(swarm.artifactsWorkspaceId, context);
    if (current && realpathSync(current) === realpathSync(directory)) {
      return swarm.artifactsWorkspaceId;
    }
  }
  if (!swarm.projectId) {
    throw refusal(
      `Swarm ${swarm.name} cannot keep artifacts`,
      "artifacts are shown in a workspace of the swarm's project, and this swarm has no project",
      "Deliver the result as text instead.",
    );
  }
  const workspace = await context.paseo.workspaces.create({
    source: { kind: "directory", path: directory, projectId: swarm.projectId },
    title: `${swarm.name} artifacts`,
  });
  await store.commit((state) => {
    const current = state.swarms.find((candidate) => candidate.id === swarm.id);
    if (!current) throw new Error(`Unknown swarm: ${swarm.id}`);
    return [
      {
        op: "put",
        collection: "swarms",
        record: { ...current, artifactsWorkspaceId: workspace.id, updatedAt: now() },
      },
    ];
  });
  return workspace.id;
}

// Where readers open the artifact, or null before the swarm has an artifacts workspace.
export function artifactLocation(state: Readonly<SwarmState>, artifact: Artifact) {
  const swarm = state.swarms.find((candidate) => candidate.id === artifact.swarmId);
  if (!swarm?.artifactsWorkspaceId) return null;
  const path = `${artifact.id}/${artifact.source.path}`;
  return {
    workspaceId: swarm.artifactsWorkspaceId,
    path,
    link: formatSwarmUri({ kind: "file", workspaceId: swarm.artifactsWorkspaceId, path }),
  };
}

export function artifactView(state: Readonly<SwarmState>, artifact: Artifact): ArtifactView {
  const task = artifact.taskId
    ? state.tasks.find(
        (candidate) => candidate.swarmId === artifact.swarmId && candidate.id === artifact.taskId,
      )
    : undefined;
  const deliveries = state.activities.flatMap((activity) => {
    if (activity.swarmId !== artifact.swarmId) return [];
    const carried = activity.artifacts?.find((entry) => entry.id === artifact.id);
    if (!carried) return [];
    return [
      {
        activityId: activity.id,
        taskId: activity.taskId,
        actorName: activity.actorName,
        audience: activity.audience ?? [],
        changed: carried.contentHash !== artifact.contentHash,
        createdAt: activity.createdAt,
      },
    ];
  });
  return {
    ...artifact,
    location: artifactLocation(state, artifact),
    taskTitle: task?.title ?? null,
    deliveries,
  };
}

// A swarm's artifacts, most recently changed first.
export function artifactsView(state: Readonly<SwarmState>, swarmIds: ReadonlySet<string>) {
  return {
    artifacts: state.artifacts
      .filter((artifact) => swarmIds.has(artifact.swarmId))
      .sort((a, b) => b.changedAt.localeCompare(a.changedAt))
      .map((artifact) => artifactView(state, artifact)),
  };
}

// What a delivery carried, as its reader opens it now.
export function deliveredArtifactViews(
  state: Readonly<SwarmState>,
  swarmId: string,
  carried: readonly DeliveredArtifact[] | undefined,
): DeliveredArtifactView[] | undefined {
  if (!carried?.length) return undefined;
  return carried.flatMap((entry) => {
    const artifact = state.artifacts.find(
      (candidate) => candidate.swarmId === swarmId && candidate.id === entry.id,
    );
    if (!artifact) return [];
    return [
      {
        id: artifact.id,
        title: artifact.title,
        location: artifactLocation(state, artifact),
        changed: entry.contentHash !== artifact.contentHash,
      },
    ];
  });
}

export function findArtifact(state: Readonly<SwarmState>, swarmId: string, id: string): Artifact {
  const artifact = state.artifacts.find(
    (candidate) => candidate.swarmId === swarmId && candidate.id === id,
  );
  if (!artifact) throw new Error(`Unknown artifact: ${id}`);
  return artifact;
}

// The artifacts a body links: a link to an artifact's copy, or to the file its author maintains.
export function linkedArtifacts(
  state: Readonly<SwarmState>,
  swarmId: string,
  refs: readonly ActivityRef[],
): Artifact[] {
  const swarm = state.swarms.find((candidate) => candidate.id === swarmId);
  const linked = new Map<string, Artifact>();
  for (const ref of refs) {
    if (ref.kind !== "file") continue;
    for (const artifact of state.artifacts) {
      if (artifact.swarmId !== swarmId || linked.has(artifact.id)) continue;
      const copy =
        ref.workspaceId === swarm?.artifactsWorkspaceId && ref.path.startsWith(`${artifact.id}/`);
      const source =
        ref.workspaceId === artifact.source.workspaceId && ref.path === artifact.source.path;
      if (copy || source) linked.set(artifact.id, artifact);
    }
  }
  return [...linked.values()];
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48)
      .replace(/-+$/g, "") || "artifact"
  );
}

function newArtifactId(state: Readonly<SwarmState>, swarmId: string, title: string): string {
  const base = slug(title);
  const taken = new Set(
    state.artifacts.filter((artifact) => artifact.swarmId === swarmId).map((a) => a.id),
  );
  if (!taken.has(base)) return base;
  let suffix = 2;
  while (taken.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

// One copy at a time per artifact, so a delivery and a turn end never write the same staging
// directory.
const syncing = new Map<string, Promise<void>>();

function serialized(key: string, run: () => Promise<Artifact>): Promise<Artifact> {
  const next = (syncing.get(key) ?? Promise.resolve()).then(run);
  // The chain the next copy waits on never rejects; the caller gets this copy's failure.
  const tail = next.then(
    () => undefined,
    () => undefined,
  );
  syncing.set(key, tail);
  void tail.finally(() => {
    if (syncing.get(key) === tail) syncing.delete(key);
  });
  return next;
}

export interface PublishInput {
  swarmId?: string;
  actorName: string;
  artifactId?: string;
  path: string;
  title: string;
  attachments: string[];
  taskId?: string | null;
}

export async function publishArtifact(
  input: PublishInput,
  context: PluginHandlerContext,
): Promise<{ artifact: ArtifactView; created: boolean }> {
  const swarm = input.swarmId ? findSwarm(input.swarmId) : swarmOfSeatName(input.actorName);
  const actor = findAgent(swarm.id, input.actorName);
  const authorName = agentQualifiedName(actor);
  const refused = `${authorName} cannot publish ${input.path}`;
  if (!actor.workspaceId) {
    throw refusal(refused, "your seat has no workspace yet", "Publish after your first turn.");
  }
  const path = workspacePath(input.path);
  if (!path) {
    throw refusal(
      refused,
      "path is relative to your workspace and stays inside it",
      "Pass the file's path from your workspace root.",
    );
  }
  const attachments: string[] = [];
  for (const attachment of input.attachments) {
    const normalized = workspacePath(attachment);
    if (!normalized) {
      throw refusal(
        refused,
        `attachment ${attachment} is not a path inside your workspace`,
        "Pass each attachment's path from your workspace root.",
      );
    }
    if (normalized !== path && !attachments.includes(normalized)) attachments.push(normalized);
  }
  const state = store.read();
  if (input.taskId && !state.tasks.some((t) => t.swarmId === swarm.id && t.id === input.taskId)) {
    throw new Error(`Unknown Task: ${input.taskId}`);
  }
  const existing = input.artifactId
    ? findArtifact(state, swarm.id, input.artifactId)
    : state.artifacts.find(
        (artifact) =>
          artifact.swarmId === swarm.id &&
          artifact.authorName === authorName &&
          artifact.source.workspaceId === actor.workspaceId &&
          artifact.source.path === path,
      );
  if (existing && existing.authorName !== authorName) {
    throw refusal(
      refused,
      `artifact ${existing.id} is maintained by ${existing.authorName}`,
      `Message ${existing.authorName} with the change, or publish your own artifact.`,
    );
  }
  const root = await workspaceDirectory(actor.workspaceId, context);
  if (!root) {
    throw refusal(
      refused,
      `your workspace ${actor.workspaceId} is not available`,
      "Publish from the workspace you work in now.",
    );
  }
  const id = existing?.id ?? newArtifactId(state, swarm.id, input.title);
  const source = { workspaceId: actor.workspaceId, path, attachments };
  return serialized(artifactKey(swarm.id, id), async () => {
    let collected: Collected;
    try {
      collected = collect(root, { source });
    } catch (error) {
      throw refusal(
        refused,
        error instanceof Error ? error.message : String(error),
        "Check the path and attachments, then publish again.",
      );
    }
    await ensureArtifactsWorkspace(findSwarm(swarm.id), context);
    writeCopy(findSwarm(swarm.id), id, collected);
    const timestamp = now();
    let artifact!: Artifact;
    await store.commit((current) => {
      const before = current.artifacts.find((a) => a.swarmId === swarm.id && a.id === id);
      const taskId = input.taskId === undefined ? before?.taskId : (input.taskId ?? undefined);
      artifact = {
        id,
        swarmId: swarm.id,
        title: input.title.trim(),
        authorName,
        ...(taskId ? { taskId } : {}),
        source,
        contentHash: collected.hash,
        changedAt: before && before.contentHash === collected.hash ? before.changedAt : timestamp,
        publishedAt: before?.publishedAt ?? timestamp,
        updatedAt: timestamp,
      };
      return [{ op: "put", collection: "artifacts", record: artifact }];
    });
    return artifact;
  }).then((artifact) => ({ artifact: artifactView(store.read(), artifact), created: !existing }));
}

// Refreshes the copy from the author's workspace when the content changed. A source that is gone,
// with its worktree or by its author's hand, leaves the copy as it last was.
export function syncArtifact(artifact: Artifact, context: PluginHandlerContext): Promise<Artifact> {
  return serialized(artifactKey(artifact.swarmId, artifact.id), async () => {
    const current = findArtifact(store.read(), artifact.swarmId, artifact.id);
    const root = await workspaceDirectory(current.source.workspaceId, context);
    if (!root) return current;
    let collected: Collected;
    try {
      collected = collect(root, current);
    } catch (error) {
      console.warn(`[paseo-swarm] Artifact ${current.id} keeps its last copy`, error);
      return current;
    }
    const swarm = findSwarm(current.swarmId);
    const copied = existsSync(join(artifactsDirectory(swarm), current.id, current.source.path));
    if (collected.hash === current.contentHash && copied) return current;
    await ensureArtifactsWorkspace(swarm, context);
    writeCopy(findSwarm(current.swarmId), current.id, collected);
    const timestamp = now();
    let next!: Artifact;
    await store.commit((state) => {
      const latest = findArtifact(state, current.swarmId, current.id);
      next = {
        ...latest,
        contentHash: collected.hash,
        changedAt: collected.hash === latest.contentHash ? latest.changedAt : timestamp,
        updatedAt: timestamp,
      };
      return [{ op: "put", collection: "artifacts", record: next }];
    });
    return next;
  });
}

// At the end of an author's turn, its artifacts are copied again if they changed.
export async function syncAuthoredArtifacts(
  paseoAgentId: string,
  context: PluginHandlerContext,
): Promise<void> {
  const state = store.read();
  const seat = state.agents.find((candidate) => candidate.paseoAgentId === paseoAgentId);
  if (!seat) return;
  const name = agentQualifiedName(seat);
  const authored = state.artifacts.filter(
    (artifact) => artifact.swarmId === seat.swarmId && artifact.authorName === name,
  );
  for (const artifact of authored) {
    try {
      await syncArtifact(artifact, context);
    } catch (error) {
      console.warn(`[paseo-swarm] Could not copy artifact ${artifact.id}`, error);
    }
  }
}

// The artifacts a delivery links, copied first so the hash it records is what its readers get.
export async function carriedArtifacts(
  swarmId: string,
  refs: readonly ActivityRef[],
  context: PluginHandlerContext,
): Promise<DeliveredArtifact[]> {
  const carried: DeliveredArtifact[] = [];
  for (const artifact of linkedArtifacts(store.read(), swarmId, refs)) {
    const synced = await syncArtifact(artifact, context);
    carried.push({ id: synced.id, contentHash: synced.contentHash });
  }
  return carried;
}

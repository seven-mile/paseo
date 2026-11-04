import { createHash } from "node:crypto";
import type { z } from "zod";
import {
  DELIVERED_WINDOW_MS,
  SWARM_FEATURES,
  TASK_HISTORY_PAGE,
  type seatDeliverySchema,
  type seatSummarySchema,
  type taskSummarySchema,
} from "../shared/swarm";
import {
  agentQualifiedName,
  HUMAN,
  unansweredChoices,
  type Activity,
  type AgentRecord,
  type SwarmRecord,
  type SwarmState,
  type Task,
} from "../shared/models";
import { listPwaRoles, readPwa } from "./pwa";
import { seatView } from "./seats";
import { store } from "./state";

type SeatSummary = z.input<typeof seatSummarySchema>;
type TaskSummary = z.input<typeof taskSummarySchema>;
type SeatDelivery = z.input<typeof seatDeliverySchema>;

// A conditional read's answer: data is null when the caller already holds this etag.
export interface Conditional<T> {
  etag: string;
  data: T | null;
}

interface CachedView {
  revision: string;
  etag: string;
  value: unknown;
}

// Views are pure functions of the store, so one built at a store revision stands until the next
// commit. Polling clients that hold the current etag cost a map lookup, not a rebuild.
const MAX_CACHED_VIEWS = 128;
const cache = new Map<string, CachedView>();

function digestOf(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("base64url");
}

// A conditional answer built fresh on every read, for a view that also depends on state outside
// the store, such as the agent a seat is bringing in before it commits the binding.
export function conditionalValue<T>(value: T, etag: string | undefined): Conditional<T> {
  const digest = digestOf(value);
  return { etag: digest, data: etag === digest ? null : value };
}

export function conditionalView<T>(
  key: string,
  etag: string | undefined,
  build: (state: Readonly<SwarmState>) => T,
): Conditional<T> {
  const revision = store.revision();
  let view = cache.get(key);
  if (!view || view.revision !== revision) {
    const value = build(store.read());
    // The etag hashes the content, not the revision: commits that leave this view unchanged, such
    // as mailbox deliveries, keep its etag, so clients that hold it are not sent it again.
    view = { revision, etag: digestOf(value), value };
  }
  // Refreshing the entry's position keeps the views in use; the least recently read go first.
  cache.delete(key);
  cache.set(key, view);
  if (cache.size > MAX_CACHED_VIEWS) cache.delete(cache.keys().next().value!);
  if (etag === view.etag) return { etag: view.etag, data: null };
  return { etag: view.etag, data: view.value as T };
}

export function seatSummary(seat: SwarmState["agents"][number]): SeatSummary {
  const view = seatView(seat);
  return {
    id: view.id,
    swarmId: view.swarmId,
    paseoAgentId: view.paseoAgentId,
    name: view.name,
    ...(view.qualifiedName ? { qualifiedName: view.qualifiedName } : {}),
    aliases: view.aliases,
    roleClass: view.roleClass,
    role: view.role,
    reportsTo: view.reportsTo,
    workspaceId: view.workspaceId,
    retired: view.retired,
    pending: view.pending,
  };
}

function swarmRef(swarm: SwarmRecord) {
  return { id: swarm.id, name: swarm.name, projectId: swarm.projectId };
}

// How many deliveries to the human a seat's conversation lists.
const SEAT_DELIVERIES = 5;

export function seatReadView(state: Readonly<SwarmState>, seatId: string) {
  const seat = state.agents.find((candidate) => candidate.id === seatId);
  if (!seat) return { seat: null, deliveries: [] };
  return { seat: seatView(seat), deliveries: seatDeliveries(state, seat) };
}

// The newest deliveries the seat addressed to the human, so its conversation shows results the
// seat did not repeat in its own words.
function seatDeliveries(state: Readonly<SwarmState>, seat: AgentRecord): SeatDelivery[] {
  const name = agentQualifiedName(seat);
  const deliveries: SeatDelivery[] = [];
  for (let index = state.activities.length - 1; index >= 0; index -= 1) {
    if (deliveries.length === SEAT_DELIVERIES) break;
    const activity = state.activities[index];
    if (activity.swarmId !== seat.swarmId || activity.kind !== "delivery") continue;
    if (activity.actorName !== name) continue;
    const human = activity.audience?.find((entry) => entry.name === HUMAN);
    if (!human) continue;
    const task = state.tasks.find(
      (candidate) => candidate.swarmId === activity.swarmId && candidate.id === activity.taskId,
    );
    deliveries.push({
      activityId: activity.id,
      swarmId: activity.swarmId,
      taskId: activity.taskId,
      taskTitle: task?.title ?? activity.taskId,
      as: human.as,
      ...(typeof activity.data.taskState === "string"
        ? { taskState: activity.data.taskState }
        : {}),
      body: activity.body,
      createdAt: activity.createdAt,
    });
  }
  return deliveries;
}

export function rosterView(state: Readonly<SwarmState>) {
  return {
    agents: state.agents.filter((seat) => !seat.retired).map(seatSummary),
    swarms: state.swarms.map(swarmRef),
    features: SWARM_FEATURES,
  };
}

export interface TasksViewScope {
  projectId?: string;
  swarmId?: string;
  view?: "current" | "history";
  query?: string;
  limit?: number;
  now?: number;
}

// Whether a Task belongs on the current board: open, done within the Delivered window, or with a
// choice still waiting for a human, since an outstanding human action never ages out.
function onCurrentBoard(task: TaskSummary, now: number): boolean {
  if (!task.resolution || task.attention > 0) return true;
  if (task.resolution !== "done" || !task.resolvedAt) return false;
  return now - Date.parse(task.resolvedAt) < DELIVERED_WINDOW_MS;
}

function matches(task: TaskSummary, query: string | undefined): boolean {
  const text = query?.trim().toLowerCase();
  if (!text) return true;
  return `${task.id} ${task.title} ${task.managerName}`.toLowerCase().includes(text);
}

// The Tasks a view shows. History is newest closed first and paged, so the polled current view
// stays small however long the swarm runs.
function viewTasks(tasks: TaskSummary[], scope: TasksViewScope): TaskSummary[] {
  if (!scope.view) return tasks;
  const now = scope.now ?? Date.now();
  if (scope.view === "current") return tasks.filter((task) => onCurrentBoard(task, now));
  return tasks
    .filter((task) => !onCurrentBoard(task, now) && matches(task, scope.query))
    .sort((left, right) => (right.resolvedAt ?? "").localeCompare(left.resolvedAt ?? ""))
    .slice(0, scope.limit ?? TASK_HISTORY_PAGE);
}

export function tasksView(state: Readonly<SwarmState>, scope: TasksViewScope) {
  const swarms = state.swarms.filter(
    (swarm) =>
      (!scope.swarmId || swarm.id === scope.swarmId) &&
      (!scope.projectId || swarm.projectId === scope.projectId),
  );
  const inScope = new Set(swarms.map((swarm) => swarm.id));
  const activities = new Map<string, Activity[]>();
  for (const activity of state.activities) {
    if (!inScope.has(activity.swarmId)) continue;
    const key = `${activity.swarmId}/${activity.taskId}`;
    const list = activities.get(key);
    if (list) list.push(activity);
    else activities.set(key, [activity]);
  }
  const tasks: TaskSummary[] = state.tasks
    .filter((task) => inScope.has(task.swarmId))
    .map((task) => ({
      id: task.id,
      swarmId: task.swarmId,
      title: task.title,
      status: task.status,
      managerName: task.managerName,
      workerNames: task.workerNames,
      createdBy: task.createdBy,
      updatedAt: task.updatedAt,
      // Undefined while the Task is open, so the list's JSON leaves them out.
      resolution: task.resolution,
      resolvedAt: task.resolvedAt,
      resolvedBy: task.resolvedBy,
      duplicateOf: task.duplicateOf,
      supersededBy: task.supersededBy,
      attention: unansweredChoices(activities.get(`${task.swarmId}/${task.id}`) ?? []).length,
    }));
  return {
    // Retired seats stay: a Task can still name one as its manager or a worker.
    agents: state.agents.filter((seat) => inScope.has(seat.swarmId)).map(seatSummary),
    tasks: viewTasks(tasks, scope),
    statuses: swarms.length === 1 ? plannerStatuses(swarms[0]) : [],
    swarms: swarms.map(swarmRef),
    features: SWARM_FEATURES,
  };
}

function plannerStatuses(swarm: SwarmRecord): string[] {
  const { files } = swarm.source;
  const planner = listPwaRoles(files).find((role) => role.roleClass === "planner");
  return planner ? readPwa(files, planner.role).statuses : [];
}

export function taskView(
  state: Readonly<SwarmState>,
  input: { swarmId: string; taskId: string; limit: number },
): {
  task: Task;
  activities: Activity[];
  olderCount: number;
  absorbed: { id: string; title: string; resolution: string }[];
} {
  const task = state.tasks.find(
    (candidate) => candidate.swarmId === input.swarmId && candidate.id === input.taskId,
  );
  if (!task) throw new Error(`Unknown Task: ${input.taskId}`);
  const all = state.activities.filter(
    (activity) => activity.swarmId === input.swarmId && activity.taskId === input.taskId,
  );
  const start = Math.max(0, all.length - input.limit);
  const older = all.slice(0, start);
  // The Task's result, its newest delivery, stays readable however much history follows it.
  const result = all.findLast((activity) => activity.kind === "delivery");
  const open = new Set(unansweredChoices(all).map((activity) => activity.id));
  if (result) open.add(result.id);
  const kept = older.filter((activity) => open.has(activity.id));
  const absorbed = state.tasks
    .filter(
      (candidate) =>
        candidate.swarmId === task.swarmId &&
        (candidate.duplicateOf === task.id || candidate.supersededBy === task.id),
    )
    .map((candidate) => ({
      id: candidate.id,
      title: candidate.title,
      resolution: candidate.resolution ?? "",
    }));
  return {
    task,
    activities: [...kept, ...all.slice(start)],
    olderCount: older.length - kept.length,
    absorbed,
  };
}

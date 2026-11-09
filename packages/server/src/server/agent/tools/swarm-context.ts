import type { AgentLifecycleStatus } from "@getpaseo/protocol/agent-lifecycle";

// The Swarm data agent tools read, as the paseo-swarm plugin returns it, and the views the tools
// build from it. Tools name seats, never the Paseo agents in them.

// The label paseo-swarm puts on every agent it starts for a seat (plugins/paseo-swarm/server/seats.ts).
export const SWARM_SEAT_LABEL = "paseo-swarm.seat";

export interface SwarmSeat {
  id: string;
  // Absent only for a seat the plugin has not yet given a swarm; the plugin then finds it by name.
  swarmId?: string;
  // Null for a reserved seat, whose first message starts its agent.
  paseoAgentId: string | null;
  name: string;
  qualifiedName?: string;
  roleClass: "planner" | "supervisor" | "worker";
  role: string;
  reportsTo: string | null;
  workspaceId: string | null;
  projectId?: string;
  retired: boolean;
  occupant?: { number: number };
  pending: { kind: string; reason: string } | null;
}

export interface SwarmTask {
  id: string;
  title: string;
  brief: string;
  status: string;
  managerName: string;
  workerNames: string[];
  updatedAt: string;
  data?: Record<string, unknown>;
  // Absent while the Task is open, and on hosts from before resolutions.
  resolution?: string;
  briefUpdatedAt?: string;
}

export interface SwarmActivity {
  id: string;
  taskId: string;
  actorName: string;
  actorKind: string;
  kind: string;
  body: string;
  replyTo: string | null;
  responseProfile: string | null;
  createdAt: string;
  data: Record<string, unknown>;
  refs: unknown[];
}

export interface SwarmBoard {
  tasks?: SwarmTask[];
  activities?: SwarmActivity[];
}

// empty until the seat's first message starts an agent; unknown when Paseo has no record of it.
export type SeatState = "empty" | "unknown" | AgentLifecycleStatus;

export type SeatRoleClass = SwarmSeat["roleClass"];

// Native Paseo tools a seat's agent keeps: work in its workspace, and for managers, choosing what a
// new seat runs and where. Tools that create or drive agents, or schedule prompts, go around the
// seats and the mailbox, so a seat's agent gets none of them, nor any native tool added later.
const SEAT_WORK_TOOLS = new Set([
  "speak",
  "list_workspaces",
  "list_workspace_scripts",
  "start_workspace_script",
  "stop_workspace_script",
  "list_terminals",
  "create_terminal",
  "kill_terminal",
  "capture_terminal",
  "send_terminal_keys",
]);
const SEAT_MANAGER_TOOLS = new Set([
  "create_workspace",
  "archive_workspace",
  "rename_workspace",
  "list_providers",
  "list_models",
  "list_profiles",
  "inspect_provider",
]);

// The role class of the caller's seat, null for an agent that never sat in one, or unresolved
// for a Swarm agent without an active seat: its seat retired or replaced it, or cannot be looked
// up now.
export type SeatAccess = SeatRoleClass | "unresolved" | null;

// An unresolved agent gets a worker's native tools and none of Swarm's, rather than the whole
// native catalog, so leaving a seat never widens what an agent can do.
export async function resolveSeatAccess(input: {
  seatOfCaller: () => Promise<SwarmSeat | undefined>;
  formerSeatOfCaller: () => Promise<SwarmSeat | undefined>;
  callerLabels: () => Promise<Record<string, string> | undefined>;
  onLookupError: (error: unknown, access: SeatAccess) => void;
}): Promise<SeatAccess> {
  try {
    const seat = await input.seatOfCaller();
    if (seat) return seat.roleClass;
    return (await input.formerSeatOfCaller()) ? "unresolved" : null;
  } catch (error) {
    const labels = await input.callerLabels().catch(() => undefined);
    const access = labels?.[SWARM_SEAT_LABEL] ? "unresolved" : null;
    input.onLookupError(error, access);
    return access;
  }
}

/** The role class whose Swarm tools the caller receives, or null when it receives none. */
export function swarmRoleOf(access: SeatAccess): SeatRoleClass | null {
  return access === "unresolved" ? null : access;
}

export function seatToolAllowed(access: SeatAccess, name: string): boolean {
  if (!access) return true;
  if (name.startsWith("swarm_") || name.startsWith("browser_") || SEAT_WORK_TOOLS.has(name)) {
    return true;
  }
  return access !== "worker" && access !== "unresolved" && SEAT_MANAGER_TOOLS.has(name);
}

// Every Swarm list tool returns this shape. total is null where it is unknown, as for transcripts.
export interface SwarmPage<Item> {
  items: Item[];
  total: number | null;
  nextCursor: string | null;
}

// Characters of an Activity body shown in a list; swarm_activity_read has the rest.
export const ACTIVITY_PREVIEW_LIMIT = 600;

// A page of items after the item whose key is cursor.
export function pageSwarmItems<Item>(
  items: Item[],
  key: (item: Item) => string,
  cursor: string | undefined,
  limit: number,
): SwarmPage<Item> {
  const cursorIndex = cursor ? items.findIndex((item) => key(item) === cursor) : -1;
  if (cursor && cursorIndex < 0) throw new Error(`Unknown cursor: ${cursor}`);
  const start = cursorIndex + 1;
  const page = items.slice(start, start + limit);
  return {
    items: page,
    total: items.length,
    nextCursor: start + page.length < items.length ? key(page.at(-1)!) : null,
  };
}

export function seatName(seat: Pick<SwarmSeat, "name" | "qualifiedName">): string {
  return seat.qualifiedName ?? seat.name;
}

// A seat as an agent names it: any seat by its qualified name, or by local name its own reports,
// its teammates, and its manager. A local name never reaches past those.
export function resolveSeat(seats: SwarmSeat[], reference: string, actor: SwarmSeat): SwarmSeat {
  const active = seats.filter((seat) => !seat.retired);
  const named = (qualifiedName: string | null) =>
    qualifiedName ? active.find((seat) => seatName(seat) === qualifiedName) : undefined;
  const manager = named(actor.reportsTo);
  const seat =
    named(reference) ??
    named(`${seatName(actor)}.${reference}`) ??
    named(actor.reportsTo ? `${actor.reportsTo}.${reference}` : null) ??
    (manager?.name === reference ? manager : undefined);
  if (!seat) {
    throw new Error(
      `Unknown Swarm seat: ${reference}. Name your manager, reports, or teammates by local name, and any other seat by its qualified name.`,
    );
  }
  return seat;
}

// Planners see every seat. Anyone else sees their own seat, their manager, and their team: a
// supervisor's team is its reports, and a worker's is its manager's reports.
export function visibleSeats(seats: SwarmSeat[], actor: SwarmSeat): SwarmSeat[] {
  const name = seatName(actor);
  const team = actor.roleClass === "worker" ? (actor.reportsTo ?? name) : name;
  return seats
    .filter(
      (seat) =>
        !seat.retired &&
        (actor.roleClass === "planner" ||
          seatName(seat) === name ||
          seatName(seat) === actor.reportsTo ||
          seatName(seat) === team ||
          seat.reportsTo === team),
    )
    .sort((left, right) => seatName(left).localeCompare(seatName(right)));
}

export function seatSummary(seat: SwarmSeat, state: SeatState) {
  return {
    name: seatName(seat),
    roleClass: seat.roleClass,
    role: seat.role,
    manager: seat.reportsTo,
    state,
    occupant: seat.paseoAgentId === null ? null : (seat.occupant?.number ?? 1),
    pending: seat.pending,
  };
}

export function seatDetail(seat: SwarmSeat, seats: SwarmSeat[], state: SeatState) {
  const name = seatName(seat);
  return {
    ...seatSummary(seat, state),
    reports: seats
      .filter((candidate) => !candidate.retired && candidate.reportsTo === name)
      .map(seatName)
      .sort(),
    workspaceId: seat.workspaceId,
  };
}

// Tasks the actor owns, that seats under it own, or that name it as a worker; for a worker, also
// its manager's Tasks, which are the work it is asked about. Open Tasks only unless includeClosed.
// Most recently updated first.
export function visibleTasks(
  board: SwarmBoard,
  actor: Pick<SwarmSeat, "name" | "qualifiedName" | "roleClass" | "reportsTo">,
  filter: { status?: string; includeClosed?: boolean } = {},
) {
  const actorName = seatName(actor);
  const activities = board.activities ?? [];
  return (board.tasks ?? [])
    .filter(
      (task) =>
        (task.managerName === actorName ||
          task.managerName.startsWith(`${actorName}.`) ||
          task.workerNames.includes(actorName) ||
          (actor.roleClass === "worker" && task.managerName === actor.reportsTo)) &&
        (!filter.status || task.status === filter.status) &&
        (filter.includeClosed || !task.resolution),
    )
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map((task) => {
      const summary: {
        id: string;
        title: string;
        status: string;
        resolution?: string;
        owner: string;
        workerNames: string[];
        updatedAt: string;
        activityCount: number;
      } = {
        id: task.id,
        title: task.title,
        status: task.status,
        owner: task.managerName,
        workerNames: task.workerNames,
        updatedAt: task.updatedAt,
        activityCount: activities.filter((activity) => activity.taskId === task.id).length,
      };
      if (task.resolution) summary.resolution = task.resolution;
      return summary;
    });
}

// Human notes on a Task newer than its brief: instructions its owner has not yet written into it.
export function notesSinceBrief(board: SwarmBoard, task: SwarmTask): string[] {
  const since = task.briefUpdatedAt;
  if (!since) return [];
  return (board.activities ?? [])
    .filter(
      (activity) =>
        activity.taskId === task.id && activity.actorKind === "human" && activity.createdAt > since,
    )
    .map((activity) => activity.id);
}

// A Task's Activities, newest first, with bodies cut to a preview.
export function activityPreviews(board: SwarmBoard, taskId: string) {
  return (board.activities ?? [])
    .filter((activity) => activity.taskId === taskId)
    .toReversed()
    .map((activity) => ({
      id: activity.id,
      actorName: activity.actorName,
      actorKind: activity.actorKind,
      kind: activity.kind,
      replyTo: activity.replyTo,
      responseProfile: activity.responseProfile,
      createdAt: activity.createdAt,
      bodyPreview: activity.body.slice(0, ACTIVITY_PREVIEW_LIMIT),
      truncated: activity.body.length > ACTIVITY_PREVIEW_LIMIT,
    }));
}

// Who a Swarm write reached, as the plugin records it.
export interface SwarmAudienceEntry {
  name: string;
  as: "to" | "cc";
  why: string;
}

type SwarmWrittenTask = SwarmTask & {
  requester?: string;
  audience?: SwarmAudienceEntry[];
};

type SwarmWrittenActivity = Pick<SwarmActivity, "id" | "taskId" | "kind" | "createdAt"> & {
  audience?: SwarmAudienceEntry[];
};

// Write tools answer with a receipt: what the write identified and changed, and who it reached.
// The caller already holds what it sent, so the record is not repeated back.
export function taskReceipt(task: SwarmWrittenTask) {
  return {
    taskId: task.id,
    title: task.title,
    status: task.status,
    resolution: task.resolution ?? null,
    owner: task.managerName,
    ...(task.requester ? { requester: task.requester } : {}),
    briefUpdatedAt: task.briefUpdatedAt ?? null,
    updatedAt: task.updatedAt,
    audience: task.audience ?? [],
  };
}

export function deliveryReceipt(delivery: {
  task: SwarmTask;
  activity: SwarmWrittenActivity;
  duplicate: boolean;
}) {
  return {
    taskId: delivery.task.id,
    activityId: delivery.activity.id,
    duplicate: delivery.duplicate,
    status: delivery.task.status,
    resolution: delivery.task.resolution ?? null,
    createdAt: delivery.activity.createdAt,
    audience: delivery.activity.audience ?? [],
  };
}

export function activityReceipt(activity: SwarmWrittenActivity) {
  return {
    activityId: activity.id,
    taskId: activity.taskId,
    kind: activity.kind,
    createdAt: activity.createdAt,
    audience: activity.audience ?? [],
  };
}

// A Task as agents read it. Stored Task data stays on the record but is not shown to agents: the
// brief holds the agreement, and Activities, deliveries and artifacts hold its history.
export function taskDetail(board: SwarmBoard, task: SwarmTask) {
  const { managerName, data: _data, ...rest } = task;
  return {
    ...rest,
    owner: managerName,
    activityCount: (board.activities ?? []).filter((activity) => activity.taskId === task.id)
      .length,
    notesSinceBrief: notesSinceBrief(board, task),
  };
}

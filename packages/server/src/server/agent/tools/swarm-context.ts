// The Swarm data agent tools read, as the paseo-swarm plugin returns it, and the views the tools
// build from it. Tools name seats, never the Paseo agents in them.

export interface SwarmSeat {
  id: string;
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

export type SeatState = "empty" | "idle" | "running";

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

// Tasks the actor manages, that seats under it manage, or that name it as a worker; most
// recently updated first.
export function visibleTasks(board: SwarmBoard, actorName: string, status?: string) {
  const activities = board.activities ?? [];
  return (board.tasks ?? [])
    .filter(
      (task) =>
        (task.managerName === actorName ||
          task.managerName.startsWith(`${actorName}.`) ||
          task.workerNames.includes(actorName)) &&
        (!status || task.status === status),
    )
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      managerName: task.managerName,
      workerNames: task.workerNames,
      updatedAt: task.updatedAt,
      activityCount: activities.filter((activity) => activity.taskId === task.id).length,
    }));
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

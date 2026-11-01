export interface PlannerRowIdentity {
  // What the row adds after the planner's name; absent when the row needs nothing.
  label?: string;
  // Everything that identifies the row's swarm, for hover and screen readers.
  identity: string;
}

interface SwarmInfo {
  id: string;
  name: string;
  projectId: string | null;
}

// How the planner rows a list displays tell each other apart. Seat names are unique only within a
// swarm, so when the rows come from several swarms, each names its project, then its swarm, then
// the start of the swarm's id, adding each only while rows with the same planner name still read
// the same. Ambiguity counts displayed rows only, so a swarm with no planner on show adds nothing.
export function plannerRowIdentities(
  rows: ReadonlyArray<{ id: string; name: string; swarmId?: string }>,
  swarms: readonly SwarmInfo[],
  projectName: (projectId: string) => string | undefined,
): Map<string, PlannerRowIdentity> {
  const byId = new Map(swarms.map((swarm) => [swarm.id, swarm]));
  const placed = rows.flatMap((row) => {
    const swarm = row.swarmId ? byId.get(row.swarmId) : undefined;
    if (!swarm) return [];
    const project = swarm.projectId ? projectName(swarm.projectId) : undefined;
    const parts = [project, swarm.name, swarm.id.replace(/^swarm-/, "").slice(0, 4)];
    return [{ row, swarm, project, parts }];
  });
  const identities = new Map<string, PlannerRowIdentity>();
  const several = new Set(placed.map(({ swarm }) => swarm.id)).size > 1;
  const key = (entry: (typeof placed)[number], depth: number) =>
    [entry.row.name, ...entry.parts.slice(0, depth)].join("\u0000");
  for (const entry of placed) {
    const { row, swarm, project, parts } = entry;
    const identity = [project, swarm.name, swarm.id].filter(Boolean).join(" · ");
    if (!several) {
      identities.set(row.id, { identity });
      continue;
    }
    // The project is context every row keeps; the swarm name and id come in only as needed.
    let depth = 1;
    const clashes = (at: number) =>
      placed.some((other) => other !== entry && key(other, at) === key(entry, at));
    while (depth < parts.length && clashes(depth)) depth += 1;
    const label = parts
      .slice(0, depth)
      .filter((part): part is string => Boolean(part))
      .join(" · ");
    identities.set(row.id, { identity, ...(label ? { label } : {}) });
  }
  return identities;
}

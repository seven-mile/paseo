// How a list that holds teams from several swarms names each swarm: by its own name, with the
// start of its id when two swarms share a name, so no two labels read the same. A list with one
// swarm needs no labels. Projects play no part: a project can hold several swarms.
export function swarmLabels(
  swarms: ReadonlyArray<{ id: string; name: string }>,
): Map<string, string> {
  const labels = new Map<string, string>();
  if (swarms.length < 2) return labels;
  const named = new Map<string, number>();
  for (const swarm of swarms) named.set(swarm.name, (named.get(swarm.name) ?? 0) + 1);
  for (const swarm of swarms) {
    const short = swarm.id.replace(/^swarm-/, "").slice(0, 4);
    labels.set(swarm.id, named.get(swarm.name)! > 1 ? `${swarm.name} ${short}` : swarm.name);
  }
  return labels;
}

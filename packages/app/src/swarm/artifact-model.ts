import { z } from "zod";

// An artifact is a result a seat maintains and readers come back to. The host keeps a copy of it
// in the swarm's artifacts workspace, so it opens like any file, after the worktree that wrote it
// is gone. location is that copy; link is its paseo-swarm://file link.
const artifactLocationSchema = z.object({
  workspaceId: z.string(),
  path: z.string(),
  link: z.string(),
});

// An artifact a delivery carried, and whether it changed since that delivery.
export const deliveredArtifactSchema = z.object({
  id: z.string(),
  title: z.string(),
  location: artifactLocationSchema.nullable(),
  changed: z.boolean(),
});
export type DeliveredArtifact = z.infer<typeof deliveredArtifactSchema>;

const artifactDeliverySchema = z.object({
  activityId: z.string(),
  taskId: z.string().nullable(),
  actorName: z.string(),
  audience: z.array(z.object({ name: z.string(), as: z.enum(["to", "cc"]), why: z.string() })),
  changed: z.boolean(),
  createdAt: z.string(),
});

const swarmArtifactSchema = z.object({
  id: z.string(),
  title: z.string(),
  authorName: z.string(),
  // The Task it was made for, if any: where it came from, not what it belongs to.
  taskId: z.string().optional(),
  taskTitle: z.string().nullable(),
  changedAt: z.string(),
  publishedAt: z.string(),
  location: artifactLocationSchema.nullable(),
  // Oldest first.
  deliveries: z.array(artifactDeliverySchema),
});
export type SwarmArtifact = z.infer<typeof swarmArtifactSchema>;

export const swarmArtifactsSchema = z.object({ artifacts: z.array(swarmArtifactSchema) });

// The audience name Swarm gives the person.
const HUMAN = "human";

// The newest delivery that carried the artifact to you. "Changed since sent to you" compares with
// it. Null when none did: an artifact has no delivery state of its own, only when it last changed,
// and citing it in conversation is not a delivery.
export function latestDeliveryToYou(
  artifact: Pick<SwarmArtifact, "deliveries">,
): SwarmArtifact["deliveries"][number] | null {
  for (let index = artifact.deliveries.length - 1; index >= 0; index -= 1) {
    const delivery = artifact.deliveries[index];
    if (delivery.audience.some((entry) => entry.name === HUMAN)) return delivery;
  }
  return null;
}

// The artifacts whose title, author or Task title holds the search, in order.
export function filterSwarmArtifacts<
  T extends Pick<SwarmArtifact, "title" | "authorName" | "taskTitle">,
>(artifacts: readonly T[], search: string): readonly T[] {
  const query = search.trim().toLowerCase();
  if (!query) return artifacts;
  return artifacts.filter((artifact) =>
    [artifact.title, artifact.authorName, artifact.taskTitle ?? ""].some((text) =>
      text.toLowerCase().includes(query),
    ),
  );
}

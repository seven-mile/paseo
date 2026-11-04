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

// Everyone its deliveries reached, in the order they first did.
export function artifactReaders(artifact: Pick<SwarmArtifact, "deliveries">): string[] {
  const readers: string[] = [];
  for (const delivery of artifact.deliveries) {
    for (const entry of delivery.audience) {
      if (!readers.includes(entry.name)) readers.push(entry.name);
    }
  }
  return readers;
}

// Whether the artifact changed since its newest delivery; null when it was never delivered.
export function changedSinceLastDelivery(artifact: Pick<SwarmArtifact, "deliveries">) {
  const latest = artifact.deliveries.at(-1);
  return latest ? latest.changed : null;
}

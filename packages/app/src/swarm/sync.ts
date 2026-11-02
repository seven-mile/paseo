import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { z } from "zod";

// Swarm surfaces poll conditional reads (`swarm.roster.read`, `swarm.tasks.read`,
// `swarm.task.read`): each poll sends the etag of what this client holds, and the host answers
// with data null while that is still current. An idle surface costs a few hundred bytes per poll
// instead of the records it shows.
export const SWARM_POLL_MS = 3000;
// A Task's read returns its latest Activities a page at a time; the plugin caps the window.
export const SWARM_TASK_ACTIVITY_PAGE = 100;
export const SWARM_TASK_ACTIVITY_MAX = 1000;

export interface SwarmRevisioned<T> {
  etag: string;
  value: T;
}

export function swarmConditionalQuery<T>(input: {
  queryClient: QueryClient | undefined;
  queryKey: QueryKey;
  schema: z.ZodType<T>;
  read: (etag: string | undefined) => Promise<unknown>;
}): () => Promise<SwarmRevisioned<T>> {
  const responseSchema = z.object({ etag: z.string(), data: input.schema.nullable() });
  return async () => {
    const previous = input.queryClient?.getQueryData<SwarmRevisioned<T>>(input.queryKey);
    const response = responseSchema.parse(await input.read(previous?.etag));
    if (response.data !== null) return { etag: response.etag, value: response.data };
    // Returning the held object keeps every selector and memo downstream unchanged.
    if (previous?.etag === response.etag) return previous;
    throw new Error("Swarm answered with no data for records this client does not hold");
  };
}

// A read made without an etag always carries its data.
export function parseSwarmRead<T>(schema: z.ZodType<T>, response: unknown): T {
  return z.object({ etag: z.string(), data: schema }).parse(response).data;
}

export function selectSwarmValue<T>(revisioned: SwarmRevisioned<T>): T {
  return revisioned.value;
}

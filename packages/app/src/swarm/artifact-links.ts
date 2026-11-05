import type { QueryClient } from "@tanstack/react-query";
import { artifactCopyLink, swarmArtifactsSchema } from "./artifact-model";
import { parseSwarmRead } from "./sync";

// A link to a published artifact's source file, or to one of its attachments, as a link to that
// file in the artifact's copy, which stays after the author's worktree is gone. Every place that
// opens Swarm links goes through this first, so the same link opens the same file from a reply, a
// seat's results and a Task's result. Null for any other link, and on hosts from before artifacts.
export async function resolveArtifactCopyLink(
  host: {
    serverId: string;
    invoke: (method: string, input: unknown) => Promise<unknown>;
    queryClient: QueryClient | undefined;
  },
  uri: string,
): Promise<string | null> {
  if (!/^paseo-swarm:\/\/file\//i.test(uri)) return null;
  const read = async () =>
    parseSwarmRead(swarmArtifactsSchema, await host.invoke("swarm.artifacts.read", {}));
  try {
    const { artifacts } = host.queryClient
      ? await host.queryClient.fetchQuery({
          queryKey: ["swarm", "artifact-copy-links", host.serverId],
          queryFn: read,
          staleTime: 0,
          retry: false,
        })
      : await read();
    return artifactCopyLink(artifacts, uri);
  } catch {
    return null;
  }
}

import { describe, expect, it } from "vitest";
import { resolveArtifactCopyLink } from "./artifact-links";

const artifact = {
  id: "auth-review",
  title: "Auth review",
  authorName: "planner.lead",
  taskId: "auth",
  taskTitle: "Review auth",
  changedAt: "2026-11-04T00:00:00Z",
  publishedAt: "2026-11-04T00:00:00Z",
  source: { workspaceId: "lead-worktree", path: "reports/auth.md", attachments: [] },
  location: {
    workspaceId: "artifacts",
    path: "auth-review/reports/auth.md",
    link: "paseo-swarm://file/artifacts/auth-review/reports/auth.md",
  },
  deliveries: [],
};

function host(read: () => Promise<unknown>) {
  const calls: string[] = [];
  return {
    calls,
    host: {
      serverId: "server",
      queryClient: undefined,
      invoke: async (method: string) => {
        calls.push(method);
        return read();
      },
    },
  };
}

describe("resolveArtifactCopyLink", () => {
  it("reads the artifacts and opens the copy of a source file, whether or not its workspace exists", async () => {
    const { host: h } = host(async () => ({ etag: "1", data: { artifacts: [artifact] } }));
    await expect(
      resolveArtifactCopyLink(h, "paseo-swarm://file/lead-worktree/reports/auth.md"),
    ).resolves.toBe("paseo-swarm://file/artifacts/auth-review/reports/auth.md");
  });

  it("asks nothing for links that are not files", async () => {
    const { host: h, calls } = host(async () => ({ etag: "1", data: { artifacts: [artifact] } }));
    await expect(resolveArtifactCopyLink(h, "paseo-swarm://task/auth")).resolves.toBeNull();
    expect(calls).toEqual([]);
  });

  it("leaves the link alone on a host without artifacts", async () => {
    const { host: h } = host(async () => {
      throw new Error("unknown method swarm.artifacts.read");
    });
    await expect(
      resolveArtifactCopyLink(h, "paseo-swarm://file/lead-worktree/reports/auth.md"),
    ).resolves.toBeNull();
  });
});

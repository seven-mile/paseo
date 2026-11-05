import { describe, expect, it } from "vitest";
import {
  artifactCopyLink,
  filterSwarmArtifacts,
  latestDeliveryToYou,
  type SwarmArtifact,
} from "./artifact-model";

const delivery = (
  activityId: string,
  names: string[],
  changed: boolean,
): SwarmArtifact["deliveries"][number] => ({
  activityId,
  taskId: "auth",
  actorName: "planner.lead",
  audience: names.map((name) => ({ name, as: "to", why: "named" })),
  changed,
  createdAt: "2026-11-04T00:00:00Z",
});

describe("the latest delivery to you", () => {
  it("is the newest delivery that reached the person, whoever else it reached", () => {
    const toYou = delivery("a", ["planner", "human"], true);
    expect(latestDeliveryToYou({ deliveries: [toYou, delivery("b", ["planner"], false)] })).toBe(
      toYou,
    );
  });

  it("is null when no delivery reached the person", () => {
    expect(latestDeliveryToYou({ deliveries: [] })).toBeNull();
    expect(latestDeliveryToYou({ deliveries: [delivery("a", ["planner"], true)] })).toBeNull();
  });
});

describe("artifact search", () => {
  const artifacts = [
    { title: "Checkout latency review", authorName: "planner.lead", taskTitle: null },
    { title: "Cache options", authorName: "planner.ops", taskTitle: "Profile cart cold start" },
  ];

  it("matches the title, the author and the Task title, ignoring case", () => {
    expect(filterSwarmArtifacts(artifacts, "LATENCY").map((a) => a.title)).toEqual([
      "Checkout latency review",
    ]);
    expect(filterSwarmArtifacts(artifacts, "ops").map((a) => a.title)).toEqual(["Cache options"]);
    expect(filterSwarmArtifacts(artifacts, "cold start").map((a) => a.title)).toEqual([
      "Cache options",
    ]);
    expect(filterSwarmArtifacts(artifacts, "  ")).toBe(artifacts);
  });
});

describe("artifact copy links", () => {
  const artifacts = [
    {
      id: "auth-review",
      source: {
        workspaceId: "lead-worktree",
        path: "reports/auth.md",
        attachments: ["reports/data"],
      },
      location: {
        workspaceId: "artifacts",
        path: "auth-review/reports/auth.md",
        link: "paseo-swarm://file/artifacts/auth-review/reports/auth.md",
      },
    },
  ];

  it("opens the copy of an artifact's file or attachment", () => {
    expect(artifactCopyLink(artifacts, "paseo-swarm://file/lead-worktree/reports/auth.md")).toBe(
      "paseo-swarm://file/artifacts/auth-review/reports/auth.md",
    );
    expect(
      artifactCopyLink(artifacts, "paseo-swarm://file/lead-worktree/reports%2Fdata/users.csv"),
    ).toBe("paseo-swarm://file/artifacts/auth-review/reports/data/users.csv");
  });

  it("leaves other files, workspaces and links alone", () => {
    expect(
      artifactCopyLink(artifacts, "paseo-swarm://file/lead-worktree/reports/notes.md"),
    ).toBeNull();
    expect(
      artifactCopyLink(artifacts, "paseo-swarm://file/lead-worktree/reports/database.md"),
    ).toBeNull();
    expect(artifactCopyLink(artifacts, "paseo-swarm://file/other/reports/auth.md")).toBeNull();
    expect(artifactCopyLink(artifacts, "paseo-swarm://task/auth")).toBeNull();
    expect(
      artifactCopyLink(artifacts, "paseo-swarm://file/artifacts/auth-review/reports/auth.md"),
    ).toBeNull();
  });
});

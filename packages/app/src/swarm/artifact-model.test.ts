import { describe, expect, it } from "vitest";
import { filterSwarmArtifacts, latestDeliveryToYou, type SwarmArtifact } from "./artifact-model";

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

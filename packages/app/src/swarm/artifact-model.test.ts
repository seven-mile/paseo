import { describe, expect, it } from "vitest";
import { artifactReaders, changedSinceLastDelivery, type SwarmArtifact } from "./artifact-model";

const delivery = (
  activityId: string,
  names: string[],
  changed: boolean,
): SwarmArtifact["deliveries"][number] => ({
  activityId,
  taskId: null,
  actorName: "planner.lead",
  audience: names.map((name) => ({ name, as: "to", why: "named" })),
  changed,
  createdAt: "2026-11-04T00:00:00Z",
});

describe("artifact readers", () => {
  it("lists everyone its deliveries reached once, in the order they first did", () => {
    expect(
      artifactReaders({
        deliveries: [
          delivery("a", ["human", "planner"], true),
          delivery("b", ["planner", "ops"], false),
        ],
      }),
    ).toEqual(["human", "planner", "ops"]);
  });

  it("compares the artifact with its newest delivery, and has no answer before one", () => {
    expect(changedSinceLastDelivery({ deliveries: [] })).toBeNull();
    expect(
      changedSinceLastDelivery({
        deliveries: [delivery("a", ["human"], true), delivery("b", ["human"], false)],
      }),
    ).toBe(false);
    expect(changedSinceLastDelivery({ deliveries: [delivery("a", ["human"], true)] })).toBe(true);
  });
});

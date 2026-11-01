import { describe, expect, it } from "vitest";
import { swarmLabels } from "./swarm-labels";

describe("swarmLabels", () => {
  it("labels nothing when the list holds one swarm", () => {
    expect(swarmLabels([{ id: "swarm-a1b2c3", name: "pr-workflow" }]).size).toBe(0);
  });

  it("names each swarm, and adds the start of its id when names clash", () => {
    const labels = swarmLabels([
      { id: "swarm-a1b2c3", name: "pr-workflow" },
      { id: "swarm-d4e5f6", name: "pr-workflow" },
      { id: "swarm-0718aa", name: "review" },
    ]);
    expect([...labels.values()]).toEqual(["pr-workflow a1b2", "pr-workflow d4e5", "review"]);
  });
});

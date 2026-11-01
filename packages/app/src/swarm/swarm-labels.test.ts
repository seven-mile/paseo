import { describe, expect, it } from "vitest";
import { plannerRowIdentities } from "./swarm-labels";

const projects: Record<string, string> = { alpha: "paseo", beta: "website" };
const projectName = (projectId: string) => projects[projectId];
const labels = (
  rows: Array<{ id: string; name: string; swarmId?: string }>,
  swarms: Array<{ id: string; name: string; projectId: string | null }>,
) =>
  Object.fromEntries(
    [...plannerRowIdentities(rows, swarms, projectName)].map(([id, row]) => [id, row.label]),
  );

describe("plannerRowIdentities", () => {
  it("adds nothing when the displayed rows come from one swarm", () => {
    const identities = plannerRowIdentities(
      [{ id: "p", name: "planner", swarmId: "swarm-a1b2c3" }],
      [
        { id: "swarm-a1b2c3", name: "pr-workflow", projectId: "alpha" },
        // A swarm with no displayed planner does not count.
        { id: "swarm-d4e5f6", name: "pr-workflow", projectId: "alpha" },
      ],
      projectName,
    );
    expect(identities.get("p")).toEqual({ identity: "paseo · pr-workflow · swarm-a1b2c3" });
  });

  it("keeps the project, then adds the swarm name and id only while rows still read the same", () => {
    const swarms = [
      { id: "swarm-a1b2c3", name: "pr-workflow", projectId: "alpha" },
      { id: "swarm-d4e5f6", name: "review", projectId: "alpha" },
      { id: "swarm-0718aa", name: "pr-workflow", projectId: "beta" },
      { id: "swarm-99ffee", name: "review", projectId: "alpha" },
    ];
    expect(
      labels(
        [
          { id: "pr", name: "planner", swarmId: "swarm-a1b2c3" },
          { id: "web", name: "planner", swarmId: "swarm-0718aa" },
          { id: "review", name: "planner", swarmId: "swarm-d4e5f6" },
          { id: "review-2", name: "planner", swarmId: "swarm-99ffee" },
          { id: "triage", name: "triage", swarmId: "swarm-d4e5f6" },
        ],
        swarms,
      ),
    ).toEqual({
      pr: "paseo · pr-workflow",
      web: "website",
      review: "paseo · review · d4e5",
      "review-2": "paseo · review · 99ff",
      triage: "paseo",
    });
  });

  it("starts from the swarm name when the project is unknown here", () => {
    expect(
      labels(
        [
          { id: "one", name: "planner", swarmId: "swarm-a1b2c3" },
          { id: "two", name: "planner", swarmId: "swarm-d4e5f6" },
        ],
        [
          { id: "swarm-a1b2c3", name: "pr-workflow", projectId: "gone" },
          { id: "swarm-d4e5f6", name: "review", projectId: null },
        ],
      ),
    ).toEqual({ one: "pr-workflow", two: "review" });
  });
});

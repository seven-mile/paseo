import { realpathSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createOutputOptions, render } from "../../output/index.js";
import {
  directoryScope,
  planLines,
  seatHistorySchema,
  type RosterPlan,
  type SeatHistory,
} from "./index.js";

const history: SeatHistory = {
  seat: "lead.dev",
  occupant: 1,
  paseoAgentId: "old-agent",
  entries: [{ type: "assistant_message", text: "Step 3" }],
  nextBefore: '{"epoch":"e","seq":3}',
};

describe("swarm seat history output", () => {
  it("keeps the whole page, cursor included, in JSON", () => {
    const output = render(
      { type: "single", data: history, schema: seatHistorySchema },
      createOutputOptions({ format: "json" }),
    );
    expect(JSON.parse(output)).toEqual(history);
  });

  it("shows the entries and the next cursor in a table", () => {
    const output = render(
      { type: "single", data: history, schema: seatHistorySchema },
      createOutputOptions({ format: "table", noColor: true }),
    );
    expect(output).toContain("Step 3");
    expect(output).toContain(`Older entries: --before '${history.nextBefore}'`);
  });
});

describe("swarm diff output", () => {
  it("shows each change with what it costs", () => {
    const plan: RosterPlan = {
      reserve: [{ seat: "lead.qa", role: "tester" }],
      restore: [],
      update: [{ seat: "lead", changes: ["provider claude/opus → codex/gpt-6"] }],
      retire: [{ seat: "lead.dev", tasks: ["build"], queuedMessages: 2 }],
      name: { from: "pr-workflow", to: "review" },
      source: { files: ["roles/tester.md"], prompts: ["lead"] },
      refusals: [],
    };
    expect(planLines(plan)).toEqual([
      "name: pr-workflow → review",
      "+ lead.qa (tester), starts on first mail",
      "~ lead: provider claude/opus → codex/gpt-6",
      "- lead.dev retires (named by Tasks build; 2 queued messages fail)",
      "PWA: roles/tester.md",
      "  new standing prompt at next mail for lead",
    ]);
  });
});

describe("swarm directory scope", () => {
  const local = { kind: "instance", home: "/home/me/.paseo" } as const;
  const remote = { kind: "endpoint", host: "ws://build-box:6767" } as const;

  it("sends the working directory to a local instance when nothing names the swarm", () => {
    expect(directoryScope({ daemonTarget: local })).toEqual({ cwd: realpathSync(process.cwd()) });
  });

  it("lets --project and --swarm name the swarm instead", () => {
    expect(directoryScope({ daemonTarget: local, project: "p" })).toEqual({ projectId: "p" });
    expect(directoryScope({ daemonTarget: local, swarm: "swarm-1" })).toEqual({});
  });

  // The same path on another machine can be an unrelated checkout.
  it("never sends the working directory to a remote daemon", () => {
    expect(directoryScope({ daemonTarget: remote })).toEqual({});
  });
});

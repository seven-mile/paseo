import { describe, expect, it } from "vitest";
import { createOutputOptions, render } from "../../output/index.js";
import { seatHistorySchema, type SeatHistory } from "./index.js";

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

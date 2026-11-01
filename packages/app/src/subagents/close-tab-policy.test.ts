import { describe, expect, it } from "vitest";
import { resolveCloseAgentTabPolicy } from "./close-tab-policy";

describe("resolveCloseAgentTabPolicy", () => {
  it("archives root agents when their tab closes", () => {
    expect(resolveCloseAgentTabPolicy({ parentAgentId: null })).toEqual({
      kind: "archive-on-close",
    });
  });

  it("keeps subagent tab close layout-only", () => {
    expect(resolveCloseAgentTabPolicy({ parentAgentId: "parent-agent" })).toEqual({
      kind: "layout-only",
    });
  });

  it("keeps tab close layout-only for a root agent whose manager declares it", () => {
    expect(
      resolveCloseAgentTabPolicy({
        parentAgentId: null,
        labels: { "paseo.tab-close": "layout-only" },
      }),
    ).toEqual({ kind: "layout-only" });
    expect(
      resolveCloseAgentTabPolicy({ parentAgentId: null, labels: { "paseo.tab-close": "archive" } }),
    ).toEqual({ kind: "archive-on-close" });
  });

  it("preserves the existing archive fallback when the agent is missing", () => {
    expect(resolveCloseAgentTabPolicy(null)).toEqual({ kind: "archive-on-close" });
    expect(resolveCloseAgentTabPolicy(undefined)).toEqual({ kind: "archive-on-close" });
  });
});

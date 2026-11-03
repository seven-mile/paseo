import { describe, expect, it } from "vitest";
import { resolveMarkdownFileLink } from "./links";

const root = "/home/me/repo";
const resolve = (href: string, documentPath = "docs/guide/intro.md") =>
  resolveMarkdownFileLink({ href, documentPath, workspaceRoot: root });

describe("resolveMarkdownFileLink", () => {
  it("resolves a relative link against the document's directory", () => {
    expect(resolve("setup.md")).toEqual({ path: "docs/guide/setup.md" });
    expect(resolve("./img/a%20b.png")).toEqual({ path: "docs/guide/img/a b.png" });
    expect(resolve("../../src/main.ts")).toEqual({ path: "src/main.ts" });
    expect(resolve("setup.md", `${root}/docs/guide/intro.md`)).toEqual({
      path: "docs/guide/setup.md",
    });
  });
  it("keeps a line fragment and drops other fragments and queries", () => {
    expect(resolve("../../src/main.ts#L10-L20")).toEqual({
      path: "src/main.ts",
      lineStart: 10,
      lineEnd: 20,
    });
    expect(resolve("setup.md#install")).toEqual({ path: "docs/guide/setup.md" });
    expect(resolve("setup.md?plain=1")).toEqual({ path: "docs/guide/setup.md" });
  });
  it("leaves anchors, URLs, and root-relative links to the renderer", () => {
    for (const href of [
      "#install",
      "https://paseo.sh",
      "mailto:me@example.com",
      "paseo-swarm://task/fix-login",
      "/docs/setup.md",
      "//example.com/a",
      "",
    ]) {
      expect(resolve(href)).toBeNull();
    }
  });
  it("never resolves outside the workspace", () => {
    expect(resolve("../../../outside.md")).toBeNull();
    expect(resolve("setup.md", "/elsewhere/notes.md")).toBeNull();
  });
});

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import os from "node:os";
import { describe, expect, test } from "vitest";

import { resolvePaseoHome } from "./paseo-home.js";
describe("resolvePaseoHome", () => {
  test("uses the independent fork home without an environment override", () => {
    expect(resolvePaseoHome({})).toBe(path.join(os.homedir(), ".paseo-swarm"));
    expect(resolvePaseoHome({ PASEO_HOME: "~/.paseo" })).toBe(path.join(os.homedir(), ".paseo"));
  });

  test("resolves PASEO_HOME without creating it", () => {
    const parent = mkdtempSync(path.join(tmpdir(), "paseo-home-parent-"));
    const paseoHome = path.join(parent, "home");
    try {
      expect(resolvePaseoHome({ PASEO_HOME: paseoHome })).toBe(paseoHome);
      expect(existsSync(paseoHome)).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});

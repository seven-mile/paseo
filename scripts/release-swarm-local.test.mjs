import assert from "node:assert/strict";
import path from "node:path";
import { test } from "vitest";
import { localReleasePlan } from "./release-swarm-local.mjs";

test("confines generated release files to the checkout", () => {
  const plan = localReleasePlan([]);
  const checkout = path.resolve(import.meta.dirname, "..");
  assert.equal(plan.records, path.join(checkout, ".dev", "swarm-releases"));
  assert.equal(
    plan.artifact,
    path.join(
      checkout,
      "packages",
      "desktop",
      "release",
      "local",
      process.arch === "arm64" ? "mac-arm64" : "mac",
      "Paseo Swarm.app",
    ),
  );
});

test("rejects removed installation modes and unknown options", () => {
  for (const option of ["--install", "--install-only", "--unknown"]) {
    assert.throws(() => localReleasePlan([option]), /Install the generated DMG manually/);
  }
});

import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DaemonVersionResolutionError, resolveDaemonVersion } from "./daemon-version.js";

const createdDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "paseo-daemon-version-"));
  createdDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of createdDirs.splice(0, createdDirs.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveDaemonVersion", () => {
  it("resolves the nearest exact identity without accepting a parent version", () => {
    const root = createTempDir();
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: "@getpaseo/server", version: "1.0.0" }),
    );
    const fork = path.join(root, "fork");
    const nested = path.join(fork, "dist", "server");
    mkdirSync(nested, { recursive: true });
    const manifest = path.join(fork, "package.json");
    writeFileSync(manifest, JSON.stringify({ name: "@paseo-swarm/server", version: "2.0.0" }));
    const moduleUrl = pathToFileURL(path.join(nested, "index.js")).href;
    expect(resolveDaemonVersion(moduleUrl)).toBe("2.0.0");
    writeFileSync(manifest, JSON.stringify({ name: "@paseo-swarm/server" }));
    expect(() => resolveDaemonVersion(moduleUrl)).toThrow(DaemonVersionResolutionError);
  });

  it.each(["@getpaseo/server", "@paseo-swarm/server"])(
    "resolves version from the exact server identity %s",
    (name) => {
      const root = createTempDir();
      writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({ name, version: "9.8.7" }),
        "utf8",
      );
      const nestedDir = path.join(root, "dist", "server");
      mkdirSync(nestedDir, { recursive: true });

      const moduleUrl = pathToFileURL(path.join(nestedDir, "index.js")).href;
      expect(resolveDaemonVersion(moduleUrl)).toBe("9.8.7");
    },
  );

  it.each(["not-getpaseo-server", "@paseo-swarm/not-server", "@other-owner/server"])(
    "rejects unrelated package identity %s",
    (name) => {
      const root = createTempDir();
      writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({ name, version: "1.2.3" }),
        "utf8",
      );
      const nestedDir = path.join(root, "dist", "server");
      mkdirSync(nestedDir, { recursive: true });

      const moduleUrl = pathToFileURL(path.join(nestedDir, "index.js")).href;
      expect(() => resolveDaemonVersion(moduleUrl)).toThrow(DaemonVersionResolutionError);
    },
  );

  it.each(["@getpaseo/server", "@paseo-swarm/server"])(
    "throws when the exact server %s version is missing",
    (name) => {
      const root = createTempDir();
      writeFileSync(path.join(root, "package.json"), JSON.stringify({ name }), "utf8");
      const nestedDir = path.join(root, "dist", "server");
      mkdirSync(nestedDir, { recursive: true });

      const moduleUrl = pathToFileURL(path.join(nestedDir, "index.js")).href;
      expect(() => resolveDaemonVersion(moduleUrl)).toThrow(DaemonVersionResolutionError);
    },
  );
});

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { app } = vi.hoisted(() => ({
  app: {
    isPackaged: false,
    getPath: vi.fn(() => "/test/Application Support"),
    setPath: vi.fn(),
  },
}));
vi.mock("electron", () => ({ app }));
import {
  configureSwarmRuntime,
  ensureSwarmDaemonConfig,
  initializeSwarmRuntime,
} from "./swarm-runtime";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  app.isPackaged = false;
});

describe("standalone Swarm isolation", () => {
  it("defaults to separate Swarm state and disables upstream updates", () => {
    app.isPackaged = true;
    vi.stubEnv("PASEO_HOME", undefined);
    vi.stubEnv("PASEO_LISTEN", undefined);
    vi.stubEnv("PASEO_ELECTRON_USER_DATA_DIR", undefined);
    vi.stubEnv("PASEO_DISABLE_APP_UPDATES", undefined);
    configureSwarmRuntime();
    expect(process.env.PASEO_HOME).toBe(path.join(os.homedir(), ".paseo-swarm"));
    expect(process.env.PASEO_LISTEN).toBe("127.0.0.1:6769");
    expect(app.setPath).toHaveBeenCalledWith(
      "userData",
      path.join("/test/Application Support", "Paseo Swarm"),
    );
    expect(process.env.PASEO_DISABLE_APP_UPDATES).toBe("1");
  });

  it("honors existing Paseo overrides for paths and port", () => {
    app.isPackaged = true;
    vi.stubEnv("PASEO_HOME", "/qa/state");
    vi.stubEnv("PASEO_LISTEN", "127.0.0.1:16769");
    vi.stubEnv("PASEO_ELECTRON_USER_DATA_DIR", "/qa/client");
    vi.stubEnv("PASEO_DISABLE_APP_UPDATES", undefined);
    configureSwarmRuntime();
    expect(process.env.PASEO_HOME).toBe("/qa/state");
    expect(process.env.PASEO_LISTEN).toBe("127.0.0.1:16769");
    expect(app.setPath).toHaveBeenCalledWith("userData", "/qa/client");
  });

  it("keeps checkout-specific development state", () => {
    vi.stubEnv("PASEO_HOME", "/checkout/.dev/state");
    configureSwarmRuntime();
    expect(process.env.PASEO_HOME).toBe("/checkout/.dev/state");
    expect(app.setPath).not.toHaveBeenCalled();
  });
});

describe("managed Swarm daemon config", () => {
  it("does not treat the runtime default as an explicit endpoint override", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "swarm-config-"));
    const file = path.join(home, "config.json");
    try {
      app.isPackaged = true;
      vi.stubEnv("PASEO_HOME", home);
      vi.stubEnv("PASEO_LISTEN", undefined);
      vi.stubEnv("PASEO_ELECTRON_USER_DATA_DIR", "/qa/client");
      writeFileSync(file, JSON.stringify({ version: 1, daemon: { listen: "127.0.0.1:17777" } }));
      initializeSwarmRuntime();
      expect(JSON.parse(readFileSync(file, "utf8")).daemon.listen).toBe("127.0.0.1:17777");
      vi.stubEnv("PASEO_LISTEN", "127.0.0.1:18888");
      initializeSwarmRuntime();
      expect(JSON.parse(readFileSync(file, "utf8")).daemon.listen).toBe("127.0.0.1:18888");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
  it("defaults a new home to 6769 and preserves a configured endpoint unless overridden", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "swarm-config-"));
    const file = path.join(home, "config.json");
    try {
      ensureSwarmDaemonConfig(home);
      expect(JSON.parse(readFileSync(file, "utf8")).daemon.listen).toBe("127.0.0.1:6769");
      writeFileSync(file, JSON.stringify({ version: 1, daemon: { listen: "127.0.0.1:6767" } }));
      ensureSwarmDaemonConfig(home);
      expect(JSON.parse(readFileSync(file, "utf8")).daemon.listen).toBe("127.0.0.1:6767");
      ensureSwarmDaemonConfig(home, "127.0.0.1:17777");
      expect(JSON.parse(readFileSync(file, "utf8")).daemon.listen).toBe("127.0.0.1:17777");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
  it("persists a separate port and keeps unrelated settings", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "swarm-config-"));
    try {
      writeFileSync(
        path.join(home, "config.json"),
        JSON.stringify({ version: 1, daemon: { listen: "127.0.0.1:6767" }, marker: "kept" }),
      );
      ensureSwarmDaemonConfig(home, "127.0.0.1:6769");
      expect(JSON.parse(readFileSync(path.join(home, "config.json"), "utf8"))).toEqual({
        version: 1,
        daemon: { listen: "127.0.0.1:6769" },
        marker: "kept",
      });
      ensureSwarmDaemonConfig(home, "127.0.0.1:6769");
      expect(JSON.parse(readFileSync(path.join(home, "config.json"), "utf8")).daemon).toEqual({
        listen: "127.0.0.1:6769",
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

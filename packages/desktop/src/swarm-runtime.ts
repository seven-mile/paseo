import { app } from "electron";
import os from "node:os";
import path from "node:path";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";

// Packaged launches use Swarm defaults while honoring the existing Paseo overrides.
export function configureSwarmRuntime(): void {
  if (!app.isPackaged) return;
  process.env.PASEO_HOME ||= path.join(os.homedir(), ".paseo-swarm");
  process.env.PASEO_LISTEN ||= "127.0.0.1:6769";
  process.env.PASEO_ELECTRON_USER_DATA_DIR ||= path.join(app.getPath("appData"), "Paseo Swarm");
  process.env.PASEO_DISABLE_APP_UPDATES = "1";
  app.setPath("userData", process.env.PASEO_ELECTRON_USER_DATA_DIR);
}

// Managed daemon launches read the persistent config, not PASEO_LISTEN.
export function ensureSwarmDaemonConfig(home: string, listenOverride?: string): void {
  const file = path.join(home, "config.json");
  const config = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { version: 1 };
  if (config.daemon?.listen && !listenOverride) return;
  config.daemon = { ...config.daemon, listen: listenOverride || "127.0.0.1:6769" };
  mkdirSync(home, { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  renameSync(temporary, file);
}

export function initializeSwarmRuntime(): void {
  const listenOverride = process.env.PASEO_LISTEN;
  configureSwarmRuntime();
  if (app.isPackaged) {
    ensureSwarmDaemonConfig(process.env.PASEO_HOME!, listenOverride);
  }
}

initializeSwarmRuntime();

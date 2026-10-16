export type DaemonSelfUpdatePhase = "starting" | "downloading" | "installing" | "complete";

export interface DaemonSelfUpdateResult {
  success: boolean;
  error: string | null;
  newVersion: string | null;
}

export interface DaemonSelfUpdateInput {
  daemonVersion: string | null;
  desktopManaged: boolean;
  onProgress: (phase: DaemonSelfUpdatePhase) => void;
  logger: DaemonSelfUpdateLogger;
}

export interface DaemonSelfUpdateLogger {
  error(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
}

export class DaemonSelfUpdateInProgressError extends Error {
  constructor() {
    super("An update is already in progress");
    this.name = "DaemonSelfUpdateInProgressError";
  }
}

export class DaemonSelfUpdater {
  async update(_input: DaemonSelfUpdateInput): Promise<DaemonSelfUpdateResult> {
    return {
      success: false,
      error:
        "Automatic updates are unavailable. Install a specific @paseo-swarm/cli version with npm.",
      newVersion: null,
    };
  }
}

export const daemonSelfUpdater = new DaemonSelfUpdater();

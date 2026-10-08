import { describe, expect, test, vi } from "vitest";
import { DaemonSelfUpdater } from "./daemon-self-updater.js";
import { npmGlobalPaseoCli } from "./npm-global-cli.js";
import { daemonInstallOriginRuntime } from "./install-origin.js";

describe("DaemonSelfUpdater fork policy", () => {
  test.each([false, true])(
    "refuses self-update before npm, origin probes or progress (desktopManaged=%s)",
    async (desktopManaged) => {
      const inspect = vi.spyOn(npmGlobalPaseoCli, "inspect").mockImplementation(async () => {
        throw new Error("Unexpected npm inspection");
      });
      const installLatest = vi
        .spyOn(npmGlobalPaseoCli, "installLatest")
        .mockImplementation(async () => {
          throw new Error("Unexpected npm install");
        });
      const resolveCurrentServerPackageRoot = vi
        .spyOn(daemonInstallOriginRuntime, "resolveCurrentServerPackageRoot")
        .mockImplementation(() => {
          throw new Error("Unexpected install-origin probe");
        });
      const onProgress = vi.fn();
      try {
        const result = await new DaemonSelfUpdater().update({
          daemonVersion: "0.11.0-beta.4",
          desktopManaged,
          onProgress,
          logger: { error: vi.fn(), warn: vi.fn() },
        });
        expect(result).toEqual({
          success: false,
          error:
            "Automatic updates are unavailable. Install a specific @paseo-swarm/cli version with npm.",
          newVersion: null,
        });
        expect(inspect).not.toHaveBeenCalled();
        expect(installLatest).not.toHaveBeenCalled();
        expect(resolveCurrentServerPackageRoot).not.toHaveBeenCalled();
        expect(onProgress).not.toHaveBeenCalled();
      } finally {
        inspect.mockRestore();
        installLatest.mockRestore();
        resolveCurrentServerPackageRoot.mockRestore();
      }
    },
  );
});

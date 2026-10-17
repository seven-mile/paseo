import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installCliTarget, isOwnedCliTarget, resolveCliInstallSourcePath } from "./path";

describe("cli-install-path", () => {
  it("uses the bundled shim for packaged macOS installs", () => {
    expect(
      resolveCliInstallSourcePath({
        platform: "darwin",
        isPackaged: true,
        executablePath: "/Applications/Paseo.app/Contents/MacOS/Paseo",
        shimPath: "/Applications/Paseo.app/Contents/Resources/bin/paseo",
      }),
    ).toBe("/Applications/Paseo.app/Contents/Resources/bin/paseo");
  });

  it("prefers the original AppImage path on linux", () => {
    expect(
      resolveCliInstallSourcePath({
        platform: "linux",
        isPackaged: true,
        executablePath: "/tmp/.mount_paseo123/paseo",
        shimPath: "/tmp/.mount_paseo123/resources/bin/paseo",
        appImagePath: "/home/user/Applications/Paseo.AppImage",
      }),
    ).toBe("/home/user/Applications/Paseo.AppImage");
  });

  it("uses the bundled shim for packaged linux installs outside an AppImage", () => {
    expect(
      resolveCliInstallSourcePath({
        platform: "linux",
        isPackaged: true,
        executablePath: "/opt/Paseo/Paseo",
        shimPath: "/opt/Paseo/resources/bin/paseo",
      }),
    ).toBe("/opt/Paseo/resources/bin/paseo");
  });

  it("falls back to the shim on windows and in development", () => {
    expect(
      resolveCliInstallSourcePath({
        platform: "win32",
        isPackaged: true,
        executablePath: "C:\\Users\\user\\AppData\\Local\\Programs\\Paseo\\Paseo.exe",
        shimPath: "C:\\Users\\user\\AppData\\Local\\Programs\\Paseo\\resources\\bin\\paseo.cmd",
      }),
    ).toBe("C:\\Users\\user\\AppData\\Local\\Programs\\Paseo\\resources\\bin\\paseo.cmd");

    expect(
      resolveCliInstallSourcePath({
        platform: "linux",
        isPackaged: false,
        executablePath: "/opt/Paseo/paseo",
        shimPath: "/opt/Paseo/resources/bin/paseo",
      }),
    ).toBe("/opt/Paseo/resources/bin/paseo");
  });
});

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("CLI entry ownership", () => {
  it.each(process.platform === "win32" ? (["win32"] as const) : (["linux", "win32"] as const))(
    "installs idempotently and rejects foreign entries on %s",
    async (platform) => {
      const root = await mkdtemp(join(tmpdir(), "swarm-cli-install-"));
      roots.push(root);
      const target = join(root, "paseo-swarm");
      const source = join(root, "desktop-shim");
      expect(await isOwnedCliTarget(target, source, platform)).toBe(false);
      await installCliTarget(target, source, platform);
      await installCliTarget(target, source, platform);
      expect(await isOwnedCliTarget(target, source, platform)).toBe(true);
      await rm(target);
      await writeFile(target, "npm-owned");
      expect(await isOwnedCliTarget(target, source, platform)).toBe(false);
      await expect(installCliTarget(target, source, platform)).rejects.toThrow(
        "Refusing to replace",
      );
      expect(await readFile(target, "utf8")).toBe("npm-owned");
    },
  );

  it.skipIf(process.platform === "win32")("preserves foreign and dangling npm links", async () => {
    const root = await mkdtemp(join(tmpdir(), "swarm-cli-links-"));
    roots.push(root);
    const target = join(root, "paseo-swarm");
    const foreign = join(root, "missing-npm-bin");
    await symlink(foreign, target);
    expect(await isOwnedCliTarget(target, join(root, "desktop-shim"), "linux")).toBe(false);
    await expect(installCliTarget(target, join(root, "desktop-shim"), "linux")).rejects.toThrow(
      "Refusing to replace",
    );
    expect(await readlink(target)).toBe(foreign);
  });
});

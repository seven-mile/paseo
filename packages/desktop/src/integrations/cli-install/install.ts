import { promises as fs } from "node:fs";
import { app } from "electron";
import log from "electron-log/main";
import { installCliTarget, isOwnedCliTarget, resolveCliInstallSourcePath } from "./path.js";
import { getBundledCliShimPath, getCliTargetPath, getLocalBinDir } from "./paths.js";
import { ensurePathInShellRc } from "./shell-rc.js";

interface InstallStatus {
  installed: boolean;
}

function resolveInstallSource(): string {
  return resolveCliInstallSourcePath({
    platform: process.platform,
    isPackaged: app.isPackaged,
    executablePath: app.getPath("exe"),
    shimPath: getBundledCliShimPath(),
    appImagePath: process.env.APPIMAGE,
  });
}

export async function installCli(): Promise<InstallStatus> {
  const targetPath = getCliTargetPath();
  const sourcePath = resolveInstallSource();
  await fs.mkdir(getLocalBinDir(), { recursive: true });
  await installCliTarget(targetPath, sourcePath, process.platform);

  const { shellUpdated } = await ensurePathInShellRc();
  if (shellUpdated) {
    log.info("[integrations] Updated shell rc with ~/.local/bin PATH");
  }

  return getCliInstallStatus();
}

/**
 * Removes the CLI only when the file at the target is the one this app installs, so a `paseo-swarm` the
 * user put there some other way survives. The shell rc PATH line stays: it is harmless and other
 * tools in ~/.local/bin rely on it.
 */
export async function uninstallCli(): Promise<InstallStatus> {
  const targetPath = getCliTargetPath();
  if (await isOwnInstall(targetPath)) {
    await fs.unlink(targetPath);
  } else if (await pathOrSymlinkExists(targetPath)) {
    log.warn("[integrations] Left a paseo-swarm CLI this app did not install", { targetPath });
  }
  return getCliInstallStatus();
}

async function pathOrSymlinkExists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
}

async function isOwnInstall(targetPath: string): Promise<boolean> {
  return isOwnedCliTarget(targetPath, resolveInstallSource(), process.platform);
}

export async function getCliInstallStatus(): Promise<InstallStatus> {
  const targetPath = getCliTargetPath();
  return {
    installed: await isOwnedCliTarget(targetPath, resolveInstallSource(), process.platform),
  };
}

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

export async function getCliInstallStatus(): Promise<InstallStatus> {
  const targetPath = getCliTargetPath();
  return {
    installed: await isOwnedCliTarget(targetPath, resolveInstallSource(), process.platform),
  };
}

import { promises as fs } from "node:fs";
import path from "node:path";

export function resolveCliInstallSourcePath(input: {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  executablePath: string;
  shimPath: string;
  appImagePath?: string | null;
}): string {
  if (input.platform === "win32") {
    return input.shimPath;
  }

  if (!input.isPackaged) {
    return input.shimPath;
  }

  if (input.platform === "darwin") {
    return input.shimPath;
  }

  if (input.platform === "linux") {
    const appImagePath = input.appImagePath?.trim();
    if (appImagePath) {
      return appImagePath;
    }
    return input.shimPath;
  }

  return input.executablePath;
}

function windowsCliTrampoline(shimPath: string): string {
  return [
    "@echo off",
    `set "BUNDLED_CLI=${shimPath}"`,
    `if not exist "%BUNDLED_CLI%" (`,
    `  echo Paseo CLI not found at %BUNDLED_CLI% — is Paseo installed? 1>&2`,
    `  exit /b 1`,
    `)`,
    `call "%BUNDLED_CLI%" %*`,
    `exit /b %errorlevel%`,
  ].join("\r\n");
}

export async function isOwnedCliTarget(
  targetPath: string,
  sourcePath: string,
  platform: NodeJS.Platform,
): Promise<boolean> {
  try {
    const stat = await fs.lstat(targetPath);
    if (platform === "win32") {
      return (
        stat.isFile() &&
        (await fs.readFile(targetPath, "utf8")) === windowsCliTrampoline(sourcePath)
      );
    }
    return (
      stat.isSymbolicLink() &&
      path.resolve(path.dirname(targetPath), await fs.readlink(targetPath)) ===
        path.resolve(sourcePath)
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function installCliTarget(
  targetPath: string,
  sourcePath: string,
  platform: NodeJS.Platform,
): Promise<void> {
  if (await isOwnedCliTarget(targetPath, sourcePath, platform)) return;
  // Exclusive creation preserves foreign entries, including dangling links and concurrent installs.
  try {
    if (platform === "win32") {
      await fs.writeFile(targetPath, windowsCliTrampoline(sourcePath), {
        encoding: "utf8",
        flag: "wx",
      });
    } else {
      await fs.symlink(sourcePath, targetPath);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`Refusing to replace an existing CLI entry at ${targetPath}`, {
        cause: error,
      });
    }
    throw error;
  }
}

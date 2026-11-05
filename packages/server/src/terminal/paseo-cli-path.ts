import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

// Where the Paseo CLI lives, for the PATH entry and PASEO_HOOK_CLI every terminal gets. Kept
// apart from terminal.ts so the daemon can resolve it without loading node-pty.

const require = createRequire(import.meta.url);
const PASEO_CLI_BIN_ENTRY = "@paseo-swarm/cli/bin/paseo";

export function resolveExternalProcessPath(filePath: string): string {
  return filePath.replace(/\.asar(?=[/\\]|$)/, ".asar.unpacked");
}

export function resolvePaseoCliBinDir(): string | null {
  const cliExecutable = resolvePaseoCliExecutablePath();
  return cliExecutable ? dirname(cliExecutable) : null;
}

export function resolvePaseoCliExecutablePath(): string | null {
  const configuredCli = process.env.PASEO_CLI?.trim();
  if (configuredCli) {
    return resolvePath(configuredCli);
  }

  const cliEntrypoint = resolvePaseoCliBinEntrypoint();
  if (!cliEntrypoint) {
    return null;
  }

  const externalCliEntrypoint = resolveExternalProcessPath(cliEntrypoint);
  const npmBinDir = findNpmBinDir(externalCliEntrypoint);
  if (npmBinDir) {
    const shim = resolvePaseoCliShim(npmBinDir, externalCliEntrypoint);
    if (shim) {
      return shim;
    }
  }

  return externalCliEntrypoint;
}

function resolvePaseoCliBinEntrypoint(): string | null {
  try {
    return require.resolve(PASEO_CLI_BIN_ENTRY);
  } catch {
    return resolveWorkspaceCliBin();
  }
}

export function resolveWorkspaceCliBin(moduleUrl: string = import.meta.url): string | null {
  let current = dirname(fileURLToPath(moduleUrl));
  while (dirname(current) !== current) {
    try {
      const manifest = JSON.parse(readFileSync(join(current, "package.json"), "utf8"));
      if (manifest.name === "@getpaseo/server") {
        const root = resolvePath(current, "../..");
        const workspace = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
        const cliDir = join(root, "packages", "cli");
        const cli = JSON.parse(readFileSync(join(cliDir, "package.json"), "utf8"));
        return workspace.workspaces?.includes("packages/cli") && cli.name === "@getpaseo/cli"
          ? join(cliDir, "bin", "paseo")
          : null;
      }
    } catch {
      // Continue through source/dist directories without a package manifest.
    }
    current = dirname(current);
  }
  return null;
}

function findNpmBinDir(cliEntrypoint: string): string | null {
  let current = dirname(cliEntrypoint);
  while (true) {
    for (const candidate of [join(current, "node_modules", ".bin"), current]) {
      if (resolvePaseoCliShim(candidate, cliEntrypoint)) return candidate;
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function resolvePaseoCliShim(
  binDir: string,
  cliEntrypoint: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const names = platform === "win32" ? ["paseo-swarm.cmd", "paseo.cmd"] : ["paseo-swarm", "paseo"];
  for (const name of names) {
    const candidate = join(binDir, name);
    try {
      if (platform === "win32") {
        const target = relative(binDir, cliEntrypoint).replaceAll("\\", "/").toLowerCase();
        const content = readFileSync(candidate, "utf8").replaceAll("\\", "/").toLowerCase();
        if (content.includes(`"%dp0%/${target}"`)) return candidate;
      } else if (realpathSync(candidate) === realpathSync(cliEntrypoint)) {
        return candidate;
      }
    } catch {
      // Ignore shims for a different or removed installation.
    }
  }
  return null;
}
